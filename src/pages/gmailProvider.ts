import type { Locator, Page } from "@playwright/test";

export class GmailProvider {
    readonly page: Page;
    readonly email_field: Locator;
    readonly password_field: Locator;
    readonly welcome_screen: Locator;
    readonly i_understand_button: Locator;
    readonly confirm_signIn_msg: Locator;
    readonly confirm_sign_in_button: Locator;
    readonly login_blocker: Locator;
    readonly login_error_text: Locator;

    constructor(page: Page) {
        this.page = page;
        this.email_field = page.getByLabel('Email or phone');
        this.password_field = page.getByLabel('Enter your password');
        this.welcome_screen = page.getByText('Welcome to your new account');
        this.i_understand_button = page.getByRole('button', { name: /I understand/i });
        this.confirm_signIn_msg = page.getByText('Sign in to Adobe');
        this.confirm_sign_in_button = page.getByRole('button', { name: /^Continue$/i });

        // Copy that can ONLY appear once Google has rejected what we submitted, so it is
        // safe to abort the instant one shows up.
        //
        // Deliberately does NOT match "Your password was changed N days ago": Google also
        // renders that as a neutral hint on the password step BEFORE submission, so keying
        // an abort off it could kill a login that was about to succeed. The
        // still-on-the-password-step backstop in assertPasswordAccepted catches those.
        this.login_blocker = page.getByText(
            /Wrong password|password is incorrect|Couldn['’]t sign you in|Couldn['’]t find (?:this account|your Google Account)|browser or app may not be secure|Too many failed attempts/i,
        ).first();

        // Wider net, read only once we already know the login failed — purely so Google's
        // own wording lands in the thrown error, and therefore in the results CSV.
        this.login_error_text = page.getByText(
            /Wrong password|Your password was changed|Couldn['’]t find (?:this account|your Google Account)|Couldn['’]t sign you in|browser or app may not be secure|Too many failed attempts|Verify it['’]s you/i,
        ).first();
    }

    // async g_email_field( email : string ): Promise<void> {
    //     await this.email_field.fill(email);
    //     await this.page.waitForTimeout(1000);
    //     await this.email_field.press("Enter");
    // }

    async g_email_field(email: string): Promise<void> {
        await this.email_field.fill(email);
        await this.page.waitForTimeout(500);

        // Submit via the Next button, not just Enter. On the two-column sign-in variant these
        // Workspace accounts get, Enter frequently does NOT advance — the page sits on the
        // email step with Next still showing (the frozen screenshot). Click Next; fall back
        // to Enter only if it isn't there.
        const next = this.page.getByRole('button', { name: /^Next$/i }).first();
        if (await next.isVisible().catch(() => false)) {
            await next.click().catch(() => this.email_field.press('Enter'));
        } else {
            await this.email_field.press('Enter');
        }
    }

    async g_password_field(password: string): Promise<void> {
        await this.password_field.fill(password);
        await this.page.waitForTimeout(1000);
        await this.password_field.press("Enter");
    }

    async click_g_iUnderstand(): Promise<void> {
        await this.click_optional_button(this.i_understand_button);
    }

    async click_confirm_sign_in_button(): Promise<void> {
        await this.click_optional_button(this.confirm_sign_in_button);
    }

    private async click_optional_button(locator: Locator, timeout = 5000): Promise<void> {
        try {
            const button = locator.filter({ visible: true }).first();
            await button.waitFor({ state: 'visible', timeout });
            await button.click({ timeout });
        } catch (e) {
        }
    }

    /**
     * Bounded wait for Google's password step to appear after the email is submitted.
     *
     * Without an explicit timeout the fill() in g_password_field inherits the 120s
     * actionTimeout, so an account Google refuses to advance past the email step (unknown
     * account, bot challenge) costs two full minutes before failing — and fails with an
     * opaque "locator.fill: Timeout 120000ms exceeded" rather than the reason. 30s is far
     * more than this step needs whenever it is going to render at all.
     *
     * Poll for EITHER the password step or a hard rejection banner rather than waiting the
     * whole timeout for the password field alone: an unknown account ("Couldn't find this
     * account") or an automation block ("Couldn't sign you in") never advances, so gating
     * only on the password field spent the full 30s idling on a verdict Google had already
     * rendered in the first second. Break the instant the blocker shows.
     */
    private async waitForPasswordStep(timeout = 30_000): Promise<void> {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (await this.password_field.isVisible().catch(() => false)) return;
            if (await this.login_blocker.isVisible().catch(() => false)) break;
            await this.page.waitForTimeout(500);
        }
        // Final check: the password step can render right at the deadline, between polls.
        if (await this.password_field.isVisible().catch(() => false)) return;

        const reason = await this.readLoginError();
        throw new Error(
            `Google never showed the password step within ${timeout}ms` +
            `${reason ? ` — Google says: "${reason}"` : ' (unknown account, or Google blocked the sign-in)'}.`,
        );
    }

