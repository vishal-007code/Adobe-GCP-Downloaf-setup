#!/usr/bin/env bash
# Launch parallel Cloud Run job batches using a pre-built image.
# Requires: IMAGE_URI from scripts/setup-run.sh
# Does NOT build Docker image or touch IAM/bucket setup — that is setup-run.sh's job.
#
# Usage:
#   IMAGE_URI=<uri> bash scripts/run-batches.sh
#
# Example:
#   export IMAGE_URI=asia-south1-docker.pkg.dev/project-8606ec18-5b16-4826-af3/playwright-jobs/adobe-login-flow:20260622120000
#   export INPUT_CSV=accounts.csv
#   export TOTAL_ACCOUNTS=20578
#   bash scripts/run-batches.sh
set -euo pipefail

# Pick up GOOGLE_CHAT_WEBHOOK_URL (and anything else local) without baking secrets
# into the repo. .env.local is git-ignored; skipped silently when absent.
if [[ -f .env.local ]]; then
  set -a; . ./.env.local; set +a
fi

: "${IMAGE_URI:?IMAGE_URI is required. Run scripts/setup-run.sh first and copy the printed IMAGE_URI.}"

PROJECT_ID="${PROJECT_ID:-project-8606ec18-5b16-4826-af3}"
REGION="${REGION:-asia-south1}"
RUNTIME_SERVICE_ACCOUNT="${RUNTIME_SERVICE_ACCOUNT:-playwright-runner@${PROJECT_ID}.iam.gserviceaccount.com}"
ACCOUNTS_BUCKET="${ACCOUNTS_BUCKET:-${PROJECT_ID}-adobe-accounts}"
REPORTS_BUCKET="${REPORTS_BUCKET:-${ACCOUNTS_BUCKET}}"

INPUT_CSV="${INPUT_CSV:-accounts.csv}"
# Empty by default -> auto-detected from INPUT_CSV's row count below, so you can
# upload any accounts.csv (any size) and run without passing a number.
TOTAL_ACCOUNTS="${TOTAL_ACCOUNTS:-}"
# One job by default (BATCH_SIZE >= TOTAL_ACCOUNTS). The asia-south1 quota is small
# (20 vCPU / 40 GiB total per region), so launching several jobs in parallel just
# fights that shared cap at runtime. A single job uses the quota cleanly.
# Empty by default -> set to TOTAL_ACCOUNTS below (one job covering all accounts).
BATCH_SIZE="${BATCH_SIZE:-}"

CPU="${CPU:-2}"
MEMORY="${MEMORY:-8Gi}"
# Concurrent tasks per job. A job's deploy must satisfy PARALLELISM x {CPU, MEMORY}
# within the regional quota: 20 vCPU and 40 GiB total in asia-south1.
#   PARALLELISM=4 x CPU=2   = 8 vCPU    (<= 20)
#   PARALLELISM=4 x MEMORY=8Gi = 32 GiB (<= 40)   -> free-tier quota, with headroom.
# Throughput ~= PARALLELISM x WORKERS accounts in flight. The ~3.5 min dashboard
# dwell leaves the CPU mostly idle, so WORKERS can safely exceed CPU (oversubscribe).
# 8 x 4 = ~32 accounts in flight at ~6 min/account -> ~30300 done in ~4 days (~Fri).
# Going faster needs a Cloud Run CPU/Memory quota increase for the region.
PARALLELISM="${PARALLELISM:-4}"
# Workers per task. 4 oversubscribes 2 vCPU (fine during the idle dwell); if logins
# start failing/timing out under load, drop to 3 (gentler, ~a day slower).
ADOBE_PLAYWRIGHT_WORKERS="${ADOBE_PLAYWRIGHT_WORKERS:-2}"
ADOBE_SCRIPT_ACCOUNT_LIMIT="${ADOBE_SCRIPT_ACCOUNT_LIMIT:-21}"
ADOBE_STOP_AFTER_LOGIN="${ADOBE_STOP_AFTER_LOGIN:-1}"
ADOBE_STOP_AFTER_LETS_GO="${ADOBE_STOP_AFTER_LETS_GO:-0}"
ADOBE_LETS_GO_APPEAR_TIMEOUT_MS="${ADOBE_LETS_GO_APPEAR_TIMEOUT_MS:-60000}"
ADOBE_STRICT_LETS_GO="${ADOBE_STRICT_LETS_GO:-1}"
ADOBE_VIDEO_MODE="${ADOBE_VIDEO_MODE:-off}"
ADOBE_DEBUG_ARTIFACTS="${ADOBE_DEBUG_ARTIFACTS:-0}"
SAVE_ARTIFACTS="${SAVE_ARTIFACTS:-false}"
# PNGs are not kept by default (off): each download is recorded as downloaded=yes in the
# account's [ADOBE_RESULT] log line, and `bash scripts/build-run-report.sh` turns those
# into the per-account report. Set DOWNLOADS_GCS_URI=gs://${REPORTS_BUCKET}/downloads to
# also upload every PNG as <email>.png.
DOWNLOADS_GCS_URI="${DOWNLOADS_GCS_URI:-off}"
# Re-run a failed account once (fresh login) inside the same task before giving up on it.
ADOBE_TEST_RETRIES="${ADOBE_TEST_RETRIES:-1}"
TASK_TIMEOUT="${TASK_TIMEOUT:-8h}"
BASE_JOB_NAME="${BASE_JOB_NAME:-adobe-login-flow}"

