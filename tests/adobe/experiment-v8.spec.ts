import fs from 'node:fs';
import path from 'node:path';
import { test, expect, Locator, Page, TestInfo } from '@playwright/test';
import { AdobePage } from '../../src/pages/adobe';
import { GmailProvider } from '../../src/pages/gmailProvider';
import { MsProvider } from '../../src/pages/msProvider';
import { EditorDashboard } from '../../src/pages/editorDashboard';
import { parseCsv } from '../../src/adobe/csv';
import { loadFreshAdobeAccounts, resolveAdobeAccountSource } from '../../src/adobe/accounts';
import { getReportsDir } from '../../src/adobe/runtime';
import type { AdobeAccount } from '../../src/adobe/types';

// ════════════════════════════════════════════════════════════════
//  EXPERIMENT v8 — DOWNLOAD-STEP PROBE
//
//  Why this exists: script.spec.ts re-enabled the 'Download' step, which calls
//  AdobePage.download_img(). That method is bound to the AdobePage's own `page`
//  — the ORIGINAL login/dashboard tab — but since e0194a8 the design opens in a
//  SECOND tab (postcardPage). The 2026-08-18 run shows both symptoms of that:
//    • getByLabel('Download').first() → "element(s) not found" after 120s
//    • page.waitForEvent('download') → "Target page/context has been closed"
//  It also still uses the Firefly-era 'Selected image' radio, which the template
//  editor's download panel almost certainly does not have.
//
//  This spec does NOT try to pass. It reproduces the flow verbatim, then records
//  evidence: which tab actually hosts the Download control, and what the download
//  panel really contains — so the refactor can be written against real markup.
//
//  Run it:
//    npx playwright test tests/adobe/experiment-v8.spec.ts --project=adobe-chromium --workers=1 --trace on --reporter=line
//
//  Keep --reporter=line: it replaces the config's reporter list, so AdobeCsvReporter
//  never runs and this probe cannot append a row to the results dumps it mines. (Even
//  without it the consumed ledger is safe — the reporter only writes there when an
//  account attachment is present, and this spec deliberately never attaches one — but
//  you would get a stray empty-email results row.)
//
//  V8_MODE=verify skips the raw probing and instead calls the production method the
//  probe's findings produced — EditorDashboard.downloadDesign() — at exactly the point
//  script.spec.ts calls it, regression-checking the real code path.
//
//  Account selection (all optional):
//    V8_SOURCE        — 'fresh' (default) takes a not-yet-consumed account via
//                       loadFreshAdobeAccounts() from src/adobe/accounts.ts, the same
//                       loader the real suite uses. 'failed' instead mines
//                       reports/adobe_results_*.csv for an email that only ever failed
//                       (see pickFailedAccount) — useful when a specific past failure
//                       needs reproducing, but those accounts are already consumed.
//    V8_ACCOUNT_EMAIL — exact email to use (must exist in the account source CSV)
//    V8_ACCOUNT_INDEX — which account in the resolved pool to take; default 0
//    V8_FAIL_STEP     — V8_SOURCE=failed only: regex matched against failed_at_step;
//                       default 'download'
//
//  NOTE: 'fresh' does NOT mark the account consumed here, because --reporter=line keeps
//  AdobeCsvReporter out of the run (see above). The account stays in the fresh pool, so
//  a later real run can still pick it up — re-running this probe repeatedly will keep
//  handing you the same row unless you pass V8_ACCOUNT_INDEX.
// ════════════════════════════════════════════════════════════════

const VERIFY_MODE = process.env.V8_MODE?.trim().toLowerCase() === 'verify';
const ACCOUNT_SOURCE = process.env.V8_SOURCE?.trim().toLowerCase() === 'failed' ? 'failed' : 'fresh';

const FIXED_POSTCARD_URL = 'https://new.express.adobe.com/design/template/urn:aaid:sc:VA6C2:f2c97bf0-1039-5b0d-be7a-528c0060757b?category=text&entryPoint=template&taskID=postcard';

