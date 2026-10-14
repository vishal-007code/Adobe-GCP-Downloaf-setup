import fs from 'node:fs';
import {expect, Locator, Page} from "@playwright/test";

export class AdobePage {

    readonly page: Page;
    readonly email_field : Locator;
    readonly email_field_continue : Locator;
    readonly downld_icon : Locator
    readonly single_img_radio_btn : Locator;
    readonly downld_btn : Locator;
    readonly loadIndicator : Locator;
    readonly selected_card : Locator;
    readonly letsGo_btn : Locator;
    readonly sltNaccount : Locator;
    readonly cmp_option : Locator;
    readonly genratedImg : Locator;
    readonly letsGoIndicator : Locator;
    readonly createNew : Locator;
    readonly squareTemplate : Locator;
    readonly searchBar : Locator;
    readonly resultCountText : Locator;
    readonly templateResult : Locator;
    readonly dashboardSearch : Locator;

    // UDS credential capture (for API-based Let's Go dismissal)
    private capturedAuthHeader = '';
    private capturedOwnerEntity = '';
    private udsCapturing = false;
    private dashboardHandlersInstalled = false;


    private randomSearchKeywords : string[];

    constructor(page: Page) {
        this.page = page;
        this.email_field = page.getByRole('textbox', { name: 'Email address' });
        this.downld_icon = page.getByLabel('Download').first();
        this.single_img_radio_btn = page.getByText("Selected image");
        this.downld_btn  = page.getByText("Download").last();
        this.email_field_continue = page.getByLabel('Continue');
        this.loadIndicator = page.getByTestId('firefly-skeleton');
        this.selected_card = page.locator(".selected.card");
        this.letsGo_btn = page.getByTestId('x-dialog-primary-cta');
        this.sltNaccount = page.getByRole('heading', { name: 'Select an account' });
        this.cmp_option = page.getByText('Company or School Account');
        this.genratedImg = page.getByTestId('firefly-thumbnail-image').first();
        this.letsGoIndicator = page.getByRole('heading', { name: /Help us customize your experience\./i });
        this.createNew = page.getByRole('button', { name: 'Create new' });
        this.squareTemplate = page.getByText('Square', { exact: true });
        this.searchBar = page.getByRole('combobox', { name: 'Search Instagram square post' });
        this.randomSearchKeywords = ['Yoga Day', 'Festival', 'Birthday', 'Sale', 'Wedding'];
        this.resultCountText = page.getByTestId('results-count-text');
        this.templateResult = page.locator('button.thumbnail-button-filler').first();
        this.dashboardSearch = page.getByRole('textbox', { name: /Search for templates and more/i });
    }

    async adb_login(): Promise<void> {
        try {
            await this.page.goto("https://new.express.adobe.com/");
        } catch {
            // goto can throw when Adobe immediately redirects to the auth server before
            // navigation settles. waitForURL below confirms we actually landed there.
        }
        await this.page.waitForURL(/auth\.services\.adobe\.com/, { waitUntil: 'load' });
    }

    async fill_adb_email_field( email:string ): Promise<void> {
        await this.email_field.click();
        await this.email_field.clear();
        await this.email_field.pressSequentially(email, { delay: 30 });
        await this.page.waitForTimeout(300);
        await this.email_field_continue.click();
    }

    async select_cmp_option(): Promise<void> {
        try{
            await this.sltNaccount.waitFor({state:'visible',timeout: 3000});
        }catch(e){}
        if(await this.cmp_option.isVisible()) {
            await this.cmp_option.click();
        }

    }

    async wait_for_generation(): Promise<void> {
        await expect(this.genratedImg).toBeVisible({ timeout: 180_000 });
        await expect(this.downld_icon).toBeEnabled({ timeout: 30_000 });
        await expect(this.loadIndicator).toHaveCount(0, { timeout: 30_000 });
    }

