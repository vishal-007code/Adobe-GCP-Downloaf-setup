#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-project-8606ec18-5b16-4826-af3}"
REGION="${REGION:-asia-south1}"
RUNTIME_SERVICE_ACCOUNT="${RUNTIME_SERVICE_ACCOUNT:-playwright-runner@${PROJECT_ID}.iam.gserviceaccount.com}"

INPUT_CSV="${INPUT_CSV:-accounts.csv}"
TOTAL_ACCOUNTS="${TOTAL_ACCOUNTS:-20898}"
BATCH_SIZE="${BATCH_SIZE:-5000}"

CPU="${CPU:-2}"
MEMORY="${MEMORY:-8Gi}"
PARALLELISM="${PARALLELISM:-1}"
ADOBE_PLAYWRIGHT_WORKERS="${ADOBE_PLAYWRIGHT_WORKERS:-2}"

ADOBE_SCRIPT_ACCOUNT_LIMIT="${ADOBE_SCRIPT_ACCOUNT_LIMIT:-21}"
ADOBE_STOP_AFTER_LOGIN="${ADOBE_STOP_AFTER_LOGIN:-0}"
ADOBE_STOP_AFTER_LETS_GO="${ADOBE_STOP_AFTER_LETS_GO:-1}"
ADOBE_LETS_GO_APPEAR_TIMEOUT_MS="${ADOBE_LETS_GO_APPEAR_TIMEOUT_MS:-60000}"
ADOBE_STRICT_LETS_GO="${ADOBE_STRICT_LETS_GO:-1}"
ADOBE_VIDEO_MODE="${ADOBE_VIDEO_MODE:-off}"
ADOBE_DEBUG_ARTIFACTS="${ADOBE_DEBUG_ARTIFACTS:-0}"
TASK_TIMEOUT="${TASK_TIMEOUT:-3h}"
AVG_SECONDS_PER_ACCOUNT="${AVG_SECONDS_PER_ACCOUNT:-10}"

BASE_JOB_NAME="${BASE_JOB_NAME:-adobe-login-flow}"
RUN_ID="$(date +%Y%m%d%H%M%S)-india-20898accounts-batched"

BATCH_DIR="tmp/adobe-batches-${RUN_ID}"
LOG_DIR="tmp/adobe-batch-logs-${RUN_ID}"

mkdir -p "$BATCH_DIR" "$LOG_DIR"

if [[ ! -f "$INPUT_CSV" ]]; then
  echo "ERROR: input CSV not found: $INPUT_CSV"
  exit 1
fi

HEADER="$(head -n 1 "$INPUT_CSV")"

echo "[BATCH] Creating batches from $INPUT_CSV"
echo "[BATCH] Total accounts: $TOTAL_ACCOUNTS"
echo "[BATCH] Batch size: $BATCH_SIZE"

tail -n +2 "$INPUT_CSV" | head -n "$TOTAL_ACCOUNTS" | split -l "$BATCH_SIZE" -d -a 2 - "$BATCH_DIR/accounts-part-"

BATCH_FILES=()

for part in "$BATCH_DIR"/accounts-part-*; do
  [[ -f "$part" ]] || continue

  batch_num="$(basename "$part" | sed 's/accounts-part-//')"
  batch_csv="$BATCH_DIR/accounts-batch-${batch_num}.csv"

  {
    echo "$HEADER"
    cat "$part"
  } > "$batch_csv"

  rm -f "$part"
  BATCH_FILES+=("$batch_csv")
done

echo "[BATCH] Created ${#BATCH_FILES[@]} batch files:"
printf '  %s\n' "${BATCH_FILES[@]}"

echo "[BATCH] Starting batches in parallel"
echo "[BATCH] CPU per job: $CPU"
echo "[BATCH] Memory per job: $MEMORY"
echo "[BATCH] Parallelism per job: $PARALLELISM"
echo "[BATCH] Workers per task: $ADOBE_PLAYWRIGHT_WORKERS"
echo "[BATCH] Approx max regional CPU: $(( ${#BATCH_FILES[@]} * CPU * PARALLELISM ))"

pids=()

