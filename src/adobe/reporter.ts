import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { appendCsvRow } from './csv';
import { loadConsumedLedgerRows, normalizeAdobeEmail } from './accounts';
import {
  ADOBE_ACCOUNT_ATTACHMENT,
  ADOBE_CONSUMED_HEADERS,
  ADOBE_DOWNLOAD_ATTACHMENT,
  ADOBE_LINK_ATTACHMENT,
  ADOBE_LOGIN_ATTACHMENT,
  ADOBE_RESULTS_HEADERS,
  ADOBE_STEP_ATTACHMENT,
  getAdobeConsumedLedgerPath,
  getAdobeResultsPathForRun,
  requireAdobeRunId,
} from './runtime';
import type { AdobeResultStatus } from './types';

export default class AdobeCsvReporter implements Reporter {
  private readonly resultsPath: string;
  private readonly consumedLedgerPath: string;
  private readonly seenEmails = new Set<string>();
  // Emails whose dashboard was reached on any attempt (test retries re-run an account).
  private readonly loggedInEmails = new Set<string>();

  // Per-task tallies, emitted as one [ADOBE_TASK_SUMMARY] line in onEnd so each
  // Cloud Run task self-reports its own totals instead of requiring a log sweep.
  private attempted = 0;
  private loggedIn = 0;
  private loginFailed = 0;
  private passed = 0;
  private failed = 0;
  private skipped = 0;
  private downloaded = 0;

  constructor() {
    const runId = requireAdobeRunId();
    this.resultsPath = getAdobeResultsPathForRun(runId);
    this.consumedLedgerPath = getAdobeConsumedLedgerPath();

    // Pre-load already-consumed emails so we never write duplicates to the ledger.
    for (const row of loadConsumedLedgerRows(this.consumedLedgerPath)) {
      const normalized = normalizeAdobeEmail(row.email);
      if (normalized) this.seenEmails.add(normalized);
    }
  }

  printsToStdio(): boolean {
    return false;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!isAdobeProjectTest(test)) return;

    const accountMetadata = readJsonAttachment<{ email?: string; region?: string }>(result, ADOBE_ACCOUNT_ATTACHMENT);
    const stepMetadata = readJsonAttachment<{ lastStep?: string }>(result, ADOBE_STEP_ATTACHMENT);
    const linkMetadata = readJsonAttachment<{ publishedLink?: string }>(result, ADOBE_LINK_ATTACHMENT);
    const loginMetadata = readJsonAttachment<{ ok?: boolean; url?: string; ownerEntity?: string; loginMs?: number }>(
      result,
      ADOBE_LOGIN_ATTACHMENT,
    );
    const downloadMetadata = readJsonAttachment<{
      file?: string;
      bytes?: number;
      editorOpenMs?: number;
      exportMs?: number;
      editorReloads?: number;
    }>(result, ADOBE_DOWNLOAD_ATTACHMENT);
    const mappedStatus = mapStatus(result.status);
    const email = accountMetadata?.email?.trim().toLowerCase() ?? '';
    const region = accountMetadata?.region ?? '';

    // A login counts if the dashboard was confirmed, EVEN IF the test later failed.
    // Falling back to the step name covers runs where the attachment never landed
    // (e.g. the test threw between the dashboard and the attach call). An earlier
    // attempt's login still counts when a retry then fails before the dashboard.
    const loggedIn = loginMetadata?.ok === true
      || (mappedStatus === 'passed' && stepPassedDashboard(stepMetadata?.lastStep))
      || (email !== '' && this.loggedInEmails.has(email));
    if (loggedIn && email) this.loggedInEmails.add(email);

    // The download attachment is the test's last act, so its presence means the PNG export
    // finished. That — not test_status — is what separates "login + download" from "login
    // only": an activation-only run (ADOBE_STOP_AFTER_LETS_GO=1) passes without one.
    const downloaded = Boolean(downloadMetadata?.file);
    const outcome = mappedStatus === 'skipped' ? 'skipped'
      : downloaded ? 'login_download'
      : loggedIn ? 'login_only'
      : 'no_login';
    const timings = {
      login_s: seconds(loginMetadata?.loginMs),
      editor_open_s: seconds(downloadMetadata?.editorOpenMs),
      export_s: seconds(downloadMetadata?.exportMs),
      editor_reloads: downloadMetadata?.editorReloads === undefined ? '' : String(downloadMetadata.editorReloads),
    };