# Overridable so two regions launched at the same second get distinct GCS object
# paths (accounts/${RUN_ID}/...) and report prefixes. Defaults to a timestamp.
RUN_ID="${RUN_ID:-$(date +%Y%m%d%H%M%S)}"
BATCH_DIR="tmp/batches-${RUN_ID}"
LOG_DIR="tmp/batch-logs-${RUN_ID}"

mkdir -p "$BATCH_DIR" "$LOG_DIR"

log() { echo "[BATCHES][$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# Push a Chat message. Best-effort: a webhook hiccup must NEVER abort a multi-day
# run, and a missing webhook is simply a no-op (the sender exits 0 when unset).
# The launcher posts only the trigger and launcher-side failures. Started / progress /
# alerts / final summary come from the tasks themselves (scripts/run-notify.mjs), so
# they arrive even when this launcher is closed or the laptop sleeps.
#   notify       → reply in the run's thread (one thread per run, shared with the tasks)
#   notify_alert → new top-level message, so it notifies
GOOGLE_CHAT_THREAD_KEY="${GOOGLE_CHAT_THREAD_KEY:-adobe-run-${RUN_ID:-$(date -u +%Y%m%d)}}"
notify() {
  [[ -n "${GOOGLE_CHAT_WEBHOOK_URL:-}" ]] || return 0
  GOOGLE_CHAT_WEBHOOK_URL="$GOOGLE_CHAT_WEBHOOK_URL" \
  GOOGLE_CHAT_MESSAGE="$1" \
  GOOGLE_CHAT_THREAD_KEY="$GOOGLE_CHAT_THREAD_KEY" \
  node scripts/send-google-chat-update.mjs >/dev/null 2>&1 || true
}
notify_alert() {
  [[ -n "${GOOGLE_CHAT_WEBHOOK_URL:-}" ]] || return 0
  GOOGLE_CHAT_WEBHOOK_URL="$GOOGLE_CHAT_WEBHOOK_URL" \
  GOOGLE_CHAT_MESSAGE="$1" \
  node scripts/send-google-chat-update.mjs >/dev/null 2>&1 || true
}

# ── Auto-detect account count ─────────────────────────────────────────────────
# Upload any accounts.csv and run — no need to pass TOTAL_ACCOUNTS. When it isn't
# set, count the non-empty data rows in INPUT_CSV (excludes the header; tolerant
# of CRLF endings and a missing trailing newline). BATCH_SIZE then defaults to
# the full count so the whole list runs as ONE Cloud Run job.
if [[ ! -f "$INPUT_CSV" ]]; then
  echo "ERROR: input CSV not found: $INPUT_CSV"
  exit 1
fi
if [[ -z "${TOTAL_ACCOUNTS}" ]]; then
  TOTAL_ACCOUNTS=$(tail -n +2 "$INPUT_CSV" | sed 's/\r$//' | grep -c '[^[:space:]]' || true)
  log "Auto-detected TOTAL_ACCOUNTS=${TOTAL_ACCOUNTS} from ${INPUT_CSV}"
fi
if [[ "${TOTAL_ACCOUNTS:-0}" -le 0 ]]; then
  echo "ERROR: ${INPUT_CSV} has no account rows (after the header)."
  exit 1
fi
BATCH_SIZE="${BATCH_SIZE:-$TOTAL_ACCOUNTS}"

# ── Pre-flight: Cloud Run CPU quota check (set CHECK_QUOTA=1 to enable) ────────
# This run needs ~(num batches x PARALLELISM x WORKERS x CPU) CPUs concurrently
# in ${REGION}. If that exceeds your "Total CPU allocation" limit, jobs queue or
# fail to scale. Run the command below (or set CHECK_QUOTA=1) before launching.
if [[ "${CHECK_QUOTA:-0}" == "1" ]]; then
  num_batches=$(( (TOTAL_ACCOUNTS + BATCH_SIZE - 1) / BATCH_SIZE ))
  needed_cpus=$(( num_batches * PARALLELISM * ADOBE_PLAYWRIGHT_WORKERS * CPU ))
  log "Estimated peak CPUs needed in ${REGION}: ${needed_cpus}"
  log "Current Cloud Run CPU quota in ${REGION}:"
  gcloud beta quotas info list \
    --service=run.googleapis.com \
    --project="${PROJECT_ID}" \
    --format="value(quotaId,dimensionsInfos.details.value)" 2>/dev/null \
    | grep -i cpu || log "  (could not read quota — check the console link in the script comments)"
fi

if [[ ! -f "$INPUT_CSV" ]]; then
  echo "ERROR: input CSV not found: $INPUT_CSV"
  exit 1
fi

HEADER="$(head -n 1 "$INPUT_CSV")"

log "============================================================"
log "Adobe Playwright — Batch Run"
log "Project:       ${PROJECT_ID}"
log "Image:         ${IMAGE_URI}"
log "Input CSV:     ${INPUT_CSV}"
log "Total accounts: ${TOTAL_ACCOUNTS}"
log "Batch size:    ${BATCH_SIZE}"
log "CPU/Memory:    ${CPU} / ${MEMORY}"
log "Parallelism:   ${PARALLELISM} (tasks running at once per job)"
log "Workers:       ${ADOBE_PLAYWRIGHT_WORKERS}"
log "Acct limit:    ${ADOBE_SCRIPT_ACCOUNT_LIMIT}"
log "Stop after login: ${ADOBE_STOP_AFTER_LOGIN}"
log "PNG uploads:   ${DOWNLOADS_GCS_URI} (off = downloads recorded in the logs only)"
log "Test retries:  ${ADOBE_TEST_RETRIES}"
log "Save reports:  ${SAVE_ARTIFACTS} (CSV/HTML reports only; false = logs only)"
log "============================================================"

# Rough duration: waves of PARALLELISM tasks, each task ADOBE_SCRIPT_ACCOUNT_LIMIT accounts
# shared by its workers, at SECONDS_PER_ACCOUNT (~230s measured for the download flow on
# 2 vCPU per browser; login-only is ~90s).
SECONDS_PER_ACCOUNT="${SECONDS_PER_ACCOUNT:-$([[ "$ADOBE_STOP_AFTER_LETS_GO" == "1" ]] && echo 90 || echo 230)}"
total_tasks=$(( (TOTAL_ACCOUNTS + ADOBE_SCRIPT_ACCOUNT_LIMIT - 1) / ADOBE_SCRIPT_ACCOUNT_LIMIT ))
est_min=$(( ( (total_tasks + PARALLELISM - 1) / PARALLELISM ) * ( (ADOBE_SCRIPT_ACCOUNT_LIMIT + ADOBE_PLAYWRIGHT_WORKERS - 1) / ADOBE_PLAYWRIGHT_WORKERS ) * SECONDS_PER_ACCOUNT / 60 ))
notify "🚀 *Adobe run triggered* — ${REGION}
👤 ${TOTAL_ACCOUNTS} accounts · 🧩 ${total_tasks} tasks (${ADOBE_SCRIPT_ACCOUNT_LIMIT} accounts each)
🎯 $([[ "$ADOBE_STOP_AFTER_LETS_GO" == "1" ]] && echo "Activation only (login)" || echo "Login + Download")
⚙️ ${PARALLELISM} tasks at a time × ${ADOBE_PLAYWRIGHT_WORKERS} browser(s) · ${CPU} vCPU / ${MEMORY} per task
⏳ rough estimate ~$(( est_min / 60 ))h $(( est_min % 60 ))m
🖼️ image ${IMAGE_URI##*/}
🆔 run ${RUN_ID}
Updates for this run follow in this thread; problems and the final summary post as new messages."

# ── Split CSV into batches ────────────────────────────────────────────────────
log "Splitting CSV into batches..."
tail -n +2 "$INPUT_CSV" | head -n "$TOTAL_ACCOUNTS" | \
  split -l "$BATCH_SIZE" -d -a 2 - "$BATCH_DIR/accounts-part-"

BATCH_FILES=()
for part in "$BATCH_DIR"/accounts-part-*; do
  [[ -f "$part" ]] || continue
  batch_num="$(basename "$part" | sed 's/accounts-part-//')"
  batch_csv="$BATCH_DIR/accounts-batch-${batch_num}.csv"
  { echo "$HEADER"; cat "$part"; } > "$batch_csv"
  rm -f "$part"
  BATCH_FILES+=("$batch_csv")
done

log "Created ${#BATCH_FILES[@]} batch files:"
printf '  %s\n' "${BATCH_FILES[@]}"

# ── Launch batches in parallel ────────────────────────────────────────────────
log "Launching ${#BATCH_FILES[@]} batches in parallel..."

pids=()
i=0

for batch_csv in "${BATCH_FILES[@]}"; do
  i=$((i + 1))
  batch_label="$(printf 'batch-%02d' "$i")"
  job_name="${BASE_JOB_NAME}-${batch_label}"
  batch_rows=$(( $(wc -l < "$batch_csv") - 1 ))
  tasks=$(( (batch_rows + ADOBE_SCRIPT_ACCOUNT_LIMIT - 1) / ADOBE_SCRIPT_ACCOUNT_LIMIT ))
  object_name="accounts/${RUN_ID}/${batch_label}.csv"
  reports_prefix="adobe-runs/${RUN_ID}/${batch_label}"
  accounts_gcs_uri="gs://${ACCOUNTS_BUCKET}/${object_name}"
  reports_gcs_uri="gs://${REPORTS_BUCKET}/${reports_prefix}"

  log "  $batch_label: rows=$batch_rows, tasks=$tasks, job=$job_name"

  (
    step() { echo "[${batch_label}][$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

    step "Uploading CSV to ${accounts_gcs_uri}..."
    gcloud storage cp "$batch_csv" "$accounts_gcs_uri" --project="${PROJECT_ID}"

    step "Deploying Cloud Run job ${job_name}..."
    gcloud run jobs deploy "${job_name}" \
      --image="${IMAGE_URI}" \
      --region="${REGION}" \
      --project="${PROJECT_ID}" \
      --service-account="${RUNTIME_SERVICE_ACCOUNT}" \
      --tasks="${tasks}" \
      --parallelism="${PARALLELISM}" \
      --max-retries=0 \
      --task-timeout="${TASK_TIMEOUT}" \
      --cpu="${CPU}" \
      --memory="${MEMORY}" \
      --set-env-vars="CI=1,\
ADOBE_ACCOUNTS_CSV=/tmp/accounts.csv,\
ADOBE_ACCOUNTS_GCS_URI=${accounts_gcs_uri},\
ADOBE_REPORTS_GCS_URI=${reports_gcs_uri},\
ADOBE_PLAYWRIGHT_WORKERS=${ADOBE_PLAYWRIGHT_WORKERS},\
ADOBE_STOP_AFTER_LOGIN=${ADOBE_STOP_AFTER_LOGIN},\
ADOBE_STOP_AFTER_LETS_GO=${ADOBE_STOP_AFTER_LETS_GO},\
ADOBE_SCRIPT_ACCOUNT_LIMIT=${ADOBE_SCRIPT_ACCOUNT_LIMIT},\
ADOBE_LETS_GO_APPEAR_TIMEOUT_MS=${ADOBE_LETS_GO_APPEAR_TIMEOUT_MS},\
ADOBE_STRICT_LETS_GO=${ADOBE_STRICT_LETS_GO},\
ADOBE_VIDEO_MODE=${ADOBE_VIDEO_MODE},\
ADOBE_DEBUG_ARTIFACTS=${ADOBE_DEBUG_ARTIFACTS},\
ADOBE_DOWNLOADS_GCS_URI=${DOWNLOADS_GCS_URI},\
ADOBE_TEST_RETRIES=${ADOBE_TEST_RETRIES},\
ADOBE_REGION=${REGION},\
ADOBE_PARALLELISM=${PARALLELISM},\
ADOBE_NOTIFY_THREAD=${GOOGLE_CHAT_THREAD_KEY},\
GOOGLE_CHAT_WEBHOOK_URL=${GOOGLE_CHAT_WEBHOOK_URL:-},\
SAVE_ARTIFACTS=${SAVE_ARTIFACTS}"

    notify "▶️ *${batch_label} launched* — ${REGION}
📊 ${batch_rows} accounts across ${tasks} tasks
🆔 job ${job_name} — waiting for the first task to start"

    step "Executing ${job_name} (waiting for completion)..."
    started_at=$(date -u +%s)
    if gcloud run jobs execute "${job_name}" \
      --region="${REGION}" \
      --project="${PROJECT_ID}" \
      --wait
    then
      # The tasks post the final summary themselves (run-notify.mjs).
      step "Done in $(( ($(date -u +%s) - started_at) / 60 ))m."
    else
      notify_alert "❌ *${batch_label} execution FAILED* — ${REGION}
🆔 job ${job_name} after $(( ($(date -u +%s) - started_at) / 60 ))m
Some tasks crashed, timed out or were never scheduled (quota?). Check:
\`gcloud run jobs executions list --job=${job_name} --region=${REGION}\`"
      step "FAILED."
      exit 1
    fi
  ) > "$LOG_DIR/${batch_label}.log" 2>&1 &

  pids+=("$!")
done

log "All batches started. Waiting..."
log "Monitor with:"
log "  tail -f $LOG_DIR/batch-01.log"
log "  gcloud run jobs list --region=${REGION} --project=${PROJECT_ID}"

# ── Wait for all batches ──────────────────────────────────────────────────────
failed=0
for idx in "${!pids[@]}"; do
  pid="${pids[$idx]}"
  batch_no=$((idx + 1))
  batch_label="$(printf 'batch-%02d' "$batch_no")"
  if wait "$pid"; then
    log "$batch_label completed successfully."
  else
    log "$batch_label FAILED — check $LOG_DIR/${batch_label}.log"
    failed=1
  fi
done

echo
log "Logs:       $LOG_DIR"
log "Batch CSVs: $BATCH_DIR"

if [[ "$failed" -ne 0 ]]; then
  notify "⚠️ *Adobe run finished with failures* — ${REGION}
🆔 run ${RUN_ID} — ${#BATCH_FILES[@]} batch(es), at least one failed.
Logs: ${LOG_DIR}"
  echo
  echo "One or more batches failed. Debug:"
  for i in $(seq 1 "${#BATCH_FILES[@]}"); do
    echo "  tail -n 50 $LOG_DIR/$(printf 'batch-%02d' "$i").log"
  done
  exit 1
fi

log "All batches finished; the tasks posted their final summary to Chat."

log "All batches completed successfully."
