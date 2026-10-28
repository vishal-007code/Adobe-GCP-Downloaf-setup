import fs from 'node:fs';
import path from 'node:path';
import { expect, Locator, Page } from "@playwright/test";

// How long to allow for the editor shell itself to mount before we even look at the
// Share control's state. The 2026-08-05 run failed 31 of 42 accounts on
// `expect(#share-btn).toBeEnabled()` reporting "element(s) not found" after 20s —
// i.e. the toolbar had not rendered yet, not that the button was disabled. Whole-test
// p90 that run was 105s, so a 20s allowance for editor boot was racing first paint.
const EDITOR_READY_TIMEOUT = 120_000;
// Once the toolbar exists, the button going from mounted to enabled is quick.
const SHARE_ENABLED_TIMEOUT = 30_000;
const CLICK_TIMEOUT = 20_000;
// Do not begin another share→publish attempt unless this much of the test timeout is
// left; a retry that gets killed halfway reports a misleading step and wastes a worker.
const MIN_RETRY_BUDGET_MS = 150_000;
// The download panel mounts as soon as the trigger is clicked; 60s is slack for a
// contended worker, not for any real preparation work.
const DOWNLOAD_PANEL_TIMEOUT = 60_000;
// Time from committing the download to the browser's download event, and nothing else —
// see the arming comment in downloadDesign. Adobe renders the asset server-side first;
// the v8 probe measured ~8s for a single-page postcard. Under software GL (cloud config,
// SwiftShader) the export runs far slower: a 2026-10-14 smoke run timed out at 120s with
// Adobe's "Almost complete… 90%" export dialog still up, so allow 240s.
const DOWNLOAD_RENDER_TIMEOUT = 240_000;
// The share/publish panel is a modal <dialog>, and the v8 probe needed two Escapes to
// clear the stack (a second dialog sits behind it). A few extra presses are free.
const PANEL_DISMISS_ATTEMPTS = 4;
const DOWNLOADS_DIR = './downloads';
// Per-attempt wait for the editor's top nav (and its Download trigger) to mount. A healthy
// editor mounts it ~25s after navigation (2026-10-14 trace); the failures that day never
// mounted it within 120s at all, so time past this is better spent reloading.
const EDITOR_BOOT_TIMEOUT = 75_000;
const EDITOR_RELOAD_TIMEOUT = 60_000;
// Download attempts including the first, i.e. up to two editor reloads.
const DOWNLOAD_ATTEMPTS = 3;

/** Formats the editor's download panel offers (data-testid="download-<format>"). */
export type DownloadFormat = 'png' | 'jpg' | 'pdf';
export const DOWNLOAD_FORMATS: readonly DownloadFormat[] = ['png', 'jpg', 'pdf'];

type DownloadOptions = {
    /** File format to export. Default 'png', the panel's own default. */
    format?: DownloadFormat;
    /** Total attempts, including the first. Default DOWNLOAD_ATTEMPTS. */
    attempts?: number;
    /** Called before each retry so the CSV's failed_at_step shows how far it got. */
    onStep?: (step: string) => void;
    /** Milliseconds left in the test timeout. Used to decide whether a retry fits. */
    budgetLeftMs?: () => number;
    /** Called when the editor's Download button is enabled, i.e. the editor is open.
     *  `attempt` is 1 for the first load, 2+ after reloads. Used for timing. */
    onEditorReady?: (attempt: number) => void;
};

type SharePublishOptions = {
    /** Total attempts, including the first. Default 2 (one retry). */
    attempts?: number;
    /** Called before each sub-step so the CSV's failed_at_step stays granular. */
    onStep?: (step: string) => void;
    /** Milliseconds left in the test timeout. Used to decide whether a retry fits. */
    budgetLeftMs?: () => number;
};

export class EditorDashboard {
    readonly page: Page;
    readonly openInEditor: Locator;
    readonly skipTutorial_btn: Locator;
    readonly navSharebtn: Locator;
    readonly viewOnlyLink: Locator;
    readonly publishTab: Locator;
    readonly createLinkBtn: Locator;
    readonly copyLinkBtn: Locator;
    readonly publishUrl: Locator;
    readonly downloadTrigger: Locator;
    readonly fileFormatPicker: Locator;
    readonly downloadCommitBtn: Locator;
    private beforeUnloadHandlerInstalled = false;