    // With test retries on, a failed attempt Playwright is about to re-run is not the
    // account's outcome. Log it, but keep the CSV, tallies, [ADOBE_RESULT] and ledger to
    // one final row per account.
    // ('interrupted' is never retried, so it falls through and is recorded.)
    const willRetry = (result.status === 'failed' || result.status === 'timedOut') && result.retry < test.retries;
    if (willRetry) {
      const step = (stepMetadata?.lastStep?.trim() ?? '').replace(/"/g, "'");
      const reason = getFailureReason(test, result, mappedStatus).slice(0, 300).replace(/"/g, "'");
      console.log(
        `[ADOBE_RETRY] email=${email} attempt=${result.retry + 1}/${test.retries + 1}` +
        ` step="${step}" reason="${reason}"`,
      );
      return;
    }

    if (mappedStatus !== 'skipped') {
      this.attempted += 1;
      if (loggedIn) this.loggedIn += 1;
      else this.loginFailed += 1;
    }
    if (mappedStatus === 'passed') this.passed += 1;
    else if (mappedStatus === 'failed') this.failed += 1;
    else this.skipped += 1;
    if (downloaded) this.downloaded += 1;

    // Emit a stable, greppable per-account line to stdout so the outcome survives in
    // the Cloud Run logs even when results are not uploaded to GCS (SAVE_ARTIFACTS=false).
    // scripts/build-resume-csv.sh parses these lines (it only needs status + email).
    // For failures we also append the last step and a short reason so the cause is
    // diagnosable straight from the logs without uploading the CSV/HTML report.
    // scripts/build-run-report.mjs builds the per-account report from these lines, using
    // downloaded=/outcome= and the timing fields (only present once reached).
    if (email) {
      const base = `[ADOBE_RESULT] status=${mappedStatus} email=${email} logged_in=${loggedIn ? 'yes' : 'no'}` +
        ` downloaded=${downloaded ? 'yes' : 'no'} outcome=${outcome}` +
        (region ? ` region=${region}` : '') +
        Object.entries(timings).filter(([, value]) => value !== '').map(([key, value]) => ` ${key}=${value}`).join('');
      if (mappedStatus === 'failed') {
        const step = (stepMetadata?.lastStep?.trim() ?? '').replace(/"/g, "'");
        const reason = getFailureReason(test, result, mappedStatus).slice(0, 300).replace(/"/g, "'");
        console.log(`${base} step="${step}" reason="${reason}"`);
      } else {
        console.log(base);
      }
    }

    // Write result row immediately — visible in the CSV as each test finishes.
    appendCsvRow(this.resultsPath, ADOBE_RESULTS_HEADERS, [
      result.startTime.toISOString(),
      email,
      mappedStatus,
      loggedIn ? 'yes' : 'no',
      loginMetadata?.url ?? '',
      loginMetadata?.ownerEntity ?? '',
      mappedStatus === 'failed' ? stepMetadata?.lastStep?.trim() ?? '' : '',
      getFailureReason(test, result, mappedStatus),
      String(result.duration),
      linkMetadata?.publishedLink?.trim() ?? '',
      downloadMetadata?.file?.trim() ?? '',
      downloaded ? 'yes' : 'no',
      outcome,
      timings.login_s,
      timings.editor_open_s,
      timings.export_s,
      timings.editor_reloads,
      region,
    ]);

    // Mark the account consumed only once it PASSED, i.e. its download (and upload, when
    // configured) completed. A failed account stays fresh, so simply re-running the same
    // accounts CSV retries exactly the accounts that still have no download.
    if (email && mappedStatus === 'passed') {
      const normalized = normalizeAdobeEmail(email);
      if (normalized && !this.seenEmails.has(normalized)) {
        this.seenEmails.add(normalized);
        appendCsvRow(this.consumedLedgerPath, ADOBE_CONSUMED_HEADERS, [
          normalized,
          result.startTime.toISOString(),
        ]);
      }
    }
  }

  onEnd(_result: FullResult): void {
    // All rows were written in real-time in onTestEnd — nothing to merge.
    //
    // Emit one machine-readable tally per Cloud Run task. Summing the login_ok
    // fields of these lines gives the run-wide login count without parsing every
    // per-account line. task=/of= come from Cloud Run's own task env vars so a
    // partial run is obvious (fewer summary lines than tasks = tasks still going
    // or dead).
    const taskIndex = process.env.CLOUD_RUN_TASK_INDEX ?? '';
    const taskCount = process.env.CLOUD_RUN_TASK_COUNT ?? '';
    console.log(
      `[ADOBE_TASK_SUMMARY] task=${taskIndex} of=${taskCount}` +
      ` attempted=${this.attempted} login_ok=${this.loggedIn} login_fail=${this.loginFailed}` +
      ` passed=${this.passed} failed=${this.failed} skipped=${this.skipped} downloaded=${this.downloaded}`,
    );
  }
}

/**
 * True when the last recorded step is at or past the dashboard wait — i.e. the
 * account did reach the dashboard. Used only as a fallback when the adobe-login
 * attachment is missing.
 */
function stepPassedDashboard(lastStep: string | undefined): boolean {
  if (!lastStep) return false;
  const post = [
    'Activate by Lets Go', 'Stop after Lets Go', 'Wait 30s after Lets Go', 'Dwell on dashboard',
    // Download-flow steps (this project): reaching any of these means the dashboard
    // was confirmed, so a passed run at these steps counts as a successful login.
    'Navigate to Fixed Postcard', 'Skip Tutorial', 'Download', 'Upload to GCS',
  ];
  return post.some((step) => lastStep.startsWith(step));
}

/** Milliseconds → seconds (one decimal) for the CSV/log line; '' when not measured. */
function seconds(ms: number | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? (ms / 1000).toFixed(1) : '';
}

function isAdobeProjectTest(test: TestCase): boolean {
  // Matches adobe-chromium and adobe-firefox; excludes internal-chromium.
  return test.titlePath()[1]?.startsWith('adobe-') ?? false;
}

function mapStatus(status: TestResult['status']): AdobeResultStatus {
  if (status === 'passed') return 'passed';
  if (status === 'skipped') return 'skipped';
  return 'failed';
}

function readJsonAttachment<T>(result: TestResult, name: string): T | undefined {
  const attachment = result.attachments.find(
    (candidate) => candidate.name === name && candidate.contentType === 'application/json',
  );
  if (!attachment?.body) return undefined;
  return JSON.parse(attachment.body.toString('utf8')) as T;
}

function getFailureReason(test: TestCase, result: TestResult, mappedStatus: AdobeResultStatus): string {
  if (mappedStatus === 'passed') return '';

  if (mappedStatus === 'skipped') {
    const skipAnnotation = result.annotations.find((a) => a.type === 'skip');
    return skipAnnotation?.description ?? test.annotations.find((a) => a.type === 'skip')?.description ?? '';
  }

  return formatError(result.error ?? result.errors[0]);
}

function formatError(error: { message?: string; value?: string } | undefined): string {
  if (!error) return '';
  const raw = error.message?.trim() || error.value?.trim();
  if (!raw) return '';
  // Same treatment as cleanReason() in src/pages/adobe.ts: drop Playwright's
  // "===== logs =====" tail, which carries OAuth/SAML tokens in its URLs and adds
  // ~1.5 KB per failure to both the results CSV and the [ADOBE_RESULT] log line.
  return raw
    .split(/={5,}/)[0]
    .replace(/\[[0-9;]*m/g, '')   // strip Playwright's ANSI colour codes
    .replace(/\[[0-9;]*m/g, '')        // ...and any bare remnant
    .replace(/https?:\/\/\S+/g, (url) => url.split('?')[0])
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}