    /**
     * @deprecated For the template flow use EditorDashboard.downloadDesign() instead.
     *
     * This belongs to the Firefly text-to-image path: downld_icon/downld_btn are labelled
     * "Download" there and the panel offers a "Selected image" radio. The template editor
     * exposes none of that — its trigger is an unlabelled shadow-DOM
     * [data-testid="editor-download-button"] and the panel has a file-format picker
     * (verified by tests/adobe/experiment-v8.spec.ts). It is also bound to whichever page
     * AdobePage was constructed with, which is the login tab in the current flow, not the
     * tab holding the design. Kept for the generation flow (wait_for_generation) only.
     */
    async download_img(workerIndex: number = 0): Promise<string | null> {
        // waiting for the download event BEFORE clicking the final button
        const downloadPromise = this.page.waitForEvent('download',{timeout: 260000});
        await expect(this.downld_icon).toBeEnabled();
        await this.downld_icon.click();
        await this.single_img_radio_btn.click();
        await this.downld_btn.click();

        const download = await downloadPromise;

        fs.mkdirSync('./downloads', { recursive: true });
        const filePath = `./downloads/worker-${workerIndex}-${download.suggestedFilename()}`;
        await download.saveAs(filePath);

        return filePath;
    }

    async getLoginProvider(): Promise<string> {
        const supportedProviderPattern = /^https:\/\/(?:accounts\.google\.com|login\.microsoftonline\.com)\//i;

        // Return the URL from inside waitForFunction so it is captured atomically with
        // the pattern check — no separate page.url() call that could race a redirect.
        const handle = await this.page.waitForFunction(
            (patternSource) => {
                const url = window.location.href;
                return new RegExp(patternSource, 'i').test(url) ? url : null;
            },
            supportedProviderPattern.source,
            { timeout: 90_000 }
        );

        return await handle.jsonValue() as string;
    }

    async waitForDashboard(): Promise<void> {
        // Adobe now lands the post-login dashboard on express.adobe.com (it used to be
        // new.express.adobe.com), so accept either host. Skip the intermediate
        // ?postlogin=true redirect hops on the way there — the dashboard isn't up yet.
        try {
            await this.page.waitForURL(
                url => /^(new\.)?express\.adobe\.com$/.test(url.hostname) && !url.searchParams.has('postlogin'),
                { timeout: 120_000 }
            );
        } catch (e) {
            throw new Error(`Failed to navigate to Adobe Dashboard (express.adobe.com). Login likely failed. Original error: ${e}`);
        }

        await this.installDashboardInterruptionHandlers();

        try {
            // Wait for network to settle so UDS requests fire and auth credentials are captured
            await this.page.waitForLoadState('load', { timeout: 30_000 });
        } catch (e) {
            console.log('waitForDashboard: page load did not fully settle on Load', e);
        }


    }

