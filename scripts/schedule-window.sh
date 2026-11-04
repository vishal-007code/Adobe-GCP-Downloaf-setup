#!/usr/bin/env bash
# Run the two-region job inside a time window with Cloud Scheduler, so the laptop doesn't
# have to be on: start both jobs at START, and at STOP cancel whatever is still running.
#
#   1. Deploy the jobs without starting them (same knobs as a normal run):
#        DEPLOY_ONLY=1 SCHEDULED_FOR="2 Nov 8:00 AM IST" IMAGE_URI=<uri> CSV_A=accounts.csv \
#          PARALLELISM=32 ADOBE_SCRIPT_ACCOUNT_LIMIT=14 TASK_TIMEOUT=2h \
#          GOOGLE_CHAT_THREAD_KEY=adobe-run-20261102 bash scripts/run-india-2region.sh
#   2. Schedule them (times are IST):
#        START="2026-11-02 08:00" STOP="2026-11-02 20:00" \
#          GOOGLE_CHAT_THREAD_KEY=adobe-run-20261102 bash scripts/schedule-window.sh
#   3. After the run, remove the schedules:  SCHEDULE_DELETE=1 bash scripts/schedule-window.sh
#
# Creates or updates:
#   - service account adobe-scheduler: starts and cancels the jobs (roles/run.developer),
#     reads the stop script from the bucket and the Chat webhook secret
#   - Cloud Scheduler jobs adobe-start-s1 / adobe-start-s2: POST :run on each job at START
#   - Cloud Run job adobe-stop-window (the run image, piping scripts/stop-window.sh from GCS
#     into bash) and Cloud Scheduler job adobe-stop, which runs it at STOP
# A cron entry can't name a year, so each schedule would fire again on the same date next
# year; step 3 removes them.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null | tr -d '\r')}"
: "${PROJECT_ID:?set PROJECT_ID, or pick a project with: gcloud config set project <id>}"
SCHED_REGION="${SCHED_REGION:-asia-south1}"
TIME_ZONE="${TIME_ZONE:-Asia/Kolkata}"
TZ_OFFSET="${TZ_OFFSET:-+0530}"   # must match TIME_ZONE; only used to reject past times
JOB_S1="${JOB_S1:-asia-south1/adobe-login-s1-batch-01}"
JOB_S2="${JOB_S2:-asia-south2/adobe-login-s2-batch-01}"
SA_NAME="${SA_NAME:-adobe-scheduler}"
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
BUCKET="${BUCKET:-${PROJECT_ID}-adobe-accounts}"
CHAT_SECRET="${CHAT_SECRET:-adobe-chat-webhook}"
STOP_JOB="${STOP_JOB:-adobe-stop-window}"
STOP_SCRIPT_URI="gs://${BUCKET}/schedule/stop-window.sh"

# Git Bash: keep MSYS from rewriting gs:// and region/job values inside these arguments
# (see run-batches.sh). No-op on Linux.
export MSYS2_ARG_CONV_EXCL="${MSYS2_ARG_CONV_EXCL:+${MSYS2_ARG_CONV_EXCL};}--set-env-vars=;--args=;--uri="

log() { echo "[SCHEDULE][$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
g() { gcloud "$@" --project="$PROJECT_ID"; }

if [[ "${SCHEDULE_DELETE:-0}" == "1" ]]; then
  for s in adobe-start-s1 adobe-start-s2 adobe-stop; do
    g scheduler jobs delete "$s" --location="$SCHED_REGION" --quiet 2>/dev/null && log "Deleted schedule $s." || true
  done
  g run jobs delete "$STOP_JOB" --region="$SCHED_REGION" --quiet 2>/dev/null && log "Deleted job $STOP_JOB." || true
  exit 0
fi

: "${START:?set START, e.g. START=\"2026-11-02 08:00\" (${TIME_ZONE})}"
: "${STOP:?set STOP, e.g. STOP=\"2026-11-02 20:00\" (${TIME_ZONE})}"
start_epoch=$(date -d "${START} ${TZ_OFFSET}" +%s)
stop_epoch=$(date -d "${STOP} ${TZ_OFFSET}" +%s)
(( start_epoch > $(date +%s) + 300 )) || { echo "ERROR: START ${START} is less than 5 minutes away or past."; exit 1; }
(( stop_epoch > start_epoch )) || { echo "ERROR: STOP ${STOP} is not after START ${START}."; exit 1; }
cron_of() { date -d "$1" +'%-M %-H %-d %-m *'; }
START_CRON="$(cron_of "$START")"
STOP_CRON="$(cron_of "$STOP")"
STOP_LABEL="${STOP_LABEL:-$(date -d "$STOP" +'%-I:%M %p') IST}"

# The jobs must already be deployed (step 1); the stop job reuses their image.
for pair in "$JOB_S1" "$JOB_S2"; do
  g run jobs describe "${pair#*/}" --region="${pair%%/*}" --format="value(name)" >/dev/null \
    || { echo "ERROR: job ${pair} not found. Deploy it first with DEPLOY_ONLY=1 (see the header)."; exit 1; }
done
IMAGE_URI="${IMAGE_URI:-$(g run jobs describe "${JOB_S1#*/}" --region="${JOB_S1%%/*}" \
  --format='value(spec.template.spec.template.spec.containers[0].image)' | tr -d '\r')}"