    /**
     * Confirm Google actually accepted the password before moving on.
     *
     * On success Google leaves the password step within a few seconds (consent, then the
     * redirect back to Adobe). On rejection it re-renders the SAME step with an inline
     * error — which nothing downstream noticed, so the run continued to waitForDashboard
     * and burned its full 120s timeout before reporting a misleading "Failed to navigate
     * to Adobe Dashboard. Login likely failed."
     *
     * Gate on leaving the password step rather than on the error copy: the wording varies
     * and is localised, whereas "still asking for a password" is unambiguous. An explicit
     * blocker message, when present, just short-circuits the wait.
     */
    private async assertPasswordAccepted(timeout = 30_000): Promise<void> {
        // Poll rather than race locator waits. Do NOT treat "the password box went away"
        // as success: `waitFor({state:'hidden'})` also passes when the locator simply
        // matches nothing, so a markup variant turns the whole gate into a no-op on
        // exactly the rejected logins it exists to catch.
        //
        // Only these signals are trustworthy:
        //   accepted — we left the Google sign-in host, or one of the post-password
        //              screens (consent "Continue", "I understand", new-account welcome)
        //              rendered
        //   rejected — Google printed one of its credential errors
        const deadline = Date.now() + timeout;
        let outcome: 'accepted' | 'rejected' = 'rejected';

        while (Date.now() < deadline) {
            if (await this.login_blocker.isVisible().catch(() => false)) {
                outcome = 'rejected';
                break;
            }
            if (!/accounts\.google\.com/i.test(this.page.url())) {
                outcome = 'accepted';
                break;
            }
            // .first() throughout: these locators can match more than one node, and a
            // strict-mode violation would be swallowed by the catch as a false "no".
            const movedOn = await Promise.all([
                this.confirm_sign_in_button.first().isVisible().catch(() => false),
                this.i_understand_button.first().isVisible().catch(() => false),
                this.welcome_screen.first().isVisible().catch(() => false),
            ]);
            if (movedOn.some(Boolean)) {
                outcome = 'accepted';
                break;
            }
            await this.page.waitForTimeout(500);
        }

        if (outcome === 'accepted') return;

        const reason = await this.readLoginError();
        throw new Error(
            `Google rejected the sign-in${reason ? ` — Google says: "${reason}"` : ' (still on the password step)'}. ` +
            `The stored password for this account is most likely stale.`,
        );
    }

    private async readLoginError(): Promise<string> {
        try {
            const text = await this.login_error_text.innerText({ timeout: 2000 });
            return text.replace(/\s+/g, ' ').trim();
        } catch {
            return '';
        }
    }

    async g_login(email: string, password: string): Promise<void> {
        await this.email_field.waitFor({ state: 'visible' });
        await this.g_email_field(email);

        // Fail fast on both halves of the credential rather than letting a bad account or
        // a stale password fall through to waitForDashboard's 120s timeout.
        await this.waitForPasswordStep();
        await this.g_password_field(password);
        await this.assertPasswordAccepted();

        await this.click_g_iUnderstand();
        await this.click_confirm_sign_in_button();

    }



}