    private async installDashboardInterruptionHandlers(): Promise<void> {
        if (this.dashboardHandlersInstalled) return;
        this.dashboardHandlersInstalled = true;

        // The "Choose your language" regional prompt is NOT exposed as role="dialog",
        // so an earlier dialog-role trigger never matched and the prompt kept blocking
        // later steps (e.g. createTemplate). Trigger on the heading itself, which is
        // the element that actually renders.
        const languageHeading = this.page.getByRole('heading', { name: 'Choose your language', exact: true });

        // This regional prompt can appear after the dashboard is already actionable,
        // including while the Create panel or editor is loading. Dismiss it WITHOUT
        // committing a language: clicking "Continue" commits the choice and triggers a
        // full reload of new.express.adobe.com/, after which the prompt re-appears —
        // an infinite navigation loop that starves later steps (the search textbox
        // never stabilizes). "Cancel" (falling back to the "Close dialog" X) closes it
        // in place with no reload. noWaitAfter stops Playwright blocking on a post-click
        // navigation before continuing the intercepted action.
        await this.page.addLocatorHandler(languageHeading, async () => {
            console.log('installDashboardInterruptionHandlers: "Choose your language" prompt detected — dismissing via Cancel');
            await this.dismissRegionalPrompt();
        }, { noWaitAfter: true });

        // The "Let's Go" education survey ("Help us customize your experience.") can
        // still surface in the UI even after skipLetsGoViaAPI — sometimes LATE, e.g.
        // while createTemplate runs — because the API write persists the preference
        // server-side but the already-mounted client survey doesn't re-read it. Its
        // <x-edu-user-role-survey-modal> then overlays the page and intercepts clicks
        // (e.g. "Create new"). A one-shot dismissal misses that timing, so register a
        // persistent handler: accept the default "I'm a student" selection by clicking
        // the primary CTA ("Let's go").
        await this.page.addLocatorHandler(this.letsGoIndicator, async () => {
            console.log('installDashboardInterruptionHandlers: "Let\'s Go" survey detected — clicking Let\'s go');
            await this.letsGo_btn.click({ timeout: 10_000 });
        });

        // The "Choose your country" regional prompt behaves like "Choose your language":
        // it can surface on the dashboard (e.g. before/while searching templates) and
        // block later steps. Same reload-loop hazard on "Continue", so dismiss it the
        // same way — Cancel/X with no post-click navigation wait.
        const countryHeading = this.page.getByRole('heading', { name: 'Choose your country', exact: true });
        await this.page.addLocatorHandler(countryHeading, async () => {
            console.log('installDashboardInterruptionHandlers: "Choose your country" prompt detected — dismissing via Cancel');
            await this.dismissRegionalPrompt();
        }, { noWaitAfter: true });
    }

    /**
     * Dismiss a regional ("Choose your language" / "Choose your country") prompt
     * WITHOUT committing a selection. Committing via "Continue" reloads the dashboard
     * and the prompt re-appears, so prefer "Cancel", falling back to the "Close dialog"
     * X — both close the modal in place with no navigation.
     *
     * BEST-EFFORT: this runs inside a persistent locator handler, so it must NEVER
     * throw. The modal is often already closing by the time we act (e.g. Cancel lands
     * and detaches the node, or it auto-dismisses), which makes the click reject or the
     * fallback button never appear. Any such failure means "already gone" = success, so
     * every click is short-timeout and swallowed. If the modal genuinely persists, the
     * locator handler simply re-fires on the next intercepted action.
     */
    private async dismissRegionalPrompt(): Promise<void> {
        for (const name of ['Cancel', 'Close dialog']) {
            try {
                await this.page.getByRole('button', { name, exact: true }).click({ timeout: 2_000 });
                return;
            } catch {
                // Button absent or modal already closing — try the next, else give up.
            }
        }
    }

    async isLetsGoIndicator_Visible(): Promise<boolean> {
        try {
            // Waits up to 5000ms (5 seconds) for the element to be visible
            await this.letsGoIndicator.waitFor({ state: 'visible', timeout: 10000 });
            return true;
        } catch (e) {
            return false;
        }
    }