[[ -n "$IMAGE_URI" ]] || { echo "ERROR: could not read the image of ${JOB_S1}; pass IMAGE_URI."; exit 1; }

log "Project ${PROJECT_ID}: start ${JOB_S1} + ${JOB_S2} at ${START} (cron '${START_CRON}'),"
log "stop anything unfinished at ${STOP} (cron '${STOP_CRON}'), ${TIME_ZONE}."

log "Enabling Cloud Scheduler..."
g services enable cloudscheduler.googleapis.com

# SKIP_GRANTS=1 when a previous run already created the account and its three grants
# (they stay in place after SCHEDULE_DELETE=1).
if [[ "${SKIP_GRANTS:-0}" == "1" ]]; then
  g iam service-accounts describe "$SA" >/dev/null \
    || { echo "ERROR: ${SA} not found; run once without SKIP_GRANTS."; exit 1; }
  log "SKIP_GRANTS=1: using the existing ${SA} and its grants."
else
  if ! g iam service-accounts describe "$SA" >/dev/null 2>&1; then
    log "Creating service account ${SA}..."
    g iam service-accounts create "$SA_NAME" --display-name="Adobe run scheduler (start/stop jobs)"
    sleep 10   # new service accounts take a few seconds to be usable in IAM bindings
  fi
  log "Granting ${SA} what it needs..."
  g projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA}" \
    --role=roles/run.developer --condition=None >/dev/null
  gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --member="serviceAccount:${SA}" \
    --role=roles/storage.objectViewer >/dev/null
  g secrets add-iam-policy-binding "$CHAT_SECRET" --member="serviceAccount:${SA}" \
    --role=roles/secretmanager.secretAccessor >/dev/null
fi

log "Uploading the stop script to ${STOP_SCRIPT_URI}..."
gcloud storage cp "$(dirname "$0")/stop-window.sh" "$STOP_SCRIPT_URI"

log "Deploying Cloud Run job ${STOP_JOB}..."
g run jobs deploy "$STOP_JOB" \
  --image="$IMAGE_URI" \
  --region="$SCHED_REGION" \
  --service-account="$SA" \
  --tasks=1 --max-retries=0 --task-timeout=15m \
  --cpu=1 --memory=1Gi \
  --command=bash \
  --args="-c,gcloud storage cat ${STOP_SCRIPT_URI} | bash" \
  --set-env-vars="PROJECT_ID=${PROJECT_ID},STOP_JOBS=${JOB_S1} ${JOB_S2},STOP_LABEL=${STOP_LABEL},GOOGLE_CHAT_THREAD_KEY=${GOOGLE_CHAT_THREAD_KEY:-}" \
  --set-secrets="GOOGLE_CHAT_WEBHOOK_URL=${CHAT_SECRET}:latest"

# Create or update one Cloud Scheduler job that POSTs :run on a Cloud Run job.
# Retries: a failed POST normally means no execution was created, so retrying is safe.
schedule() {
  local name="$1" cron="$2" pair="$3" desc="$4" verb=create
  local uri="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${pair%%/*}/jobs/${pair#*/}:run"
  g scheduler jobs describe "$name" --location="$SCHED_REGION" >/dev/null 2>&1 && verb=update
  g scheduler jobs "$verb" http "$name" \
    --location="$SCHED_REGION" \
    --schedule="$cron" \
    --time-zone="$TIME_ZONE" \
    --uri="$uri" \
    --http-method=POST \
    --oauth-service-account-email="$SA" \
    --oauth-token-scope=https://www.googleapis.com/auth/cloud-platform \
    --max-retry-attempts=2 --min-backoff=60s \
    --description="$desc" >/dev/null
  log "Schedule ${name}: '${cron}' ${TIME_ZONE} -> ${pair}"
}
schedule adobe-start-s1 "$START_CRON" "$JOB_S1" "Start ${JOB_S1} at ${START}"
schedule adobe-start-s2 "$START_CRON" "$JOB_S2" "Start ${JOB_S2} at ${START}"
schedule adobe-stop "$STOP_CRON" "${SCHED_REGION}/${STOP_JOB}" "Cancel unfinished runs at ${STOP}"

g scheduler jobs list --location="$SCHED_REGION" \
  --format="table(name.basename(),schedule,timeZone,state,httpTarget.uri.basename())"
log "Scheduled. Test the stop path now (it does nothing while no run is going):"
log "  gcloud scheduler jobs run adobe-stop --location=${SCHED_REGION}"
log "Remove the schedules after the run: SCHEDULE_DELETE=1 bash scripts/schedule-window.sh"