i=0
for batch_csv in "${BATCH_FILES[@]}"; do
  i=$((i + 1))

  batch_rows=$(( $(wc -l < "$batch_csv") - 1 ))
  tasks=$(( (batch_rows + ADOBE_SCRIPT_ACCOUNT_LIMIT - 1) / ADOBE_SCRIPT_ACCOUNT_LIMIT ))

  batch_label="$(printf 'batch-%02d' "$i")"
  job_name="${BASE_JOB_NAME}-${batch_label}"
  object_name="accounts/${RUN_ID}/${batch_label}.csv"
  reports_prefix="adobe-runs/${RUN_ID}/${batch_label}"
  tag="${RUN_ID}-${batch_label}-${batch_rows}accounts-${tasks}tasks"

  echo "[BATCH] Launching $batch_label"
  echo "[BATCH]   rows=$batch_rows"
  echo "[BATCH]   tasks=$tasks"
  echo "[BATCH]   job=$job_name"
  echo "[BATCH]   log=$LOG_DIR/${batch_label}.log"

  (
    PROJECT_ID="$PROJECT_ID" \
    REGION="$REGION" \
    RUNTIME_SERVICE_ACCOUNT="$RUNTIME_SERVICE_ACCOUNT" \
    JOB_NAME="$job_name" \
    TAG="$tag" \
    ACCOUNTS_CSV="$batch_csv" \
    OBJECT_NAME="$object_name" \
    REPORTS_OBJECT_PREFIX="$reports_prefix" \
    TASKS="$tasks" \
    PARALLELISM="$PARALLELISM" \
    ADOBE_PLAYWRIGHT_WORKERS="$ADOBE_PLAYWRIGHT_WORKERS" \
    ADOBE_SCRIPT_ACCOUNT_LIMIT="$ADOBE_SCRIPT_ACCOUNT_LIMIT" \
    ADOBE_STOP_AFTER_LOGIN="$ADOBE_STOP_AFTER_LOGIN" \
    ADOBE_STOP_AFTER_LETS_GO="$ADOBE_STOP_AFTER_LETS_GO" \
    ADOBE_LETS_GO_APPEAR_TIMEOUT_MS="$ADOBE_LETS_GO_APPEAR_TIMEOUT_MS" \
    ADOBE_STRICT_LETS_GO="$ADOBE_STRICT_LETS_GO" \
    ADOBE_VIDEO_MODE="$ADOBE_VIDEO_MODE" \
    ADOBE_DEBUG_ARTIFACTS="$ADOBE_DEBUG_ARTIFACTS" \
    GOOGLE_CHAT_WEBHOOK_URL="${GOOGLE_CHAT_WEBHOOK_URL:-}" \
    CPU="$CPU" \
    MEMORY="$MEMORY" \
    TASK_TIMEOUT="$TASK_TIMEOUT" \
    TOTAL_ACCOUNTS="$batch_rows" \
    AVG_SECONDS_PER_ACCOUNT="$AVG_SECONDS_PER_ACCOUNT" \
    bash scripts/deploy-gcp-cloud-run-job.sh
  ) > "$LOG_DIR/${batch_label}.log" 2>&1 &

  pids+=("$!")
done

echo "[BATCH] All batches started."

failed=0

for idx in "${!pids[@]}"; do
  pid="${pids[$idx]}"
  batch_no=$((idx + 1))
  batch_label="$(printf 'batch-%02d' "$batch_no")"

  if wait "$pid"; then
    echo "[BATCH] $batch_label completed successfully"
  else
    echo "[BATCH] $batch_label failed"
    echo "[BATCH] Check: $LOG_DIR/${batch_label}.log"
    failed=1
  fi
done

echo
echo "[BATCH] Logs saved in: $LOG_DIR"
echo "[BATCH] Batch CSVs saved in: $BATCH_DIR"
echo

if [[ "$failed" -ne 0 ]]; then
  echo "[BATCH] One or more batches failed."
  echo "Debug examples:"
  echo "tail -n 200 $LOG_DIR/batch-01.log"
  echo "gcloud run jobs list --region=$REGION --project=$PROJECT_ID --filter='metadata.name~${BASE_JOB_NAME}-batch'"
  exit 1
fi

echo "[BATCH] All batches completed successfully."
