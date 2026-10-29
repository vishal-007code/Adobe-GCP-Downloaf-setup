#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Run a "Cloud Run job" on this machine, as a pre-flight check before spending GCP credit.
#
# Each task runs the SAME script the container runs (scripts/run-cloud-batch.sh), with the
# same Cloud Run env vars, the cloud Playwright config (software GL, no GPU) and the same
# Google Chat notifications (scripts/run-notify.mjs). The accounts CSV and the status
# objects stay local instead of in GCS. Tasks run one after another (parallelism 1): two
# Playwright runs in one checkout would clean each other's test-results/.
#
# Usage:
#   bash scripts/run-local-job.sh                       # accounts.csv, 5 accounts per task
#   INPUT_CSV=tmp/some.csv TASK_SIZE=21 bash scripts/run-local-job.sh
#
# Afterwards it builds the per-account report from the tasks' logs, exactly as
# scripts/build-run-report.sh does from Cloud Logging.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ -f .env.local ]]; then
  set -a; . ./.env.local; set +a
fi

INPUT_CSV="${INPUT_CSV:-accounts.csv}"
TASK_SIZE="${TASK_SIZE:-5}"
RUN_ID="${RUN_ID:-local-$(date +%Y%m%d%H%M%S)}"
OUT_DIR="tmp/local-job-${RUN_ID}"

[[ -f "$INPUT_CSV" ]] || { echo "ERROR: input CSV not found: $INPUT_CSV"; exit 1; }
ROWS=$(tail -n +2 "$INPUT_CSV" | sed 's/\r$//' | grep -c '[^[:space:]]' || true)
[[ "$ROWS" -gt 0 ]] || { echo "ERROR: $INPUT_CSV has no account rows"; exit 1; }
TASK_COUNT=$(( (ROWS + TASK_SIZE - 1) / TASK_SIZE ))
mkdir -p "$OUT_DIR"

# What Cloud Run and run-batches.sh would set on the job.
export CLOUD_RUN_JOB="adobe-${RUN_ID}"
export CLOUD_RUN_EXECUTION="adobe-${RUN_ID}-exec"
export CLOUD_RUN_TASK_COUNT="$TASK_COUNT"
export ADOBE_ACCOUNTS_GCS_URI="$INPUT_CSV"
export ADOBE_REPORTS_GCS_URI="$OUT_DIR"
export ADOBE_REGION="${ADOBE_REGION:-local test}"
export ADOBE_PARALLELISM=1
export ADOBE_NOTIFY_THREAD="adobe-run-${RUN_ID}"
export ADOBE_PLAYWRIGHT_WORKERS="${ADOBE_PLAYWRIGHT_WORKERS:-1}"
export ADOBE_STOP_AFTER_LETS_GO="${ADOBE_STOP_AFTER_LETS_GO:-0}"
# The cloud has no consumed ledger; locally, ignore it so every account in the CSV runs.
export ADOBE_IGNORE_CONSUMED=1
export PLAYWRIGHT_HTML_OPEN=never

log() { echo "[LOCAL-JOB][$(date +%H:%M:%S)] $*"; }

if [[ -n "${GOOGLE_CHAT_WEBHOOK_URL:-}" ]]; then
  GOOGLE_CHAT_MESSAGE="🧪 *Local test run triggered* (same task script as Cloud Run, on this machine)
👤 ${ROWS} accounts · 🧩 ${TASK_COUNT} tasks (${TASK_SIZE} accounts each), one at a time
🎯 $([[ "$ADOBE_STOP_AFTER_LETS_GO" == "1" ]] && echo "Activation only (login)" || echo "Login + Download")
🆔 run ${RUN_ID}
Updates follow in this thread; problems and the final summary post as new messages." \
  GOOGLE_CHAT_THREAD_KEY="$ADOBE_NOTIFY_THREAD" \
  node scripts/send-google-chat-update.mjs >/dev/null 2>&1 || log "Chat post failed (continuing)"
else
  log "GOOGLE_CHAT_WEBHOOK_URL not set — running without Chat notifications"
fi

log "${ROWS} accounts → ${TASK_COUNT} tasks of up to ${TASK_SIZE}; output in ${OUT_DIR}"
for (( i = 0; i < TASK_COUNT; i++ )); do
  log "task $((i + 1))/${TASK_COUNT} starting"
  if CLOUD_RUN_TASK_INDEX="$i" ADOBE_RUN_ID="${RUN_ID}-task-${i}" \
       bash scripts/run-cloud-batch.sh > "${OUT_DIR}/task-${i}.log" 2>&1; then
    log "task $((i + 1))/${TASK_COUNT} done"
  else
    log "task $((i + 1))/${TASK_COUNT} exited with $? (see ${OUT_DIR}/task-${i}.log)"
  fi
  grep -h '\[ADOBE_TASK_SUMMARY\]' "${OUT_DIR}/task-${i}.log" | tail -1 || true
done

# The same report build-run-report.sh produces from Cloud Logging, from the tasks' logs.
cat "${OUT_DIR}"/task-*.log > "${OUT_DIR}/all-tasks.log"
node scripts/build-run-report.mjs "$INPUT_CSV" --logs="${OUT_DIR}/all-tasks.log"
