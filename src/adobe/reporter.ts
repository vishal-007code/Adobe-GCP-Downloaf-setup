import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { appendCsvRow } from './csv';
import { loadConsumedLedgerRows, normalizeAdobeEmail } from './accounts';
import {
  ADOBE_ACCOUNT_ATTACHMENT,
  ADOBE_CONSUMED_HEADERS,
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

  // Per-task tallies, emitted as one [ADOBE_TASK_SUMMARY] line in onEnd so each
  // Cloud Run task self-reports its own totals instead of requiring a log sweep.
  private attempted = 0;
  private loggedIn = 0;
  private loginFailed = 0;
  private passed = 0;
  private failed = 0;
  private skipped = 0;

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

    const accountMetadata = readJsonAttachment<{ email?: string }>(result, ADOBE_ACCOUNT_ATTACHMENT);
    const stepMetadata = readJsonAttachment<{ lastStep?: string }>(result, ADOBE_STEP_ATTACHMENT);
    const linkMetadata = readJsonAttachment<{ publishedLink?: string }>(result, ADOBE_LINK_ATTACHMENT);
    const loginMetadata = readJsonAttachment<{ ok?: boolean; url?: string; ownerEntity?: string }>(
      result,
      ADOBE_LOGIN_ATTACHMENT,
    );
    const mappedStatus = mapStatus(result.status);
    const email = accountMetadata?.email?.trim().toLowerCase() ?? '';

    // A login counts if the dashboard was confirmed, EVEN IF the test later failed.
    // Falling back to the step name covers runs where the attachment never landed
    // (e.g. the test threw between the dashboard and the attach call).
    const loggedIn = loginMetadata?.ok === true
      || (mappedStatus === 'passed' && stepPassedDashboard(stepMetadata?.lastStep));

    if (mappedStatus !== 'skipped') {
      this.attempted += 1;
      if (loggedIn) this.loggedIn += 1;
      else this.loginFailed += 1;
    }
    if (mappedStatus === 'passed') this.passed += 1;
    else if (mappedStatus === 'failed') this.failed += 1;
    else this.skipped += 1;

    // Emit a stable, greppable per-account line to stdout so the outcome survives in
    // the Cloud Run logs even when results are not uploaded to GCS (SAVE_ARTIFACTS=false).
    // scripts/build-resume-csv.sh parses these lines (it only needs status + email).
    // For failures we also append the last step and a short reason so the cause is
    // diagnosable straight from the logs without uploading the CSV/HTML report.
    if (email) {
      if (mappedStatus === 'failed') {
        const step = (stepMetadata?.lastStep?.trim() ?? '').replace(/"/g, "'");
        const reason = getFailureReason(test, result, mappedStatus).slice(0, 300).replace(/"/g, "'");
        console.log(
          `[ADOBE_RESULT] status=failed email=${email} logged_in=${loggedIn ? 'yes' : 'no'}` +
          ` step="${step}" reason="${reason}"`,
        );
      } else {
        console.log(
          `[ADOBE_RESULT] status=${mappedStatus} email=${email} logged_in=${loggedIn ? 'yes' : 'no'}`,
        );
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
    ]);

    // Mark account consumed once, regardless of pass/fail.
    if (email) {
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
      ` passed=${this.passed} failed=${this.failed} skipped=${this.skipped}`,
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
    'Navigate to Fixed Postcard', 'Skip Tutorial', 'Download',
  ];
  return post.some((step) => lastStep.startsWith(step));
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