    constructor(page: Page) {
        this.page = page;
        this.openInEditor = page.getByRole('button', { name: 'Open in editor' });
        this.skipTutorial_btn = page.getByText('Skip tour');
        this.navSharebtn = page.locator('#share-btn');
        this.viewOnlyLink = page.getByRole('menuitem', { name: 'View-only link' });
        // New "Share file" panel: Share/Publish tabs. The "Publish" tab hosts the
        // "Create link" (publishedV2) flow that the classic "View-only link"
        // menuitem used to open.
        this.publishTab = page.getByRole('tab', { name: 'Publish' });
        this.createLinkBtn = page.getByText('Create link').first();
        this.copyLinkBtn = page.getByRole('button', { name: 'Copy link' });
        this.publishUrl = page.locator('a[href^="https://new.express.adobe.com/publishedV2/"]').first();
        // Download controls, all addressed by data-testid rather than role/label.
        // The v8 probe found the top-nav trigger renders as
        //   <sp-button id="download-btn" data-testid="editor-download-button">
        // with NO accessible name and NO text, inside a shadow root — so it is invisible
        // to getByRole/getByLabel (both returned 0 matches) and absent from page.content().
        this.downloadTrigger = page.locator('[data-testid="editor-download-button"]');
        // Defaults to PNG, so the picker is only touched when another format is asked for
        // (chooseFileFormat). The options are
        // [data-testid="download-png" | download-jpg | download-pdf | download-pdf-print].
        this.fileFormatPicker = page.locator('[data-testid="file-format-picker"]');
        this.downloadCommitBtn = page.locator('[data-testid="download-commit-button"]');
    }

    async clickOpenInEditor(): Promise<void> {
        // Required step — fail fast so a broken account aborts here instead of
        // limping through every later step and burning each one's timeout.
        await expect(this.openInEditor).toBeEnabled({ timeout: 20000 });
        await this.openInEditor.click({ timeout: 20000 });
    }

    async skipTutorial(): Promise<void> {
        // 1. The "Try the updated editor" coachmark tour appears at an unpredictable
        // time — often AFTER this method runs — and its underlay intercepts pointer
        // events on later steps (e.g. the search bar). A one-shot dismiss races that
        // timing, so register an auto-handler instead: whenever "Skip tour" becomes
        // visible during ANY subsequent action, Playwright clicks it and retries the
        // action. This is the idiomatic fix for intermittent overlays and carries no
        // fixed wait penalty when no tour appears.
        //
        // noWaitAfter: without it Playwright waits, after the handler, for "Skip tour" to be
        // HIDDEN before resuming the action — and when the tour lingers that wait eats the
        // whole action timeout ("locator.click: Timeout 20000ms exceeded ... waiting for
        // locator('[data-testid=editor-download-button]')" with the button present and
        // enabled). 74 of 134 trigger failures in the August CSVs, and again on 2026-10-25.
        // With it, the action just retries; if the tour is still up the handler fires again.
        await this.page.addLocatorHandler(
            this.page.getByRole('button', { name: 'Skip tour' }),
            async (locator) => {
                console.log('[ADOBE_SKIP_TOUR] tour overlay seen — clicking Skip tour');
                await locator.click({ timeout: 5000 }).catch(() => { /* tour may close on its own */ });
            },
            { noWaitAfter: true },
        );

        // 2. Try to dismiss quick tips / popups (if visible)
        try {
            const gotItBtn = this.page.getByRole('button', { name: 'Got it' }).or(this.page.getByText('Got it'));
            if (await gotItBtn.isVisible()) {
                await gotItBtn.click({ timeout: 5000 });
            }
        } catch (e) {
            console.log('skipTutorial: error checking/clicking Got it', e);
        }
    }

    /**
     * Gate on a positive "editor is up" signal before asserting on the Share button's
     * state. Adobe mounts the top-nav Share control only once the keystone editor shell
     * has booted, so its presence in the DOM is the earliest reliable readiness marker
     * this page exposes.
     *
     * Splitting the wait into attached-then-enabled matters for diagnosis as much as for
     * pass rate: a single `toBeEnabled` conflated "editor still loading" with "button
     * mounted but not yet actionable", and reported both as "element(s) not found".
     */
    async waitForEditorReady(): Promise<void> {
        await this.navSharebtn.waitFor({ state: 'attached', timeout: EDITOR_READY_TIMEOUT });
        await expect(this.navSharebtn).toBeEnabled({ timeout: SHARE_ENABLED_TIMEOUT });
    }

