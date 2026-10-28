#!/usr/bin/env node
// Google Chat updates sent from INSIDE the Cloud Run tasks, so a run reports its own start,
// progress, problems and end — nobody has to keep the launcher open or read the logs.
//
//   node scripts/run-notify.mjs start <accounts.csv>                   task 0: "tasks started"
//   node scripts/run-notify.mjs task-end <playwright.log> <exit> <n>   every task, at its end
//   node scripts/run-notify.mjs setup-failed "<what failed>"           task died before Playwright
//
// Message volume stays small however many tasks a run has (often 1,000+):
//   - progress: one update each time another 10% of the tasks has finished (run thread)
//   - alerts:   each kind (crash, logins failing, downloads failing, setup failure) is posted
//               once per execution, by the first task that hits it (top-level, so it notifies)
//   - final:    one summary when the last task finishes (top-level)
// Tasks coordinate through small objects under ADOBE_STATUS_URI (gs://… on Cloud Run, a
// plain directory for local testing):
//   tasks/<index>.json   each finished task's tally
//   sent/<marker>        created only-if-absent, so exactly one task posts each message
// The last task to finish always sees every tally, because it lists after its own write.
//
// Env: GOOGLE_CHAT_WEBHOOK_URL (unset = do nothing), ADOBE_STATUS_URI, ADOBE_NOTIFY_THREAD,
// ADOBE_REGION, ADOBE_PARALLELISM, ADOBE_STOP_AFTER_LETS_GO, CLOUD_RUN_* (set by Cloud Run).
// ADOBE_NOTIFY_DRY_RUN=1 prints the messages instead of posting them.
// Best-effort throughout: it always exits 0, so a Chat or storage hiccup never fails a task.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const env = process.env;
const webhook = env.GOOGLE_CHAT_WEBHOOK_URL?.trim();
const dryRun = env.ADOBE_NOTIFY_DRY_RUN === '1';
const statusUri = env.ADOBE_STATUS_URI?.trim().replace(/[\\/]+$/, '');
const job = env.CLOUD_RUN_JOB || 'local-job';
const execution = env.CLOUD_RUN_EXECUTION || 'local';
const taskIndex = Number(env.CLOUD_RUN_TASK_INDEX ?? 0);
const taskCount = Number(env.CLOUD_RUN_TASK_COUNT ?? 1);
const region = env.ADOBE_REGION?.trim() ?? '';
const thread = env.ADOBE_NOTIFY_THREAD?.trim() || `adobe-${execution}`;
const downloadMode = env.ADOBE_STOP_AFTER_LETS_GO?.trim() !== '1';
const where = `\`${job}\`${region ? ` (${region})` : ''}`;

const [command, ...args] = process.argv.slice(2);

try {
  if (!webhook && !dryRun) process.exit(0);
  if (command === 'start') await onStart(args[0]);
  else if (command === 'task-end') await onTaskEnd(args[0], Number(args[1] ?? 0), Number(args[2] ?? 0));
  else if (command === 'setup-failed') await onSetupFailed(args.join(' '));
  else console.log(`run-notify: unknown command "${command}"`);
} catch (error) {
  console.log(`run-notify: ${error instanceof Error ? error.message : error}`);
}
process.exit(0);

// ── Commands ──────────────────────────────────────────────────────────────────

async function onStart(accountsCsv) {
  if (taskIndex !== 0) return;
  writeOnce('start.json', JSON.stringify({ at: Date.now() }));
  const accounts = countCsvRows(accountsCsv);
  await post([
    `▶️ *Tasks started* — ${where}`,
    `🧩 ${taskCount} tasks${env.ADOBE_PARALLELISM ? `, ${env.ADOBE_PARALLELISM} at a time` : ''}` +
      `${accounts ? ` · 👤 ${accounts} accounts` : ''}`,
    `🎯 ${downloadMode ? 'Login + Download' : 'Activation only (login)'}`,
    `🕒 ${ist(Date.now())}`,
  ], { thread });
}

async function onSetupFailed(what) {
  // Count the task as finished, or the final summary would wait for it forever.
  recordTally({ task: taskIndex, accounts: 0, attempted: 0, login_ok: 0, login_fail: 0, downloaded: 0, crashed: true, setup_failed: true, at: Date.now() });
  await alertOnce('setup-failed', [
    `🚨 *Task failed before testing started* — ${where}`,
    `Task ${taskIndex + 1}/${taskCount}: ${what.slice(0, 300)}`,
    'Its accounts have no result (they show as *Not run* in the report).',
  ]);
  await progressOrFinal();
}

