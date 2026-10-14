import type { Locator, Page } from "@playwright/test";

export class MsProvider {
    readonly page: Page;
    readonly email_field: Locator;
    readonly password_field: Locator;
    readonly stay_signIn_msg: Locator;
    readonly reject_stay_sign_in: Locator;
    readonly login_blocker: Locator;
    readonly login_error_text: Locator;


    constructor(page: Page) {
        this.page = page;
        this.email_field = page.getByLabel('Enter your email, phone, or Skype.');
        this.password_field = page.getByPlaceholder('Password');
        this.stay_signIn_msg = page.getByText('Stay signed in?');
        this.reject_stay_sign_in = page.locator('input[type="button"]');

        // Copy that can only mean Entra/Microsoft rejected what we submitted, so it is
        // safe to abort as soon as one appears. The wording varies by tenant UI — the
        // branded page says "The password is incorrect. Please try again." while the
        // stock one says "Your account or password is incorrect." — so match the common
        // "password is incorrect" fragment rather than either full sentence.
        this.login_blocker = page.getByText(
            /password is incorrect|sign-in was blocked|tried to sign in too many times|username may be incorrect/i,
        ).first();

        // Wider net, read only once we already know the login failed, so Microsoft's own
        // wording ends up in the thrown error and therefore in the results CSV.
        this.login_error_text = page.getByText(
            /password is incorrect|doesn['’]t exist|couldn['’]t find an account|sign-in was blocked|username may be incorrect|Enter a valid email/i,
        ).first();

    }

    async ms_email_field( email : string ): Promise<void> {
        await this.email_field.fill(email);
        await this.page.waitForTimeout(1000);
        await this.email_field.press("Enter");
    }

    async ms_password_field( password : string ): Promise<void> {
        await this.password_field.waitFor({ state: 'visible', timeout: 15000 })
        await this.password_field.fill(password);
        await this.page.waitForTimeout(500);
        await this.password_field.press("Enter");
    }

    async ms_reject_stay_sign_in_confirm(): Promise<void> {
        await this.reject_stay_sign_in.click();
    }

    /**
     * Bounded wait for the password step after the email is submitted.
     *
     * The bare waitFor() this replaces inherited the 120s actionTimeout, so an account
     * Microsoft will not advance past the email step cost two full minutes before failing.
     */
    private async waitForPasswordStep(timeout = 30_000): Promise<void> {
        try {
            await this.password_field.waitFor({ state: 'visible', timeout });
        } catch {
            const reason = await this.readLoginError();
            throw new Error(
                `Microsoft never showed the password step within ${timeout}ms` +
                `${reason ? ` — Microsoft says: "${reason}"` : ' (unknown account, or the sign-in was blocked)'}.`,
            );
        }
    }

    /**
     * Confirm Microsoft actually accepted the password.
     *
     * On success the password step goes away (Stay signed in?, then the redirect back to
     * Adobe). On rejection the same step re-renders with an inline error, which nothing
     * downstream noticed — the run continued to waitForDashboard and burned its full 120s
     * timeout before reporting a misleading "Failed to navigate to Adobe Dashboard".
     */
    private async assertPasswordAccepted(timeout = 30_000): Promise<void> {
        // Poll rather than race locator waits. Do NOT treat "the password box went away"
        // as success: `waitFor({state:'hidden'})` also passes when the locator simply
        // matches nothing, and the tenant-branded page labels its input
        // "Enter the password for <email>" instead of carrying placeholder="Password" —
        // so that check silently passed on exactly the rejected logins it had to catch.
        //
        // Only these signals are trustworthy:
        //   accepted — we left the Microsoft sign-in host, or the post-password
        //              "Stay signed in?" prompt rendered
        //   rejected — Microsoft printed one of its credential errors
        const deadline = Date.now() + timeout;
        let outcome: 'accepted' | 'rejected' = 'rejected';

        while (Date.now() < deadline) {
            if (await this.login_blocker.isVisible().catch(() => false)) {
                outcome = 'rejected';
                break;
            }
            if (!/login\.microsoftonline\.com/i.test(this.page.url())) {
                outcome = 'accepted';
                break;
            }
            if (await this.stay_signIn_msg.first().isVisible().catch(() => false)) {
                outcome = 'accepted';
                break;
            }
            await this.page.waitForTimeout(500);
        }

        if (outcome === 'accepted') return;

        const reason = await this.readLoginError();
        throw new Error(
            `Microsoft rejected the sign-in${reason ? ` — Microsoft says: "${reason}"` : ' (still on the password step)'}. ` +
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

    async ms_login(email: string, password: string): Promise<void> {

        await this.page.waitForURL(/login.microsoftonline.com/);

        try {
            await this.email_field.waitFor({ state: 'visible',timeout:4000});
        } catch (e) {}

        if (await this.email_field.isVisible()) {
            await this.ms_email_field(email);
            // Bounded — the bare waitFor() here used to inherit the 120s actionTimeout.
            await this.waitForPasswordStep();
        }

        await this.ms_password_field(password);

        // Fail fast on a stale password instead of falling through to waitForDashboard.
        await this.assertPasswordAccepted();

        try {
            // Bounded: this wait is swallowed by the catch, so leaving it on the 120s
            // actionTimeout meant every account that never sees "Stay signed in?" paid two
            // silent minutes here. 15s is ample once the password has been accepted.
            await this.stay_signIn_msg.waitFor({ state: 'visible', timeout: 15_000 });
            await this.ms_reject_stay_sign_in_confirm();
        } catch (e) {}
    }

}