    async clickShare(): Promise<void> {
        // Required step — fail fast instead of swallowing and continuing.
        await this.waitForEditorReady();
        await this.navSharebtn.click({ timeout: CLICK_TIMEOUT });
    }

    async openViewOnlyLink(): Promise<void> {
        // After clicking Share, Adobe shows "We're working on your file…" while it
        // prepares the doc; the share options only appear once that completes.
        //
        // Two share-panel variants exist:
        //   • Classic:  a "View-only link" menuitem → click it to reveal "Create link".
        //   • New "Share file" panel: Share/Publish tabs, where the "Publish" tab hosts
        //     the same "Create link" (publishedV2) flow.
        //
        // Wait directly for whichever entry point this account gets (rather than racing
        // the delayed prep message). File prep can exceed 120s, so allow 180s; this
        // still fits the 360s per-test budget alongside the downstream link steps.
        const entryPoint = this.viewOnlyLink.or(this.publishTab).first();
        await expect(entryPoint).toBeVisible({ timeout: 180_000 });

        if (await this.viewOnlyLink.isVisible().catch(() => false)) {
            // Classic panel.
            await this.viewOnlyLink.click({ timeout: 20000 });
        } else {
            // New "Share file" panel — the Publish tab exposes the Create link flow.
            await this.publishTab.click({ timeout: 20000 });
        }

        // "Create link" becomes available once the document finishes preparing. In the
        // new Publish panel that prep can land here (the tab itself renders immediately),
        // so keep a generous wait rather than the classic short one.
        await expect(this.createLinkBtn).toBeVisible({ timeout: 180_000 });
    }

    async clickCreateLink(): Promise<void> {
        // Required step — fail fast instead of swallowing and continuing.
        await expect(this.createLinkBtn).toBeEnabled({ timeout: 20000 });
        await this.createLinkBtn.click({ timeout: 20000 });
        // Link generation is done when EITHER a "Copy link" button appears (one panel
        // variant) OR the published URL is rendered directly with an icon copy control
        // (another variant). Wait for whichever shows up so both variants proceed.
        await expect(this.copyLinkBtn.or(this.publishUrl).first()).toBeVisible({ timeout: 30000 });
    }

