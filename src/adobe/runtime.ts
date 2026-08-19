import path from 'node:path';

export const ADOBE_ACCOUNT_ATTACHMENT = 'adobe-account';
export const ADOBE_STEP_ATTACHMENT = 'adobe-step';
export const ADOBE_LINK_ATTACHMENT = 'adobe-link';
export const ADOBE_LOGIN_ATTACHMENT = 'adobe-login';
export const ADOBE_NO_FRESH_ACCOUNTS_REASON = 'No fresh accounts available';

export const ADOBE_RESULTS_HEADERS = [
  'timestamp',
  'email',
  'test_status',
  // 'yes' once the Adobe dashboard was confirmed for this account. Tracked apart
  // from test_status because a test can fail AFTER a successful login (Let's Go,
  // dwell, template flow) — those accounts did log in and must still be counted.
  'logged_in',
  'dashboard_url',
  // Adobe's server-side user ID, captured from authenticated UDS traffic.
  'owner_entity',
  'failed_at_step',
  'failure_reason',
  'duration_ms',
  'published_link',
] as const;

export const ADOBE_CONSUMED_HEADERS = ['email', 'consumed_at'] as const;

export function createAdobeRunId(now: Date = new Date()): string {
  const compact = now.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
  return `${compact}-${process.pid}`;
}

export function getReportsDir(cwd: string = process.cwd()): string {
  return path.join(cwd, 'reports');
}

export function getAdobeTmpDir(runId: string, cwd: string = process.cwd()): string {
  return path.join(getReportsDir(cwd), '.tmp', runId);
}

export function getAdobeConsumedLedgerPath(cwd: string = process.cwd()): string {
  return path.join(getReportsDir(cwd), 'adobe_consumed_accounts.csv');
}

export function getAdobeResultsPath(now: Date = new Date(), cwd: string = process.cwd()): string {
  const timestamp = now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return path.join(getReportsDir(cwd), `adobe_results_${timestamp}.csv`);
}

export function getAdobeResultsPathForRun(runId: string, cwd: string = process.cwd()): string {
  return path.join(getReportsDir(cwd), `adobe_results_${runId}.csv`);
}

export function requireAdobeRunId(env: NodeJS.ProcessEnv = process.env): string {
  const runId = env.ADOBE_RUN_ID?.trim();
  if (!runId) {
    throw new Error('ADOBE_RUN_ID is not set. Initialize it in playwright.config.ts before test startup.');
  }
  return runId;
}
