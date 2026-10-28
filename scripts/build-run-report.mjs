#!/usr/bin/env node
// Per-account run report: did each account get LOGIN + DOWNLOAD, LOGIN ONLY, or no login?
//
// Usage:
//   node scripts/build-run-report.mjs [accounts.csv] [--logs=<file>]... [--include-dead]
//
//   accounts.csv    The Email,Password list that was run. Optional — without it the report
//                   covers only accounts found in the evidence and has no "Not run" rows.
//   --logs=<file>   Text dump of the Cloud Run [ADOBE_RESULT] lines. Repeatable.
//                   scripts/build-run-report.sh fetches it from Cloud Logging and calls this.
//                   Without --logs, the local reports/adobe_results_*.csv files are read.
//   --include-dead  Also put accounts whose credentials were rejected in the re-run CSV.
//
// Writes:
//   reports/run-report-<stamp>.csv   one row per account (no passwords)
//   tmp/missing-downloads.csv        Email,Password of every account without a download
//   tmp/dead-accounts.csv            accounts whose credentials were rejected (email,reason)
//   (tmp/ is git-ignored — the re-run CSV holds passwords.)
//
// The evidence is what the reporter records per account (src/adobe/reporter.ts):
// downloaded=yes once the PNG export finished, logged_in=yes once the dashboard was
// reached. No PNG has to exist anywhere. When an account appears in several runs, its
// best result wins (Login + Download > Login only > Login failed), so a re-run that
// downloads upgrades an earlier "Login only". [ADOBE_RESULT] lines from before downloaded=
// was added count as no download.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const includeDead = args.includes('--include-dead');
const logFiles = args.filter((arg) => arg.startsWith('--logs=')).map((arg) => arg.slice('--logs='.length));
const [inputPath] = args.filter((arg) => !arg.startsWith('--'));

const RESULT = {
  download: 'Login + Download',
  loginOnly: 'Login only',
  noLogin: 'Login failed',
  notRun: 'Not run',
};

// Google/Microsoft wording that means the credentials themselves are rejected — matches
// the errors GmailProvider/MsProvider throw. Transient blocks ("browser or app may not
// be secure", "Too many failed attempts") are deliberately NOT here: those can pass on
// a later run.
const DEAD_REASON = /Couldn.?t find (?:this account|your Google Account)|Wrong password|password is incorrect|rejected the sign-in|doesn.?t exist|couldn.?t find an account|username may be incorrect/i;

const normalize = (email) => String(email ?? '').trim().toLowerCase();