    async clickCopyLink(): Promise<string> {
        // Best-effort: if this panel variant has a "Copy link" button, click it (puts the
        // URL on the clipboard). The other variant renders only the link with an icon
        // control and no labeled button — in that case skip the click. Either way, the
        // rendered published URL is the source of truth, so read the href from it.
        if (await this.copyLinkBtn.isVisible().catch(() => false)) {
            await this.copyLinkBtn.click({ timeout: 20000 }).catch(() => { /* link still readable below */ });
        }

        await expect(this.publishUrl).toHaveAttribute('href', /https:\/\/new\.express\.adobe\.com\/publishedV2\//, { timeout: 30000 });

        const link = await this.publishUrl.getAttribute('href') ?? '';
        console.log('Publish Link: ', link);
        return link.trim();
    }

    /**
     * Export the open design and save it under ./downloads, returning the saved path.
     *
     * Replaces AdobePage.download_img() for this flow, which could not work here for two
     * independent reasons the v8 probe (tests/adobe/experiment-v8.spec.ts) confirmed live:
     *
     *   1. WRONG TAB. AdobePage is constructed on the login tab, but since the flow began
     *      opening the postcard via context.newPage() the design lives on a second tab.
     *      Probing both tabs after publish: the login tab has zero download controls
     *      (getByLabel('Download') = 0, #download-btn = 0), the editor tab has them. That
     *      is the 2026-08-18 run's "element(s) not found after 120s", and — once the
     *      context tore down mid-wait — its "Target page, context or browser has been
     *      closed" while waiting for the download event.
     *   2. FIREFLY-ERA LOCATORS. download_img() clicks getByText('Selected image'), which
     *      belongs to the text-to-image generation panel. The template editor's download
     *      panel has no such control (probe count: 0) — it has a file-format picker.
     *
     * Being on EditorDashboard rather than AdobePage is the actual fix: this class is
     * always constructed against the tab holding the design, so the wrong-tab bug cannot
     * come back the next time the flow changes which tab that is.
     */
    async downloadDesign(workerIndex: number = 0, accountEmail?: string, opts: DownloadOptions = {}): Promise<string> {
        const { format = 'png', attempts = DOWNLOAD_ATTEMPTS, onStep = () => { /* step reporting optional */ }, budgetLeftMs, onEditorReady } = opts;
        let lastError: unknown;

        // Retried with an editor RELOAD between attempts. The dominant failure (3 of 8
        // logged-in accounts in the 2026-10-14 smoke runs; "Download" is the top failed
        // step across every past report) is the editor whose top nav never mounts: the
        // canvas draws but the Share/Download buttons stay grey placeholders and
        // [data-testid="editor-download-button"] never appears. Waiting longer on that
        // page does not help; remounting the editor is the only recovery available
        // in-test. A stalled export ("Almost complete… 90%") is retried the same way.
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            if (attempt > 1) {
                if (this.page.isClosed()) break;
                const left = budgetLeftMs?.() ?? Number.POSITIVE_INFINITY;
                if (left < MIN_RETRY_BUDGET_MS) {
                    console.log(`downloadDesign: ${Math.round(left / 1000)}s of test budget left, under the ${MIN_RETRY_BUDGET_MS / 1000}s an attempt needs — reporting the original failure`);
                    break;
                }
                console.log(
                    `[ADOBE_DOWNLOAD_RETRY] email=${accountEmail ?? ''} attempt=${attempt}/${attempts}` +
                    ` after="${firstLine(lastError).replace(/"/g, "'").slice(0, 160)}"`,
                );
                onStep(`Download (after reload ${attempt - 1})`);
                await this.reloadEditor();
            }

            try {
                const filePath = await this.downloadOnce(workerIndex, accountEmail, format, () => onEditorReady?.(attempt));
                if (attempt > 1) {
                    console.log(`[ADOBE_DOWNLOAD_RECOVERED] email=${accountEmail ?? ''} attempt=${attempt}/${attempts}`);
                }
                return filePath;
            } catch (error) {
                lastError = error;
                if (this.page.isClosed()) break;
                await this.logEditorState(accountEmail, attempt);
            }
        }

        throw lastError;
    }