// Everything the probe records goes here (gitignored) so it survives the run and
// can be read/grepped afterwards — testInfo attachments get hashed filenames.
const PROBE_DIR = path.join(getReportsDir(), 'v8-probe');

const TARGET = ACCOUNT_SOURCE === 'failed' ? pickFailedAccount() : pickFreshAccount();

test('experiment v8 — probe the Download step (which tab? what dialog?)', async ({ page }, testInfo) => {
  test.skip(!TARGET.account, TARGET.skipReason ?? 'No account available to probe.');
  const account = TARGET.account!;

  // Stamped first so the share→publish retry can tell how much of testInfo.timeout
  // is left before it commits to another attempt (mirrors script.spec.ts).
  const testStartedAt = Date.now();

  fs.mkdirSync(PROBE_DIR, { recursive: true });

  console.log('\n' + '='.repeat(78));
  console.log('🔬  EXPERIMENT v8 — DOWNLOAD PROBE');
  console.log(`👤  Account: ${account.email}   (source: ${ACCOUNT_SOURCE}${TARGET.failedSteps.length ? `, previously failed at: ${TARGET.failedSteps.join(' | ')}` : ''})`);
  console.log(`📁  Probe dumps: ${PROBE_DIR}`);
  console.log('='.repeat(78));

  const adobe = new AdobePage(page);
  const ms = new MsProvider(page);
  const ggl = new GmailProvider(page);
  let editor: EditorDashboard;

  // ── Step runner ──────────────────────────────────────────────
  // `hard` steps re-throw (the flow can't continue without them). `soft` steps —
  // every probe — log and continue, because the whole point is to reach the
  // download panel and dump it even if individual observations fail.
  const timings: { step: string; ms: number; status: 'ok' | 'FAIL' }[] = [];
  let stepIndex = 0;

  async function step<T>(name: string, fn: () => Promise<T>, mode: 'hard' | 'soft' = 'hard'): Promise<T | undefined> {
    stepIndex += 1;
    const label = `${String(stepIndex).padStart(2, '0')}. ${name}`;
    const start = Date.now();
    console.log(`\n⏱️  [START] ${label}`);
    try {
      const result = await fn();
      timings.push({ step: label, ms: Date.now() - start, status: 'ok' });
      console.log(`✅ [END]   ${label} — ${Date.now() - start} ms`);
      return result;
    } catch (err: any) {
      timings.push({ step: label, ms: Date.now() - start, status: 'FAIL' });
      console.log(`❌ [${mode === 'soft' ? 'SOFT-FAIL' : 'FAIL'}] ${label} — ${firstLine(err)}`);
      if (mode === 'hard') {
        await dumpPage('FAIL-' + label, page, testInfo);
        throw err;
      }
      return undefined;
    }
  }

  attachDiagnostics('login-tab', page);

  adobe.startUdsCapture();

  // ── Reproduce script.spec.ts verbatim ────────────────────────
  await step('Open Adobe Login', () => adobe.adb_login());
  await step('Enter Email', () => adobe.fill_adb_email_field(account.email));
  await step('Handle Personal/Company Screen', () => adobe.select_cmp_option());

  const provider = await step('Detect Login Provider', async () => {
    const p = await adobe.getLoginProvider();
    console.log(`   🔎 Provider: ${p.slice(0, 80)}`);
    return p;
  });

  await step('Login via Provider', async () => {
    if (provider!.includes('accounts.google.com')) {
      await ggl.g_login(account.email, account.password);
    } else if (provider!.includes('login.microsoftonline.com')) {
      await ms.ms_login(account.email, account.password);
    } else {
      throw new Error(`Unexpected provider: ${provider}`);
    }
  });

  await step('Wait for Adobe Dashboard', () => adobe.waitForDashboard());
  await step('Skip Lets Go via API', () => adobe.skipLetsGoViaAPI(account.email));

  const postcardPage = (await step('Navigate to Fixed Postcard (NEW TAB)', async () => {
    await page.waitForTimeout(1200);
    const p = await page.context().newPage();
    attachDiagnostics('editor-tab', p);
    await p.goto(FIXED_POSTCARD_URL, { waitUntil: 'load' });
    console.log(`   🗂️  Context now has ${page.context().pages().length} page(s)`);
    return p;
  }))!;

  editor = new EditorDashboard(postcardPage);

  await step('Skip Tutorial dialog if visible', () => editor.skipTutorial());

  await step('Share → Publish (with retry)', () => editor.sharePublishWithRetry({
    onStep: (s) => console.log(`   ↪ ${s}`),
    budgetLeftMs: () => testInfo.timeout - (Date.now() - testStartedAt),
  }));

  const link = await step('Click Copy Link', async () => {
    const l = await editor.clickCopyLink();
    console.log(`   🔗 ${l}`);
    return l;
  });
  expect(link).toBeTruthy();

  // ════════════════════════════════════════════════════════════
  //  VERIFY MODE — exercise the production method, not the probe
  // ════════════════════════════════════════════════════════════
  if (VERIFY_MODE) {
    const filePath = await step('VERIFY: editor.downloadDesign() (the production Download step)', async () => {
      const p = await editor.downloadDesign(testInfo.workerIndex);
      const size = fs.statSync(p).size;
      console.log(`   ✅ ${p} (${size} bytes)`);
      expect(size).toBeGreaterThan(0);
      return p;
    });
    expect(filePath).toBeTruthy();
    printSummary();
    return;
  }

  // ════════════════════════════════════════════════════════════
  //  PROBE 1 — WHICH TAB HOSTS THE DOWNLOAD CONTROL?
  //  This is the hypothesis under test: download_img() looks on `page`,
  //  but the design is on `postcardPage`.
  // ════════════════════════════════════════════════════════════
  await step('PROBE: Download controls on the LOGIN/DASHBOARD tab (what download_img sees)',
    () => probeDownloadControls('login-tab', page), 'soft');

  await step('PROBE: Download controls on the EDITOR tab (where the design actually is)',
    () => probeDownloadControls('editor-tab', postcardPage), 'soft');

  // Reproduce download_img()'s very first assertion on the wrong tab, but with a
  // 5s budget instead of the config's 120s — we only need the verdict, not the wait.
  await step('PROBE: reproduce download_img()\'s locator on the LOGIN tab (expect: not found)', async () => {
    const wrongTab = page.getByLabel('Download').first();
    const count = await page.getByLabel('Download').count();
    console.log(`   🔍 login-tab getByLabel('Download') count = ${count}`);
    await wrongTab.waitFor({ state: 'visible', timeout: 5_000 });
    console.log('   ⚠️  UNEXPECTED: the login tab DOES expose a Download control');
  }, 'soft');

  // ════════════════════════════════════════════════════════════
  //  PROBE 2 — CLOSE THE SHARE PANEL, THEN OPEN THE DOWNLOAD PANEL
  // ════════════════════════════════════════════════════════════
  // Run 1 finding: after clickCopyLink the "Share file" panel is still open, and it
  // is a real modal <dialog> — which makes the rest of the page INERT. #download-btn
  // is visible and enabled in the top nav, but the click never lands (15s timeout)
  // because pointer events can't reach an inert element. So dismiss the panel first.
  await step('PROBE: close the Share/Publish panel (it is a modal <dialog> and blocks the nav)', async () => {
    const dialog = postcardPage.locator('dialog');
    console.log(`   🪟 dialog count before = ${await dialog.count()}`);
    for (const attempt of ['Escape', 'close-button', 'Escape-again'] as const) {
      if (attempt === 'close-button') {
        await postcardPage.getByRole('dialog').getByRole('button', { name: /close/i }).first()
          .click({ timeout: 5_000 }).catch((err) => console.log(`   ✗ close button: ${firstLine(err)}`));
      } else {
        await postcardPage.keyboard.press('Escape').catch(() => { /* nothing focused */ });
      }
      await postcardPage.waitForTimeout(1000);
      const stillOpen = await dialog.filter({ visible: true }).count();
      console.log(`   🪟 after ${attempt}: visible dialog count = ${stillOpen}`);
      if (stillOpen === 0) return;
    }
    console.log('   ⚠️  Share panel still open — the download click will likely be blocked again');
  }, 'soft');

  // Armed BEFORE the click: some editor variants start the download immediately
  // with no confirm dialog, and a promise created after the fact would miss it.
  const downloadPromise = postcardPage.waitForEvent('download', { timeout: 120_000 })
    .catch((err) => { console.log(`   📥 no download event: ${firstLine(err)}`); return null; });

  await step('PROBE: click the editor\'s Download entry point', async () => {
    // Run 1 finding: the download button has NO accessible name — getByLabel('Download')
    // and getByRole('button', {name:/download/i}) both return 0 on the editor tab. It is
    // <sp-button id="download-btn" data-testid="editor-download-button"> inside a SHADOW
    // ROOT (absent from page.content()), so a testid/id locator is the only way in.
    const used = await clickFirstAvailable(postcardPage, [
      ['[data-testid="editor-download-button"]', postcardPage.locator('[data-testid="editor-download-button"]')],
      ['#download-btn', postcardPage.locator('#download-btn')],
      ['role=button name=/download/i', postcardPage.getByRole('button', { name: /download/i })],
      ['getByLabel("Download")', postcardPage.getByLabel('Download')],
    ]);
    console.log(`   🖱️  Clicked via: ${used ?? 'NOTHING MATCHED'}`);
    if (!used) throw new Error('No download entry point found on the editor tab');
    return used;
  }, 'soft');

  await step('PROBE: dump the download panel/dialog', async () => {
    // Give the panel a beat to mount, then record everything actionable inside it.
    await postcardPage.waitForTimeout(2500);
    await dumpPage('download-panel', postcardPage, testInfo);
    await describeInteractiveControls('download-panel', postcardPage);
  }, 'soft');

  await step('PROBE: look for a format/quality picker + final confirm', async () => {
    // The old flow clicked getByText('Selected image') — a Firefly artifact. Record
    // what this panel actually offers instead.
    for (const [name, locator] of [
      ['legacy: getByText("Selected image")', postcardPage.getByText('Selected image')],
      ['radios', postcardPage.getByRole('radio')],
      ['checkboxes', postcardPage.getByRole('checkbox')],
      ['comboboxes', postcardPage.getByRole('combobox')],
      ['PNG option', postcardPage.getByText('PNG', { exact: true })],
      ['JPEG option', postcardPage.getByText(/^JPE?G$/i)],
      ['PDF option', postcardPage.getByText('PDF', { exact: true })],
      ['dialog buttons', postcardPage.getByRole('dialog').getByRole('button')],
      ['[data-testid*=download]', postcardPage.locator('[data-testid*="download" i]')],
      ['[data-testid*=format]', postcardPage.locator('[data-testid*="format" i]')],
      ['[data-testid*=export]', postcardPage.locator('[data-testid*="export" i]')],
      ['[data-testid*=filetype]', postcardPage.locator('[data-testid*="filetype" i]')],
      ['sp-picker / sp-menu-item', postcardPage.locator('sp-picker, sp-menu-item')],
    ] as [string, Locator][]) {
      const count = await locator.count().catch(() => -1);
      console.log(`   • ${name.padEnd(38)} count=${count}`);
      if (count > 0) await logMatches(locator, Math.min(count, 8));
    }
  }, 'soft');

  await step('PROBE: click the final Download confirm (last labelled Download in the panel)', async () => {
    const used = await clickFirstAvailable(postcardPage, [
      ['dialog > button "Download"', postcardPage.getByRole('dialog').getByRole('button', { name: /download/i }).last()],
      ['[data-testid*=download] (last)', postcardPage.locator('[data-testid*="download" i]').last()],
      ['getByText("Download").last()', postcardPage.getByText('Download').last()],
      ['role=button name=/^download$/i .last()', postcardPage.getByRole('button', { name: /^download$/i }).last()],
    ]);
    console.log(`   🖱️  Confirm clicked via: ${used ?? 'NOTHING MATCHED (download may already be running)'}`);
  }, 'soft');

  await step('PROBE: wait for the download event on the EDITOR tab', async () => {
    const download = await downloadPromise;
    if (!download) {
      console.log('   ❌ No download fired. Panel dump above is the evidence.');
      await dumpPage('no-download-final-state', postcardPage, testInfo);
      return;
    }
    fs.mkdirSync('./downloads', { recursive: true });
    const filePath = `./downloads/v8-probe-${download.suggestedFilename()}`;
    await download.saveAs(filePath);
    const size = fs.statSync(filePath).size;
    console.log(`   ✅ DOWNLOAD OK → ${filePath} (${size} bytes)`);
    fs.writeFileSync(path.join(PROBE_DIR, 'download-result.txt'),
      `suggestedFilename: ${download.suggestedFilename()}\nsavedTo: ${filePath}\nbytes: ${size}\nurl: ${download.url()}\n`, 'utf8');
  }, 'soft');

  // Snapshot the editor tab's full accessibility tree regardless of outcome — the
  // download control's real name/role has to be in here somewhere.
  await step('PROBE: final aria snapshot of the editor tab', () => dumpPage('editor-final', postcardPage, testInfo), 'soft');

  printSummary();

  // ════════════════════════════════════════════════════════════
  //  Helpers closed over `timings` / the probe dir
  // ════════════════════════════════════════════════════════════
  function printSummary(): void {
    console.log('\n' + '='.repeat(78));
    console.log(`📊  v8 ${VERIFY_MODE ? 'VERIFY' : 'PROBE'} SUMMARY`);
    console.log('='.repeat(78));
    for (const t of timings) {
      console.log(`  ${t.status === 'ok' ? '✅' : '❌'} ${t.step.padEnd(62)} ${String(t.ms).padStart(8)} ms`);
    }
    console.log(`\n📁  Dumps written to: ${PROBE_DIR}`);
  }

  async function probeDownloadControls(tag: string, target: Page): Promise<void> {
    console.log(`   🌐 [${tag}] url = ${safeUrl(target)}`);
    console.log(`   📰 [${tag}] title = ${await target.title().catch(() => '(unavailable)')}`);

    const probes: [string, Locator][] = [
      ["getByLabel('Download')", target.getByLabel('Download')],
      ['role=button name=/download/i', target.getByRole('button', { name: /download/i })],
      ['role=menuitem name=/download/i', target.getByRole('menuitem', { name: /download/i })],
      ['#download-btn', target.locator('#download-btn')],
      ['[id*=download]', target.locator('[id*="download" i]')],
      ['[data-testid*=download]', target.locator('[data-testid*="download" i]')],
      ['[aria-label*=download]', target.locator('[aria-label*="download" i]')],
      ['#share-btn (editor toolbar marker)', target.locator('#share-btn')],
    ];

    const lines: string[] = [`# ${tag}`, `url: ${safeUrl(target)}`, ''];
    for (const [name, locator] of probes) {
      const count = await locator.count().catch(() => -1);
      console.log(`   • ${name.padEnd(38)} count=${count}`);
      lines.push(`${name} => ${count}`);
      if (count > 0) lines.push(...(await logMatches(locator, Math.min(count, 6))));
    }
    fs.writeFileSync(path.join(PROBE_DIR, `probe-${tag}.txt`), lines.join('\n'), 'utf8');
  }

  /** Log tag/id/label/text/state for the first `limit` matches; returns the same lines. */
  async function logMatches(locator: Locator, limit: number): Promise<string[]> {
    const lines: string[] = [];
    for (let i = 0; i < limit; i += 1) {
      const nth = locator.nth(i);
      try {
        const info = await nth.evaluate((el) => ({
          tag: el.tagName.toLowerCase(),
          id: (el as HTMLElement).id || '',
          label: el.getAttribute('aria-label') || '',
          testid: el.getAttribute('data-testid') || '',
          role: el.getAttribute('role') || '',
          disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
          text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70),
        }));
        const visible = await nth.isVisible().catch(() => false);
        const line = `      [${i}] <${info.tag}${info.id ? ` id="${info.id}"` : ''}${info.testid ? ` data-testid="${info.testid}"` : ''}${info.role ? ` role="${info.role}"` : ''}> aria-label="${info.label}" text="${info.text}" visible=${visible} disabled=${info.disabled}`;
        console.log(line);
        lines.push(line);
      } catch (err: any) {
        lines.push(`      [${i}] <unreadable: ${firstLine(err)}>`);
      }
    }
    return lines;
  }

  /** Enumerate every actionable control on the page — the panel's real vocabulary. */
  async function describeInteractiveControls(tag: string, target: Page): Promise<void> {
    const lines: string[] = [`# interactive controls — ${tag}`, `url: ${safeUrl(target)}`, ''];
    for (const role of ['dialog', 'button', 'radio', 'radiogroup', 'checkbox', 'combobox', 'tab', 'menuitem', 'switch'] as const) {
      const locator = target.getByRole(role);
      const count = await locator.count().catch(() => -1);
      lines.push(`role=${role} => ${count}`);
      console.log(`   • role=${role.padEnd(12)} count=${count}`);
      if (count > 0) lines.push(...(await logMatches(locator, Math.min(count, 25))));
      lines.push('');
    }
    fs.writeFileSync(path.join(PROBE_DIR, `controls-${tag}.txt`), lines.join('\n'), 'utf8');
  }

  /** Try each candidate in order; click the first visible one. Returns its name. */
  async function clickFirstAvailable(target: Page, candidates: [string, Locator][]): Promise<string | null> {
    for (const [name, locator] of candidates) {
      const count = await locator.count().catch(() => 0);
      if (count === 0) { console.log(`   ✗ ${name} — not present`); continue; }
      const first = locator.first();
      if (!(await first.isVisible().catch(() => false))) { console.log(`   ✗ ${name} — present (${count}) but not visible`); continue; }
      try {
        await first.click({ timeout: 15_000 });
        return name;
      } catch (err: any) {
        // Full message, not firstLine: Playwright's actionability log (lines 2+) is the
        // only place that says WHY a visible+enabled element refused the click —
        // "intercepts pointer events", "element is inert", "not stable", etc.
        console.log(`   ✗ ${name} — click failed:\n${indent(err?.message ?? String(err))}`);
      }
    }
    return null;
  }
});