// ── 1. The accounts that were run (optional) ──────────────────────────────────
let header = 'Email,Password';
const accounts = [];
const problems = [];
if (inputPath) {
  if (!fs.existsSync(inputPath)) {
    console.error(`ERROR: accounts CSV not found: ${inputPath}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(inputPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
  header = lines[0] ?? header;
  if (!/^\s*email\s*,\s*password\s*$/i.test(header)) {
    problems.push(`header is "${header}" — expected "Email,Password"`);
  }
  const seen = new Map();
  lines.slice(1).forEach((line, index) => {
    const rowNo = index + 2;
    if (!line.trim()) return;
    const fields = parseCsvLine(line);
    const [email = '', password = ''] = fields;
    if (fields.length !== 2) problems.push(`row ${rowNo}: ${fields.length} fields (expected 2) — a comma inside a password must be quoted`);
    if (!/^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(email.trim())) problems.push(`row ${rowNo}: "${email}" is not an email`);
    if (!password) problems.push(`row ${rowNo}: empty password for ${email}`);
    const key = normalize(email);
    if (seen.has(key)) {
      problems.push(`row ${rowNo}: duplicate of row ${seen.get(key)} (${key})`);
      return;
    }
    seen.set(key, rowNo);
    accounts.push({ email: key, line: line.replace(/\r$/, '') });
  });
}

// ── 2. Evidence: one observation per account per run ─────────────────────────
// order = when it happened (CSV timestamp, or the line position in an ascending log dump),
// used to pick the LATEST failure reason among equally good observations.
const observations = [];
const sources = [];

if (logFiles.length > 0) {
  let order = 0;
  for (const file of logFiles) {
    if (!fs.existsSync(file)) {
      console.error(`ERROR: logs file not found: ${file}`);
      process.exit(1);
    }
    let lines = 0;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const at = line.indexOf('[ADOBE_RESULT]');
      if (at === -1) continue;
      const fields = {};
      for (const match of line.slice(at).matchAll(/(\w+)=(?:"([^"]*)"|(\S*))/g)) {
        fields[match[1]] = match[2] ?? match[3] ?? '';
      }
      // The '@' guard skips Playwright echoing the reporter's source line in an error.
      if (!fields.email?.includes('@') || fields.status === 'skipped') continue;
      lines += 1;
      observations.push({
        email: normalize(fields.email),
        order: String(order++).padStart(12, '0'),
        loggedIn: fields.logged_in === 'yes',
        downloaded: fields.downloaded === 'yes',
        step: fields.step ?? '',
        reason: fields.reason ?? '',
        login_s: fields.login_s ?? '',
        editor_open_s: fields.editor_open_s ?? '',
        export_s: fields.export_s ?? '',
        editor_reloads: fields.editor_reloads ?? '',
      });
    }
    sources.push(`${file} (${lines} result lines)`);
  }
} else {
  const dir = 'reports';
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => /^adobe_results_.*\.csv$/.test(name)).sort().map((name) => path.join(dir, name))
    : [];
  for (const file of files) {
    const rows = parseCsv(fs.readFileSync(file, 'utf8'));
    const columns = rows.shift() ?? [];
    const col = (row, name) => (columns.includes(name) ? row[columns.indexOf(name)] ?? '' : undefined);
    for (const row of rows) {
      const email = normalize(col(row, 'email'));
      const status = col(row, 'test_status');
      if (!email.includes('@') || status === 'skipped') continue;
      // Older CSVs predate the downloaded/logged_in columns: fall back to what they had.
      const downloaded = col(row, 'downloaded') !== undefined
        ? col(row, 'downloaded') === 'yes'
        : Boolean(col(row, 'download_file'));
      const loggedIn = col(row, 'logged_in') !== undefined
        ? col(row, 'logged_in') === 'yes'
        : status === 'passed';
      observations.push({
        email,
        order: col(row, 'timestamp') ?? '',
        loggedIn: loggedIn || downloaded,
        downloaded,
        step: status === 'failed' ? col(row, 'failed_at_step') ?? '' : '',
        reason: status === 'failed' ? col(row, 'failure_reason') ?? '' : '',
        login_s: col(row, 'login_s') ?? '',
        editor_open_s: col(row, 'editor_open_s') ?? '',
        export_s: col(row, 'export_s') ?? '',
        editor_reloads: col(row, 'editor_reloads') ?? '',
      });
    }
  }
  sources.push(files.length > 0 ? `${files.length} local results CSV(s) in reports/` : 'none (no --logs and no reports/adobe_results_*.csv)');
}

// ── 3. Best observation per account ───────────────────────────────────────────
const rank = (obs) => (obs.downloaded ? 2 : obs.loggedIn ? 1 : 0);
const best = new Map();
for (const obs of observations) {
  const previous = best.get(obs.email);
  if (!previous || rank(obs) > rank(previous) || (rank(obs) === rank(previous) && obs.order >= previous.order)) {
    best.set(obs.email, obs);
  }
}

const resultOf = (obs) => (!obs ? RESULT.notRun : obs.downloaded ? RESULT.download : obs.loggedIn ? RESULT.loginOnly : RESULT.noLogin);

// Without an accounts CSV, report every account seen in the evidence.
const reportEmails = accounts.length > 0 ? accounts.map((account) => account.email) : [...best.keys()].sort();
const inputSet = new Set(reportEmails);
const notInInput = [...best.keys()].filter((email) => !inputSet.has(email));

const rows = reportEmails.map((email) => {
  const obs = best.get(email);
  const result = resultOf(obs);
  const failed = result !== RESULT.download && obs;
  return {
    email,
    result,
    logged_in: obs?.loggedIn || obs?.downloaded ? 'yes' : 'no',
    downloaded: obs?.downloaded ? 'yes' : 'no',
    last_failed_step: failed ? obs.step : '',
    last_failure_reason: failed ? obs.reason : '',
    credentials_rejected: failed && result === RESULT.noLogin && DEAD_REASON.test(obs.reason) ? 'yes' : 'no',
    login_s: obs?.login_s ?? '',
    editor_open_s: obs?.downloaded ? obs.editor_open_s : '',
    export_s: obs?.downloaded ? obs.export_s : '',
    editor_reloads: obs?.downloaded ? obs.editor_reloads : '',
  };
});

// ── 4. Write the report and the re-run CSVs ───────────────────────────────────
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const reportPath = `reports/run-report-${stamp}.csv`;
const columns = Object.keys(rows[0] ?? {
  email: '', result: '', logged_in: '', downloaded: '', last_failed_step: '', last_failure_reason: '',
  credentials_rejected: '', login_s: '', editor_open_s: '', export_s: '', editor_reloads: '',
});
fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync(reportPath, [columns.join(','), ...rows.map((row) => columns.map((name) => csvCell(row[name])).join(','))].join('\n') + '\n');

const missing = rows.filter((row) => row.result !== RESULT.download);
const dead = missing.filter((row) => row.credentials_rejected === 'yes');
const accountLine = new Map(accounts.map((account) => [account.email, account.line]));
const rerun = (includeDead ? missing : missing.filter((row) => row.credentials_rejected !== 'yes'))
  .filter((row) => accountLine.has(row.email));
fs.mkdirSync('tmp', { recursive: true });
if (accounts.length > 0) {
  fs.writeFileSync('tmp/missing-downloads.csv', [header, ...rerun.map((row) => accountLine.get(row.email))].join('\n') + '\n');
}
fs.writeFileSync('tmp/dead-accounts.csv', ['email,reason', ...dead.map((row) => `${row.email},${csvCell(row.last_failure_reason.slice(0, 200))}`)].join('\n') + '\n');

// ── 5. Summary ────────────────────────────────────────────────────────────────
const count = (result) => rows.filter((row) => row.result === result).length;
const pct = (n) => (rows.length ? `${((n * 100) / rows.length).toFixed(1)}%` : '-');
const line = '──────────────────────────────────────────────────────────────';
console.log(line);
if (inputPath) {
  console.log(`Accounts CSV:      ${inputPath} (${accounts.length} unique)`);
  if (problems.length > 0) {
    console.log(`  problems:        ${problems.length}`);
    for (const problem of problems.slice(0, 15)) console.log(`    - ${problem}`);
    if (problems.length > 15) console.log(`    ... and ${problems.length - 15} more`);
  }
}
console.log(`Evidence:          ${sources.join('; ')}`);
console.log('');
console.log(`  ${RESULT.download.padEnd(18)} ${String(count(RESULT.download)).padStart(7)}   ${pct(count(RESULT.download))}`);
console.log(`  ${RESULT.loginOnly.padEnd(18)} ${String(count(RESULT.loginOnly)).padStart(7)}   ${pct(count(RESULT.loginOnly))}`);
console.log(`  ${RESULT.noLogin.padEnd(18)} ${String(count(RESULT.noLogin)).padStart(7)}   ${pct(count(RESULT.noLogin))}${dead.length ? `   (${dead.length} with rejected credentials)` : ''}`);
if (accounts.length > 0) console.log(`  ${RESULT.notRun.padEnd(18)} ${String(count(RESULT.notRun)).padStart(7)}   ${pct(count(RESULT.notRun))}`);
console.log(`  ${'Total'.padEnd(18)} ${String(rows.length).padStart(7)}`);
if (notInInput.length > 0) console.log(`  (${notInInput.length} account(s) in the evidence are not in ${inputPath} — left out)`);

const downloads = rows.filter((row) => row.result === RESULT.download);
const timed = (name) => downloads.map((row) => Number.parseFloat(row[name])).filter(Number.isFinite);
if (timed('editor_open_s').length > 0) {
  console.log('');
  console.log(`Timing, accounts with a download (n=${downloads.length})`);
  console.log(`  ${''.padEnd(40)} ${'avg'.padStart(5)}  ${'p50'.padStart(5)}  ${'p90'.padStart(5)}`);
  for (const [label, name] of [
    ['login (start → dashboard)', 'login_s'],
    ['editor open (→ Download button)', 'editor_open_s'],
    ['export (→ PNG saved)', 'export_s'],
  ]) {
    const values = timed(name);
    if (values.length) console.log(`  ${label.padEnd(40)} ${stat(values, 'avg')}  ${stat(values, 0.5)}  ${stat(values, 0.9)}`);
  }
  const reloaded = downloads.filter((row) => Number(row.editor_reloads) > 0).length;
  console.log(`  needed an editor reload: ${reloaded} of ${downloads.length}`);
}

if (logFiles.length > 0 && observations.length === 0) {
  console.log('');
  console.log('WARNING: 0 [ADOBE_RESULT] lines parsed — check SINCE / JOB_PREFIX / PROJECT_ID.');
}

console.log('');
console.log(`Report:            ${reportPath}`);
if (accounts.length > 0) {
  console.log(`Re-run CSV:        tmp/missing-downloads.csv (${rerun.length} accounts${dead.length && !includeDead ? `; ${dead.length} with rejected credentials left out → tmp/dead-accounts.csv` : ''})`);
}
console.log(line);

function stat(values, which) {
  const sorted = [...values].sort((a, b) => a - b);
  const value = which === 'avg'
    ? sorted.reduce((sum, v) => sum + v, 0) / sorted.length
    : sorted[Math.min(sorted.length - 1, Math.floor(which * sorted.length))];
  return `${Math.round(value)}s`.padStart(5);
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseCsv(text) {
  return text.split(/\r?\n/).filter((row) => row.trim()).map(parseCsvLine);
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"' && line[index + 1] === '"') { current += '"'; index += 1; }
      else if (char === '"') inQuotes = false;
      else current += char;
    } else if (char === '"') inQuotes = true;
    else if (char === ',') { values.push(current); current = ''; }
    else current += char;
  }
  values.push(current);
  return values;
}