    /**
     * One greppable line describing the editor when a download attempt fails, so a
     * failure in the Cloud Run logs says WHICH way the editor was broken: no top nav at
     * all (share_btn=0), nav up but no download trigger (testids lack
     * editor-download-button), or stuck on an Adobe error/notice (notice=...).
     *
     * BEST-EFFORT: never throws; every probe is short and swallowed.
     */
    private async logEditorState(accountEmail: string | undefined, attempt: number): Promise<void> {
        const probe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
            try { return await fn(); } catch { return fallback; }
        };
        const url = this.page.url().split('?')[0];
        const shareBtn = await probe(() => this.navSharebtn.count(), -1);
        const testIds = await probe(
            () => this.page.locator('[data-testid*="download" i]').evaluateAll(
                (els) => els.map((el) => el.getAttribute('data-testid') ?? '')),
            [] as string[],
        );
        const notice = await probe(
            () => this.page.locator('[role="alert"], [role="alertdialog"], dialog[open]').first()
                .innerText({ timeout: 2_000 }),
            '',
        );
        console.log(
            `[ADOBE_DOWNLOAD_DIAG] email=${accountEmail ?? ''} attempt=${attempt} url=${url}` +
            ` share_btn=${shareBtn} download_testids=${[...new Set(testIds)].join('|') || 'none'}` +
            ` notice="${notice.replace(/\s+/g, ' ').replace(/"/g, "'").trim().slice(0, 120)}"`,
        );
    }

    /**
     * Remount the editor for another download attempt. reload() keeps the current
     * document URL, and the "Skip tour" locator handler from skipTutorial is registered on
     * the Page, so it survives the reload.
     *
     * BEST-EFFORT: runs while handling a failure; the next attempt's own waits report
     * anything still wrong.
     */
    private async reloadEditor(): Promise<void> {
        // The editor may hold a "Leave site?" beforeunload prompt while it autosaves.
        // Playwright auto-DISMISSES dialogs nobody handles, which for beforeunload means
        // "stay on the page" — the reload would then hang until its timeout. Accept it.
        if (!this.beforeUnloadHandlerInstalled) {
            this.beforeUnloadHandlerInstalled = true;
            this.page.on('dialog', (dialog) => {
                const settle = dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss();
                settle.catch(() => { /* dialog already gone */ });
            });
        }

        await this.page.keyboard.press('Escape').catch(() => { /* nothing focused */ });
        await this.page.reload({ waitUntil: 'load', timeout: EDITOR_RELOAD_TIMEOUT }).catch((error) => {
            console.log(`reloadEditor: reload did not settle — ${firstLine(error)}`);
        });
    }

    /** One download attempt: open the download panel, pick the format, commit, save the file. */
    private async downloadOnce(
        workerIndex: number,
        accountEmail: string | undefined,
        format: DownloadFormat,
        onEditorReady?: () => void,
    ): Promise<string> {
        // The share/publish panel left open by the previous step is a modal <dialog>, which
        // makes the rest of the page inert. The trigger is visible and enabled in the top
        // nav the whole time, but the click cannot land — the probe's first run burned a
        // 15s click timeout on exactly this. Clear the panel before reaching for the nav.
        await this.dismissOpenPanels();

        await expect(this.downloadTrigger).toBeEnabled({ timeout: EDITOR_BOOT_TIMEOUT });
        onEditorReady?.();
        await this.downloadTrigger.click({ timeout: CLICK_TIMEOUT });

        await expect(this.downloadCommitBtn).toBeEnabled({ timeout: DOWNLOAD_PANEL_TIMEOUT });
        if (format !== 'png') await this.chooseFileFormat(format);

        // Armed here, NOT before the trigger click: waitForEvent starts its clock
        // immediately, so arming earlier would let the two waits above (up to 180s
        // combined on a contended worker) eat the render budget and time out on a
        // download that was about to arrive. Nothing is missed by waiting — both probe
        // runs showed the panel always renders, and the download only starts on commit.
        // The bare .catch marks the rejection handled so a timeout here cannot surface as
        // an unhandled rejection if the click below throws first; the await still reports it.
        const downloadPromise = this.page.waitForEvent('download', { timeout: DOWNLOAD_RENDER_TIMEOUT });
        downloadPromise.catch(() => { /* reported by the await below */ });

        await this.downloadCommitBtn.click({ timeout: CLICK_TIMEOUT });

        const download = await downloadPromise;

        // The panel silently keeps PNG if the format pick did not take, so check the file
        // that actually arrived rather than trusting the clicks.
        const suggested = download.suggestedFilename();
        const expectedExt = format === 'jpg' ? /\.jpe?g$/i : new RegExp(`\\.${format}$`, 'i');
        if (!expectedExt.test(suggested)) {
            throw new Error(`downloadDesign: asked for ${format.toUpperCase()} but the download is "${suggested}"`);
        }

        fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
        // Worker-prefixed because suggestedFilename is minute-resolution
        // ("Untitled - August 18, 2026 at 20.51.17.png") and parallel workers collide.
        // Email-slugged (when provided) so each PNG maps back to the account that made
        // it — essential once thousands land in one GCS prefix.
        const emailSlug = accountEmail
            ? accountEmail.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_') + '-'
            : '';
        const filePath = path.join(DOWNLOADS_DIR, `worker-${workerIndex}-${emailSlug}${suggested}`);
        await download.saveAs(filePath);
        console.log(`downloadDesign: saved ${filePath}`);

        return filePath;
    }

    /**
     * Switch the open download panel from its default (PNG) to `format`: open the
     * file-format picker, click the option, and wait for the commit button to settle again.
     */
    private async chooseFileFormat(format: DownloadFormat): Promise<void> {
        await this.fileFormatPicker.click({ timeout: CLICK_TIMEOUT });
        await this.page.locator(`[data-testid="download-${format}"]`).click({ timeout: CLICK_TIMEOUT });
        await expect(this.downloadCommitBtn).toBeEnabled({ timeout: DOWNLOAD_PANEL_TIMEOUT });
    }

    /**
     * Press Escape until no visible <dialog> is left on the page.
     *
     * One press is not enough: the probe found two dialogs open after publish and the first
     * Escape left one of them visible. Clicking the panel's own close button is not an
     * alternative — it sits inside the modal and its click timed out too, so Escape is the
     * only mechanism observed to work here.
     *
     * BEST-EFFORT: a dialog that will not close is left for the caller's own timeout to
     * report against the control it actually wanted, which is a clearer failure than one
     * raised from here.
     */
    private async dismissOpenPanels(): Promise<void> {
        const openDialogs = this.page.locator('dialog').filter({ visible: true });

        for (let attempt = 1; attempt <= PANEL_DISMISS_ATTEMPTS; attempt += 1) {
            if (await openDialogs.count().catch(() => 0) === 0) return;
            await this.page.keyboard.press('Escape').catch(() => { /* nothing focused */ });
            await this.page.waitForTimeout(700);
        }

        const remaining = await openDialogs.count().catch(() => -1);
        if (remaining !== 0) {
            console.log(`dismissOpenPanels: ${remaining} dialog(s) still open after ${PANEL_DISMISS_ATTEMPTS} Escape press(es)`);
        }
    }

    /**
     * Run the whole share → publish leg (Share → View-only/Publish → Create link) with a
     * bounded retry.
     *
     * Retried as a leg, not per step: in the 2026-08-05 run these failures arrived in
     * environment-driven bursts (both workers failing within seconds of each other, clean
     * stretches in between) and left the editor part-way advanced — a half-open share
     * panel, or no toolbar at all. Re-running one step in place would just re-hit the same
     * stuck state, so every attempt resets first.
     *
     * Recovery has to happen in-test: accounts are single-use, so Playwright's test-level
     * retries would consume a fresh account per attempt.
     */
    async sharePublishWithRetry(opts: SharePublishOptions = {}): Promise<void> {
        const { attempts = 2, onStep = () => { /* step reporting optional */ }, budgetLeftMs } = opts;
        let lastError: unknown;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            if (attempt > 1) {
                const left = budgetLeftMs?.() ?? Number.POSITIVE_INFINITY;
                if (left < MIN_RETRY_BUDGET_MS) {
                    console.log(`sharePublishWithRetry: ${Math.round(left / 1000)}s of test budget left, under the ${MIN_RETRY_BUDGET_MS / 1000}s an attempt needs — reporting the original failure`);
                    break;
                }
                console.log(`sharePublishWithRetry: attempt ${attempt}/${attempts} after — ${firstLine(lastError)}`);
                await this.resetForShareRetry();
            }

            try {
                onStep('Click Share button');
                await this.clickShare();

                onStep('Open View Only Link');
                await this.openViewOnlyLink();

                onStep('Click Create Link button');
                await this.clickCreateLink();
                return;
            } catch (error) {
                lastError = error;
            }
        }

        throw lastError;
    }

    /**
     * Put the editor back into a state a fresh share attempt can start from.
     *
     * BEST-EFFORT: this runs while already handling a failure, so it must never throw and
     * mask the original error.
     */
    private async resetForShareRetry(): Promise<void> {
        // Close whatever panel/dialog the failed attempt left open. Escape is a no-op when
        // nothing is open, so this is safe either way.
        await this.page.keyboard.press('Escape').catch(() => { /* nothing focused */ });
        await this.page.waitForTimeout(500);

        // If the toolbar itself never mounted then panel state was never the problem — the
        // editor is. Remount it. reload() keeps the current document URL, so this reloads
        // the design in progress rather than opening a second one. The "Skip tour" locator
        // handler from skipTutorial is registered on the Page, not the document, so it
        // survives the reload and still guards the retried clicks.
        const toolbarPresent = await this.navSharebtn.count().then((c) => c > 0).catch(() => false);
        if (!toolbarPresent) {
            console.log('resetForShareRetry: no #share-btn in the DOM — reloading the editor');
            await this.page.reload({ waitUntil: 'load' }).catch(() => { /* readiness re-checked by the next attempt */ });
        }
    }
}

function firstLine(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.split('\n')[0].trim();
}