// ════════════════════════════════════════════════════════════════
//  Account selection — mine the results dumps for FAILED emails
// ════════════════════════════════════════════════════════════════

type AccountPick = {
  // The probe opens its own fixed postcard, so it needs no region.
  account?: Pick<AdobeAccount, 'email' | 'password'>;
  failedSteps: string[];
  skipReason?: string;
};

/**
 * Default source: a not-yet-consumed account straight from loadFreshAdobeAccounts() —
 * the same loader src/adobe/spec.ts uses to declare the real suite. Prefer this whenever
 * the goal is "run the flow", because it reads the configured account source (accounts.csv
 * / ADOBE_ACCOUNTS_CSV / env) and subtracts the consumed ledger, so it can only ever hand
 * back a row that is safe to sign in with.
 */
function pickFreshAccount(): AccountPick {
  try {
    const { accounts, source, skipReason } = loadFreshAdobeAccounts();
    const wanted = process.env.V8_ACCOUNT_EMAIL?.trim().toLowerCase();

    if (wanted) {
      const match = accounts.find((candidate) => candidate.email === wanted);
      if (!match) {
        // Most often this means the account is already in the consumed ledger, so the
        // fresh loader filtered it out — say so rather than just "not found".
        return {
          failedSteps: [],
          skipReason: `V8_ACCOUNT_EMAIL "${wanted}" is not in the fresh pool from ${source.description} (already consumed?). Use V8_SOURCE=failed to target a consumed account.`,
        };
      }
      console.log(`🎯  v8 account: fresh pool from ${source.description} — targeting ${wanted}`);
      return { account: match, failedSteps: [] };
    }

    if (accounts.length === 0) {
      return { failedSteps: [], skipReason: skipReason ?? 'No fresh Adobe account available.' };
    }

    const index = Number(process.env.V8_ACCOUNT_INDEX ?? 0);
    const account = accounts[index] ?? accounts[0];
    console.log(`🎯  v8 account: fresh pool from ${source.description} — ${accounts.length} available, taking index ${index}`);
    return { account, failedSteps: [] };
  } catch (err: any) {
    return { failedSteps: [], skipReason: `Fresh account selection errored: ${firstLine(err)}` };
  }
}