async function onTaskEnd(logFile, exitCode, accountsInTask) {
  const log = logFile && fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const summaryLine = log.match(/\[ADOBE_TASK_SUMMARY\][^\n]*/g)?.pop() ?? '';
  const num = (key) => Number(summaryLine.match(new RegExp(`\\b${key}=(\\d+)`))?.[1] ?? 0);
  const crashed = accountsInTask > 0 && !summaryLine;
  const tally = {
    task: taskIndex,
    accounts: accountsInTask,
    attempted: num('attempted'),
    login_ok: num('login_ok'),
    login_fail: num('login_fail'),
    downloaded: num('downloaded'),
    crashed,
    at: Date.now(),
  };
  recordTally(tally);

  const failure = topFailure(log);
  const because = failure ? `Most common: *${failure.step || '?'}* — ${failure.reason.slice(0, 160)} (${failure.count}×)` : '';
  if (crashed) {
    const lastLine = log.trim().split(/\r?\n/).filter(Boolean).pop() ?? '(no output)';
    await alertOnce('crash', [
      `🚨 *Task crashed* — ${where}`,
      `Task ${taskIndex + 1}/${taskCount} ended without a results summary (exit ${exitCode}). Its ${accountsInTask} accounts have no result.`,
      `Last log line: ${lastLine.slice(0, 200)}`,
    ]);
  } else if (tally.attempted >= 3 && tally.login_ok === 0) {
    await alertOnce('logins-failing', [
      `🚨 *Logins failing* — ${where}`,
      `Task ${taskIndex + 1}/${taskCount}: 0 of ${tally.attempted} accounts logged in. Possible captcha/block, or bad passwords.`,
      because,
    ]);
  } else if (downloadMode && tally.login_ok >= 3 && tally.downloaded === 0) {
    await alertOnce('downloads-failing', [
      `🚨 *Downloads failing* — ${where}`,
      `Task ${taskIndex + 1}/${taskCount}: ${tally.login_ok} logged in but 0 downloaded — the editor is not opening or exporting.`,
      because,
    ]);
  }

  await progressOrFinal();
}

// ── Progress and final summary ────────────────────────────────────────────────

async function progressOrFinal() {
  const done = list('tasks').filter((name) => name.endsWith('.json')).length;
  if (done === 0) return;

  if (done >= taskCount) {
    if (!writeOnce('sent/final', String(Date.now()))) return;
    const totals = aggregate();
    await post([
      `🏁 *Run finished* — ${where}`,
      `🧩 ${taskCount} tasks${totals.crashed ? ` (⚠️ ${totals.crashed} crashed)` : ''} · ⏱️ ${duration(totals.elapsedMs)}`,
      ...outcomeLines(totals),
      totals.startedAt
        ? `📄 Per-account report: \`SINCE=${new Date(totals.startedAt - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')} bash scripts/build-run-report.sh\``
        : '📄 Per-account report: `bash scripts/build-run-report.sh`',
    ]);
    return;
  }

  const step = Math.max(1, Math.ceil(taskCount / 10));
  const milestone = Math.floor(done / step);
  if (milestone < 1 || !writeOnce(`sent/progress-${milestone}`, String(Date.now()))) return;
  const totals = aggregate();
  const etaMs = totals.elapsedMs ? (totals.elapsedMs * (taskCount - done)) / done : 0;
  await post([
    `📊 *Progress* — ${where} · ${ist(Date.now())}`,
    `🧩 Tasks: ${done}/${taskCount} (${Math.round((done * 100) / taskCount)}%)` +
      `${totals.elapsedMs ? ` · ⏱️ ${duration(totals.elapsedMs)} elapsed, ~${duration(etaMs)} left` : ''}`,
    ...outcomeLines(totals),
    totals.attempted >= 20 && totals.login_ok / totals.attempted < 0.5
      ? `⚠️ Login rate is only ${pct(totals.login_ok, totals.attempted)} — check for captcha/blocks.`
      : '',
  ], { thread });
}

function outcomeLines(t) {
  const lines = [`👤 Accounts done: ${t.attempted}${t.missing ? ` (+${t.missing} with no result)` : ''}`];
  if (downloadMode) {
    lines.push(`✅ Login + Download: *${t.downloaded}* (${pct(t.downloaded, t.attempted)})`);
    lines.push(`🔑 Login only: ${t.login_ok - t.downloaded}`);
  } else {
    lines.push(`✅ Logged in: *${t.login_ok}* (${pct(t.login_ok, t.attempted)})`);
  }
  lines.push(`❌ Login failed: ${t.login_fail}`);
  return lines;
}

function aggregate() {
  const tallies = readAll('tasks');
  const start = readText('start.json');
  const startedAt = start ? JSON.parse(start).at : 0;
  const t = { attempted: 0, login_ok: 0, login_fail: 0, downloaded: 0, crashed: 0, missing: 0, startedAt, elapsedMs: 0 };
  for (const tally of tallies) {
    t.attempted += tally.attempted;
    t.login_ok += tally.login_ok;
    t.login_fail += tally.login_fail;
    t.downloaded += tally.downloaded;
    if (tally.crashed) { t.crashed += 1; t.missing += tally.accounts; }
  }
  t.elapsedMs = startedAt ? Date.now() - startedAt : 0;
  return t;
}

