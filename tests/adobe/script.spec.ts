import fs from 'node:fs';
import { defineAdobeAccountTests, expect } from '../../src/adobe/spec';
import { ADOBE_DOWNLOAD_ATTACHMENT, ADOBE_LOGIN_ATTACHMENT } from '../../src/adobe/runtime';
import { getDownloadsUploadUri, uploadDownload } from '../../src/adobe/download-upload';
import { AdobePage } from "../../src/pages/adobe";
import { GmailProvider } from "../../src/pages/gmailProvider";
import { MsProvider} from "../../src/pages/msProvider";
import { DOWNLOAD_FORMATS, DownloadFormat, EditorDashboard } from '../../src/pages/editorDashboard';
import { REGION_TEMPLATE_URLS } from '../../src/adobe/regions';

// Export format: png (default) | jpg | pdf. Set per run with ADOBE_DOWNLOAD_FORMAT.
const DOWNLOAD_FORMAT = (process.env.ADOBE_DOWNLOAD_FORMAT?.trim().toLowerCase() || 'png') as DownloadFormat;
if (!DOWNLOAD_FORMATS.includes(DOWNLOAD_FORMAT)) {
  throw new Error(`ADOBE_DOWNLOAD_FORMAT must be one of ${DOWNLOAD_FORMATS.join(', ')} (got "${DOWNLOAD_FORMAT}")`);
}

/** Host of an identity-provider URL, for step names/logs. The raw URL carries
 *  state/rart OAuth tokens and is echoed into the results CSV and the [ADOBE_RESULT]
 *  log line — using only the host avoids leaking tokens and keeps failure grouping usable. */
function providerHost(providerUrl: string): string {
  try {
    return new URL(providerUrl).host;
  } catch {
    return providerUrl.slice(0, 60);
  }
}