/**
 * The fresh-account loader deliberately excludes anything in the consumed ledger,
 * so it can never hand back an account that already failed. For a probe that's
 * backwards: an account that reached 'Download' has finished onboarding and gets
 * there again fast, which makes it the cheapest reproducer. So read the results
 * dumps directly, keep emails that only ever failed, and re-join passwords from
 * the configured account source.
 */
function pickFailedAccount(): AccountPick {
  try {
    const reportsDir = getReportsDir();
    if (!fs.existsSync(reportsDir)) {
      return { failedSteps: [], skipReason: `No reports dir at ${reportsDir} — nothing to mine for failed accounts.` };
    }

    const stats = new Map<string, { failed: number; passed: number; steps: Set<string> }>();
    for (const file of fs.readdirSync(reportsDir).filter((f) => f.startsWith('adobe_results') && f.endsWith('.csv'))) {
      const rows = parseCsv(fs.readFileSync(path.join(reportsDir, file), 'utf8'));
      if (rows.length < 2) continue;
      const header = rows[0].map((h) => h.trim().toLowerCase());
      const iEmail = header.indexOf('email');
      const iStatus = header.indexOf('test_status');
      const iStep = header.indexOf('failed_at_step');
      if (iEmail < 0 || iStatus < 0) continue;

      for (const row of rows.slice(1)) {
        const email = (row[iEmail] ?? '').trim().toLowerCase();
        if (!email) continue;
        const entry = stats.get(email) ?? { failed: 0, passed: 0, steps: new Set<string>() };
        if ((row[iStatus] ?? '').trim() === 'failed') {
          entry.failed += 1;
          const step = (row[iStep] ?? '').trim();
          if (step) entry.steps.add(step);
        } else {
          entry.passed += 1;
        }
        stats.set(email, entry);
      }
    }

    // Passwords come from whatever source the suite is configured against.
    const source = resolveAdobeAccountSource();
    const passwords = new Map<string, string>();
    if (source.kind === 'csv') {
      const rows = parseCsv(fs.readFileSync(source.path, 'utf8'));
      const header = rows[0].map((h) => h.trim().toLowerCase());
      const iEmail = header.indexOf('email');
      const iPass = header.indexOf('password');
      for (const row of rows.slice(1)) {
        const email = (row[iEmail] ?? '').trim().toLowerCase();
        const password = (row[iPass] ?? '').trim();
        if (email && password && !passwords.has(email)) passwords.set(email, password);
      }
    } else if (process.env.ADOBE_EMAIL && process.env.ADOBE_PASSWORD) {
      passwords.set(process.env.ADOBE_EMAIL.trim().toLowerCase(), process.env.ADOBE_PASSWORD.trim());
    }

    // Explicit override wins — no filtering, no "did it fail?" requirement.
    const wanted = process.env.V8_ACCOUNT_EMAIL?.trim().toLowerCase();
    if (wanted) {
      const password = passwords.get(wanted);
      if (!password) return { failedSteps: [], skipReason: `V8_ACCOUNT_EMAIL "${wanted}" has no password in ${source.description}.` };
      return { account: { email: wanted, password }, failedSteps: [...(stats.get(wanted)?.steps ?? [])] };
    }

    // Never-passed accounts only: one that already succeeded has consumed its
    // free-trial state and is a poor reproducer.
    const failedOnly = [...stats.entries()]
      .filter(([email, s]) => s.failed > 0 && s.passed === 0 && passwords.has(email));

    const stepPattern = new RegExp(process.env.V8_FAIL_STEP ?? 'download', 'i');
    const matching = failedOnly.filter(([, s]) => [...s.steps].some((step) => stepPattern.test(step)));
    // Prefer accounts that failed at the step under investigation; fall back to any
    // failed account so the probe still runs if the dumps have no Download rows.
    const pool = matching.length > 0 ? matching : failedOnly;
    if (pool.length === 0) {
      return { failedSteps: [], skipReason: 'No never-passed accounts with a known password found in the results dumps.' };
    }

    const index = Number(process.env.V8_ACCOUNT_INDEX ?? 0);
    const [email, entry] = pool[index] ?? pool[0];
    console.log(`🎯  v8 account pool: ${pool.length} candidate(s) (${matching.length > 0 ? `failed at /${stepPattern.source}/i` : 'any failed step — no step match'}) — taking index ${index}`);
    return { account: { email, password: passwords.get(email)! }, failedSteps: [...entry.steps] };
  } catch (err: any) {
    return { failedSteps: [], skipReason: `Failed account selection errored: ${firstLine(err)}` };
  }
}