    async shortcut(): Promise<void> {
        const shortcutUrl = "https://new.express.adobe.com/new?category=media&action=text+to+image&width=1080&height=1080&intent=general&neural-style=digital&contentClasses=art&prompt=Festival&tab=all";
        
        try {
            await this.page.goto(shortcutUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        } catch (error: any) {
            console.log(`shortcut: Initial navigation interrupted (${error.message}). Retrying...`);
            await this.page.waitForTimeout(3000); // Wait for redirect to settle on dashboard
            await this.page.goto(shortcutUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        }
        
        // Wait for the page to stabilize after redirect
        await this.page.waitForLoadState('load', { timeout: 60_000 }).catch(() => {});
    }

    async handle_letsGo(loginAccount: string): Promise<void> {
        try{
            await this.letsGo_btn.waitFor({ state: 'visible',timeout:20000});
            await this.letsGo_btn.click({ timeout: 5000});
            console.log("--------------------------- Lets Go --------------------------------",{loginAccount});
        }catch (e) {
            console.log("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx SKIPPED LET'S GO xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",{loginAccount});
        }

    }

    /**
     * Start passively intercepting UDS requests to capture auth header and ownerEntity.
     * Call this BEFORE dashboard loads (e.g., right after creating AdobePage).
     */
    startUdsCapture(): void {
        if (this.udsCapturing) return;
        this.udsCapturing = true;

        this.page.on('request', (req) => {
            if (!req.url().includes('/service/uds/userdocs/uds-projectx')) return;

            // Capture auth header from any UDS request
            if (!this.capturedAuthHeader) {
                const auth = req.headers()['authorization'];
                if (auth) {
                    this.capturedAuthHeader = auth;
                }
            }

            // Capture ownerEntity from a PATCH body
            if (!this.capturedOwnerEntity && req.method() === 'PATCH') {
                const postData = req.postData();
                if (postData) {
                    try {
                        const body = JSON.parse(postData);
                        if (body.documentId?.ownerEntity) {
                            this.capturedOwnerEntity = body.documentId.ownerEntity;
                        }
                    } catch { /* non-JSON body */ }
                }
            }
        });
    }

    /**
     * Dismiss the "Let's Go" onboarding dialog via a direct API call.
     * Falls back to the UI click (handle_letsGo) if credentials weren't captured.
     */
    async skipLetsGoViaAPI(loginAccount: string): Promise<void> {
        // If ownerEntity wasn't captured yet, wait for a UDS PATCH to fire
        if (!this.capturedOwnerEntity) {
            try {
                const udsReq = await this.page.waitForRequest(
                    req => req.url().includes('/service/uds/userdocs/uds-projectx') && req.method() === 'PATCH',
                    { timeout: 10000 }
                );
                const postData = udsReq.postData();
                if (postData) {
                    const body = JSON.parse(postData);
                    if (body.documentId?.ownerEntity) {
                        this.capturedOwnerEntity = body.documentId.ownerEntity;
                    }
                }
                if (!this.capturedAuthHeader) {
                    this.capturedAuthHeader = udsReq.headers()['authorization'] ?? '';
                }
            } catch {
                console.log('UDS capture timed out — falling back to UI click');
            }
        }

        // If we have both pieces, fire the API
        if (this.capturedAuthHeader && this.capturedOwnerEntity) {
            try {
                // Same host the dashboard is on (express.adobe.com or new.express.adobe.com).
                const response = await this.page.request.patch(
                    new URL('/service/uds/userdocs/uds-projectx', this.page.url()).href,
                    {
                        headers: {
                            'authorization': this.capturedAuthHeader,
                            'Content-Type': 'application/json',
                        },
                        data: {
                            documentId: {
                                appDomain: 'uds-projectx',
                                ownerEntity: this.capturedOwnerEntity,
                            },
                            data: {
                                'education-survey': { role: 'student' },
                            },
                        },
                    }
                );

                if (response.ok()) {
                    console.log('Let\'s Go dismissed via API', { loginAccount });
                    return;
                }
                console.log(`API dismiss failed (${response.status()}) — falling back to UI click`);
            } catch (e) {
                console.log('API dismiss threw — falling back to UI click');
            }
        }

        // Fallback: use the original UI click approach
        await this.handle_letsGo(loginAccount);
    }

    async createTemplate(): Promise<void> {
        await expect(this.createNew).toBeEnabled({timeout:20000})
        await this.createNew.click({timeout:20000});
        await expect(this.squareTemplate).toBeVisible({timeout:60000})
        await this.squareTemplate.click({timeout:20000});

        // Clicking the card only starts editor initialization. Do not let the next
        // workflow step race Adobe's "Getting everything ready" loading screen.
        await expect(this.searchBar).toBeEnabled({timeout:90000});
    }

    getRandomSearchKeyword(): string {
        const i = Math.floor(Math.random() * this.randomSearchKeywords.length);
        return this.randomSearchKeywords[i];
    }

    async searchForTemplate(templateName: string): Promise<void> {
        await expect(this.searchBar).toBeEnabled({timeout:30000})
        // A late "Try the updated editor" coachmark can intercept this click; the
        // addLocatorHandler registered in EditorDashboard.skipTutorial auto-dismisses
        // it and retries, so no explicit guard is needed here.
        await this.searchBar.click({timeout:20000});
        await this.searchBar.pressSequentially(templateName);
        await this.searchBar.press("Enter");
    }

    async selectTemplate(templateName: string): Promise<void> {
        await expect(this.resultCountText).toBeVisible({timeout:10000});
        const text = await this.resultCountText.innerText();
        // The count text format varies: it echoes the query for narrow searches
        // ("878 results for "Birthday""), but shows a generic count for large
        // categories ("11,000+ results"). Verify the keyword only when it's echoed;
        // otherwise just confirm the search returned matches.
        if (/results for/i.test(text)) {
            expect(text).toContain(templateName);
        } else {
            expect(text).toMatch(/\d[\d,]*\+?\s+results/i);
        }

        await expect(this.templateResult).toBeVisible({timeout:10000});
        // The first result is often an animated template: a hover-preview <video> and
        // the sticky search header overlay the (empty) filler button, so a real click
        // is intercepted. Invoke the button's own click handler directly to bypass the
        // occluding layers.
        await this.templateResult.evaluate((el) => (el as HTMLElement).click());
    }

    // Dashboard-level template search — searches templates directly from the dashboard
    // (no blank canvas), then opens a result in the editor. Real keystrokes drive the
    // type-ahead dropdown, so pressSequentially (not fill): a programmatic fill can set
    // the value without rendering the suggestion dropdown. No Enter press — submitting
    // would close the dropdown; instead click the suggestion while it's open.
    async searchDashboardTemplate(templateName: string): Promise<void> {
        await expect(this.dashboardSearch).toBeVisible({timeout:30000});
        // The regional "Choose your language"/"country" modal can appear LATE — while we
        // type — and steal focus, so only the first keystroke lands (the field shows "P"
        // instead of "Postcard"). The locator handler dismisses the modal, but the
        // truncated input is never restored, so the suggestion never renders. Guard by
        // typing, then asserting the field actually holds the full term; if a focus-steal
        // truncated it, toPass retries the whole entry — by the retry the modal has been
        // dismissed, so the retype sticks. Each click re-triggers the handler, so a modal
        // present at retry time is cleared before we type again.
        await expect(async () => {
            await this.dashboardSearch.click({timeout:20000});
            await this.dashboardSearch.fill('');
            // Type with a per-keystroke delay: the type-ahead suggestion dropdown reacts to
            // input events, so typing too fast can populate the field without the dropdown
            // ever rendering. The delay lets suggestions catch up before we click one.
            await this.dashboardSearch.pressSequentially(templateName, { delay: 150 });
            await expect(this.dashboardSearch).toHaveValue(templateName, { timeout: 2000 });
        }).toPass({ timeout: 30000 });
        // Wait for the suggestion to actually render before clicking it.
        const suggestion = this.page.getByText(templateName).first();
        await suggestion.waitFor({ state: 'visible', timeout: 15000 });
        await suggestion.click({timeout:20000});
        await expect(this.resultCountText).toBeVisible({timeout:30000});
    }

    // Pick a random result thumbnail. The grid lazy-loads (~30 render initially), so we
    // assert the grid is present rather than pinning an exact count. Result thumbnails
    // are animated (hover-preview <video>) with a sticky search header overlaying the
    // filler button, so a real click gets intercepted — invoke the element's own click
    // handler directly to bypass the occluding layers (mirrors selectTemplate).
    async selectRandomTemplate(): Promise<void> {
        const thumbs = this.page.locator('button.thumbnail-button-filler');
        await expect(thumbs.first()).toBeVisible({timeout:30000});
        const count = await thumbs.count();
        expect(count).toBeGreaterThan(0);
        const index = Math.floor(Math.random() * count);
        console.log(`selectRandomTemplate: clicking thumbnail ${index + 1} of ${count}`);
        const target = thumbs.nth(index);
        await target.scrollIntoViewIfNeeded();
        await target.evaluate((el) => (el as HTMLElement).click());
    }
}
