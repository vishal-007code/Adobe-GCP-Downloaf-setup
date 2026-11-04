#!/usr/bin/env bash
# Runs INSIDE the adobe-stop-window Cloud Run job when a scheduled window ends
# (scripts/schedule-window.sh uploads it to GCS; the job pipes it into bash, so the run
# image doesn't need a rebuild). It cancels every unfinished execution of the jobs in
# STOP_JOBS, after a Chat note so the cut-off tasks don't read as a crash. When every
# execution has already finished it does nothing.
#
# Env (set on the job by schedule-window.sh):
#   PROJECT_ID              the project
#   STOP_JOBS               space-separated region/job pairs, e.g.
#                           "asia-south1/adobe-login-s1-batch-01 asia-south2/adobe-login-s2-batch-01"
#   STOP_LABEL              text for the Chat note, e.g. "8:00 PM IST"
#   GOOGLE_CHAT_WEBHOOK_URL from Secret Manager; no Chat note without it
#   GOOGLE_CHAT_THREAD_KEY  the run's Chat thread (optional)
set -uo pipefail
: "${PROJECT_ID:?}" "${STOP_JOBS:?}"

log() { echo "[STOP-WINDOW][$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
chat() {
  GOOGLE_CHAT_MESSAGE="$1" node /app/scripts/send-google-chat-update.mjs >/dev/null 2>&1 || true
}

# region/execution for every execution with no completion time yet.
unfinished=()
for pair in $STOP_JOBS; do
  region="${pair%%/*}"; job="${pair#*/}"
  while read -r name; do
    [[ -n "$name" ]] && unfinished+=("${region}/${name}")
  done < <(gcloud run jobs executions list --job="$job" --region="$region" --project="$PROJECT_ID" \
             --format="value(name,status.completionTime)" | awk 'NF==1 {print $1}')
done

if [[ ${#unfinished[@]} -eq 0 ]]; then
  log "Every execution of ${STOP_JOBS} has finished; nothing to stop."
  exit 0
fi

log "Unfinished at the stop time: ${unfinished[*]}"
chat "⏹️ *Stopping the run at ${STOP_LABEL:-the scheduled time} as planned*
Cancelling ${#unfinished[@]} unfinished execution(s) now, so tasks still running are cut off.
Accounts not reached show as Not run in the report (\`bash scripts/build-run-report.sh\`) and go into the re-run list."

failed=()
for item in "${unfinished[@]}"; do
  region="${item%%/*}"; name="${item#*/}"
  if gcloud run jobs executions cancel "$name" --region="$region" --project="$PROJECT_ID" --quiet; then
    log "Cancelled ${name} (${region})."
  else
    failed+=("${name} (${region})")
  fi
done

if [[ ${#failed[@]} -gt 0 ]]; then
  log "Could not cancel: ${failed[*]}"
  GOOGLE_CHAT_THREAD_KEY='' chat "🚨 *Scheduled stop could not cancel ${#failed[@]} execution(s)*
${failed[*]}
They are still running and using credit. Cancel by hand:
\`gcloud run jobs executions cancel <execution> --region=<region>\`"
  exit 1
fi
log "Done."