// ════════════════════════════════════════════════════════════════
//  Generic helpers
// ════════════════════════════════════════════════════════════════

function attachDiagnostics(tag: string, target: Page): void {
  target.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`   🧭 [${tag}:console.error] ${msg.text().slice(0, 200)}`);
  });
  target.on('pageerror', (err) => console.log(`   💥 [${tag}:pageerror] ${err.message.slice(0, 200)}`));
  target.on('requestfailed', (req) => {
    const failure = req.failure()?.errorText ?? '';
    if (failure.includes('ERR_ABORTED')) return;
    console.log(`   📴 [${tag}:requestfailed] ${req.method()} ${req.url().slice(0, 110)} — ${failure}`);
  });
  target.on('response', (res) => {
    if (res.status() >= 400) console.log(`   📡 [${tag}:http ${res.status()}] ${res.request().method()} ${res.url().slice(0, 110)}`);
  });
  target.on('download', (d) => console.log(`   📥 [${tag}:download] suggestedFilename=${d.suggestedFilename()}`));
}

/**
 * Write a screenshot + HTML + aria snapshot for `target` into PROBE_DIR and attach
 * them to the report. Never throws: a capture failure must not mask the real one.
 */
async function dumpPage(label: string, target: Page, testInfo: TestInfo): Promise<void> {
  const slug = label.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
  fs.mkdirSync(PROBE_DIR, { recursive: true });

  try {
    const shot = await target.screenshot({ fullPage: false });
    fs.writeFileSync(path.join(PROBE_DIR, `${slug}.png`), shot);
    await testInfo.attach(`${slug}-screenshot`, { body: shot, contentType: 'image/png' });
  } catch (err: any) {
    console.log(`   ⚠️  screenshot failed: ${firstLine(err)}`);
  }

  try {
    const html = await target.content();
    fs.writeFileSync(path.join(PROBE_DIR, `${slug}.html`), html, 'utf8');
    console.log(`   📄 html dump: ${slug}.html (${html.length} bytes)`);
  } catch (err: any) {
    console.log(`   ⚠️  html dump failed: ${firstLine(err)}`);
  }

  // The aria snapshot is the useful one: it pierces shadow DOM and names controls
  // the way getByRole/getByLabel will see them.
  try {
    const aria = await target.locator('body').ariaSnapshot({ timeout: 30_000 });
    fs.writeFileSync(path.join(PROBE_DIR, `${slug}.aria.yml`), aria, 'utf8');
    console.log(`   🌲 aria snapshot: ${slug}.aria.yml (${aria.length} bytes)`);
  } catch (err: any) {
    console.log(`   ⚠️  aria snapshot failed: ${firstLine(err)}`);
  }
}

function safeUrl(target: Page): string {
  try {
    return target.url();
  } catch {
    return '(unavailable)';
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0].trim();
}

function indent(text: string): string {
  return text.split('\n').map((line) => `      ${line}`).join('\n');
}