/** The most common failure (step + reason) among this task's [ADOBE_RESULT] lines. */
function topFailure(log) {
  const counts = new Map();
  for (const match of log.matchAll(/\[ADOBE_RESULT\] status=failed [^\n]*?step="([^"]*)" reason="([^"]*)"/g)) {
    const key = `${match[1]}\u0000${match[2].replace(/\d{3,}/g, 'N')}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const [key, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!key) return undefined;
  const [step, reason] = key.split('\u0000');
  return { step, reason, count };
}

// ── Chat ──────────────────────────────────────────────────────────────────────

async function alertOnce(kind, lines) {
  if (!writeOnce(`sent/alert-${kind}`, String(Date.now()))) return;
  await post([...lines, '_Only the first task with this problem posts; the final summary counts them all._']);
}

/** Post to the space. With `thread`, as a reply in the run's thread; without, as a new
 *  top-level message (alerts and the final summary — the ones that should notify). */
async function post(lines, { thread: threadKey } = {}) {
  const text = lines.filter(Boolean).join('\n');
  if (dryRun) {
    console.log(`── chat${threadKey ? ` [thread ${threadKey}]` : ' [top-level]'} ──\n${text}`);
    return;
  }
  const url = new URL(webhook);
  const payload = { text };
  if (threadKey) {
    url.searchParams.set('messageReplyOption', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
    payload.thread = { threadKey };
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return;
      console.log(`run-notify: Chat returned ${response.status} (attempt ${attempt}/3)`);
    } catch (error) {
      console.log(`run-notify: Chat post failed (attempt ${attempt}/3): ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 3_000));
  }
}

// ── Status storage: gs:// via gcloud, or a local directory ────────────────────

function recordTally(tally) {
  if (!writeOnce(`tasks/${String(taskIndex).padStart(5, '0')}.json`, JSON.stringify(tally))) {
    console.log('run-notify: could not record this task\'s tally (already recorded, or storage error)');
  }
}

/** Create `rel` only if it does not exist yet. True = this call created it. */
function writeOnce(rel, content) {
  if (!statusUri) return true;
  if (!statusUri.startsWith('gs://')) {
    const target = path.join(statusUri, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.writeFileSync(target, content, { flag: 'wx' });
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') console.log(`run-notify: write ${rel}: ${error.message}`);
      return false;
    }
  }
  const tmp = path.join(os.tmpdir(), `run-notify-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, content);
  // --if-generation-match=0: the copy succeeds only when the object does not exist yet.
  const result = gcloud(['storage', 'cp', '--if-generation-match=0', tmp, `${statusUri}/${rel}`]);
  fs.rmSync(tmp, { force: true });
  if (result.status !== 0 && !/precondition|412/i.test(result.stderr)) {
    console.log(`run-notify: write ${rel}: ${result.stderr.trim().split('\n').pop()}`);
  }
  return result.status === 0;
}

function list(relDir) {
  if (!statusUri) return [];
  if (!statusUri.startsWith('gs://')) {
    const dir = path.join(statusUri, relDir);
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  }
  const result = gcloud(['storage', 'ls', `${statusUri}/${relDir}/`]);
  return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split('/').pop()) : [];
}

function readAll(relDir) {
  if (!statusUri) return [];
  const text = statusUri.startsWith('gs://')
    ? gcloud(['storage', 'cat', `${statusUri}/${relDir}/*.json`]).stdout
    : list(relDir).map((name) => fs.readFileSync(path.join(statusUri, relDir, name), 'utf8')).join('\n');
  // Each tally is one JSON object; `storage cat` concatenates them.
  return [...text.matchAll(/\{[^{}]*\}/g)].map((match) => JSON.parse(match[0]));
}

function readText(rel) {
  if (!statusUri) return '';
  if (!statusUri.startsWith('gs://')) {
    const file = path.join(statusUri, rel);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  }
  const result = gcloud(['storage', 'cat', `${statusUri}/${rel}`]);
  return result.status === 0 ? result.stdout : '';
}

function gcloud(gcloudArgs) {
  const result = spawnSync('gcloud', gcloudArgs, { encoding: 'utf8', timeout: 120_000 });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? String(result.error ?? '') };
}

// ── Formatting ────────────────────────────────────────────────────────────────

function countCsvRows(file) {
  if (!file || !fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(1).filter((line) => line.trim()).length;
}

function pct(part, whole) {
  return whole ? `${Math.round((part * 100) / whole)}%` : '-';
}

function duration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function ist(ms) {
  return `${new Date(ms).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  })} IST`;
}