defineAdobeAccountTests('script flow', async ({ page, context, account, stepTracker }, testInfo) => {
    // Stamped first so the download retry can tell how much of testInfo.timeout is left.
    const testStartedAt = Date.now();
    const adobe = new AdobePage(page);
    let editor: EditorDashboard;   // bound to the postcard tab once it opens
    const ms = new MsProvider(page);
    const ggl = new GmailProvider(page);

  // Start intercepting UDS requests to capture auth credentials for API-based Let's Go dismissal
  adobe.startUdsCapture();

  stepTracker.setStep('open login');
  await adobe.adb_login()

  stepTracker.setStep('Enter email at Adobe Login');
  await adobe.fill_adb_email_field(account.email);

  stepTracker.setStep('Handle Personal/Company screen on Adobe Login');
  await adobe.select_cmp_option();

  stepTracker.setStep('check email provider');
  const provider  =  await adobe.getLoginProvider();

  stepTracker.setStep('Login with ' + providerHost(provider));
  if(provider.includes('accounts.google.com')){
        await ggl.g_login(account.email,account.password);
  } else if (provider.includes('login.microsoftonline.com')){
        await ms.ms_login(account.email,account.password);
  }

  stepTracker.setStep('Wait for Adobe Dashboard');
  // Passing the email emits the [ADOBE_LOGIN_OK] / [ADOBE_LOGIN_FAIL] log marker.
  await adobe.waitForDashboard(account.email);
  const loginMs = Date.now() - testStartedAt;

  stepTracker.setStep('Activate by Lets Go');
  try {
    await adobe.skipLetsGoViaAPI(account.email);
  } finally {
    // Attach login proof (after Let's Go so ownerEntity has been captured, but in a
    // finally so a Let's Go failure still records the login). The reporter reads it to
    // fill logged_in/dashboard_url/owner_entity even if a later step fails.
    const loginEvidence = adobe.getLoginEvidence();
    if (loginEvidence) {
      await testInfo.attach(ADOBE_LOGIN_ATTACHMENT, {
        body: Buffer.from(JSON.stringify({ ...loginEvidence, loginMs }), 'utf8'),
        contentType: 'application/json',
      });
    }
  }

  // Activation-only mode: ADOBE_STOP_AFTER_LETS_GO=1 stops here — login is proven and
  // Let's Go dismissed, but the postcard tab + download are skipped. Leave the flag
  // unset (or !=1) to run the full download flow. Lets the same image serve both an
  // activation run and a download run, chosen per-launch.
  if (process.env.ADOBE_STOP_AFTER_LETS_GO?.trim() === '1') {
    stepTracker.setStep('Stop after Lets Go');
    return;
  }

  stepTracker.setStep('Navigate to Fixed Postcard');
  // Settle buffer to let late dashboard content/interrupts render.
  await page.waitForTimeout(1200);
  // Editor-open time runs from here to the Download button being enabled (reloads included).
  const editorStartedAt = Date.now();
  let editorReadyAt = editorStartedAt;
  let editorReloads = 0;
  // KVS and Bihar accounts each download their own region's postcard (src/adobe/regions.ts).
  console.log(`Opening the ${account.region} postcard for ${account.email}`);
  const postcardPage = await context.newPage();
  await postcardPage.goto(REGION_TEMPLATE_URLS[account.region], { waitUntil: 'load' });
  editor = new EditorDashboard(postcardPage);   // rebind; original tab stays open


  // ── OLD flow (blank Square canvas → search inside editor) — replaced by v7's dashboard search ──
  // stepTracker.setStep('Setup Canvas');
  // await adobe.createTemplate();

  // stepTracker.setStep('Search Template');
  // const keyword: string = adobe.getRandomSearchKeyword()
  // await adobe.searchForTemplate(keyword);

  // stepTracker.setStep('Select Template');
  // await adobe.selectTemplate(keyword);

  // // ── NEW flow (from v7): search templates on the dashboard, click a random result ──
  // stepTracker.setStep('Search Template');
  // await adobe.searchDashboardTemplate('Postcard');
  //
  // stepTracker.setStep('Select Template');
  // await adobe.selectRandomTemplate();

  // The editor's tutorial/coachmark still appears after a template opens; skipTutorial
  // registers a persistent "Skip tour" handler that also protects the Share click.
  stepTracker.setStep('Skip Tutorial dialog if visible');
  await editor.skipTutorial();

  // stepTracker.setStep('Redirect to edit');
  // await adobe.shortcut();
  
  // stepTracker.setStep('Wait for Img Generation');
  // await adobe.wait_for_generation();

  // stepTracker.setStep('Open In Editor');
  // await editor.clickOpenInEditor();


  // Share→publish→copy-link removed (ported from experiment-v9): the download does not
  // need a published doc — v9's headed run confirmed downloadDesign renders and commits
  // straight from the editor. No link attachment either, so CSV rows have an empty
  // published-link column (the reporter reads it optionally).
  //
  // Downloads from `editor`, not `adobe`: the design is on the postcard tab while AdobePage
  // stays bound to the login tab. adobe.download_img() looked there — which is why every
  // account in the 2026-08-18 run failed at this step — and it also still clicked the
  // Firefly-era 'Selected image' radio, which this editor's download panel does not have.
  // Both confirmed live by tests/adobe/experiment-v8.spec.ts.
  stepTracker.setStep('Download');
  let filePath: string;
  try {
    filePath = await editor.downloadDesign(testInfo.workerIndex, account.email, {
      format: DOWNLOAD_FORMAT,
      onStep: (step) => stepTracker.setStep(step),
      budgetLeftMs: () => testInfo.timeout - (Date.now() - testStartedAt),
      onEditorReady: (attempt) => {
        editorReadyAt = Date.now();
        editorReloads = attempt - 1;
      },
    });
  } catch (error) {
    // Playwright's own failure screenshot often times out on the heavy editor canvas (and
    // is skipped for pages it cannot reach), so capture the editor tab explicitly.
    const shot = await postcardPage.screenshot({ timeout: 15_000 }).catch(() => undefined);
    if (shot) await testInfo.attach('editor-at-failure', { body: shot, contentType: 'image/png' });
    throw error;
  }
  const downloadedAt = Date.now();
  console.log(`File saved to: ${filePath} (${fs.statSync(filePath).size} bytes)`);
  expect(filePath).toBeTruthy();

  // The PNG itself is not kept: on Cloud Run it vanishes with the container. The proof of
  // the download is the attachment below, which the reporter turns into downloaded=yes in
  // the results CSV and the [ADOBE_RESULT] log line (read back by build-run-report.sh).
  // Setting ADOBE_DOWNLOADS_GCS_URI additionally copies each PNG to the bucket as
  // <email>.png; an upload failure then fails the test so the account is retried.
  let downloadFile = filePath;
  const uploadPrefix = getDownloadsUploadUri();
  if (uploadPrefix) {
    stepTracker.setStep('Upload to GCS');
    downloadFile = await uploadDownload(filePath, account.email, uploadPrefix);
    console.log(`[ADOBE_DOWNLOAD] email=${account.email.trim().toLowerCase()} file=${downloadFile}`);
  }
  await testInfo.attach(ADOBE_DOWNLOAD_ATTACHMENT, {
    body: Buffer.from(JSON.stringify({
      file: downloadFile,
      bytes: fs.statSync(filePath).size,
      editorOpenMs: editorReadyAt - editorStartedAt,
      exportMs: downloadedAt - editorReadyAt,
      editorReloads,
    }), 'utf8'),
    contentType: 'application/json',
  });

});
