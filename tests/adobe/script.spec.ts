import { defineAdobeAccountTests, expect } from '../../src/adobe/spec';
import { AdobePage } from "../../src/pages/adobe";
import { GmailProvider } from "../../src/pages/gmailProvider";
import { MsProvider} from "../../src/pages/msProvider";
import { EditorDashboard } from '../../src/pages/editorDashboard';

const FIXED_POSTCARD_URL = 'https://new.express.adobe.com/design/template/urn:aaid:sc:VA6C2:f2c97bf0-1039-5b0d-be7a-528c0060757b?category=text&entryPoint=template&taskID=postcard';

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
  await adobe.waitForDashboard();

  stepTracker.setStep('Activate by Lets Go');
  await adobe.skipLetsGoViaAPI(account.email);

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
  const postcardPage = await context.newPage();
  await postcardPage.goto(FIXED_POSTCARD_URL, { waitUntil: 'load' });
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
  const filePath = await editor.downloadDesign(testInfo.workerIndex, account.email);
  console.log(`File saved to: ${filePath}`);
  expect(filePath).toBeTruthy();

});
