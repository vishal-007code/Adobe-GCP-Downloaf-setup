#!/usr/bin/env bash
# Build the per-account run report — Login + Download / Login only / Login failed / Not run —
# straight from the Cloud Run logs. No PNGs and no GCS reports are needed: every account's
# outcome is in the [ADOBE_RESULT] line the reporter prints for it (src/adobe/reporter.ts).
#
# Usage:
#   INPUT_CSV=accounts.csv SINCE=2026-10-25T00:00:00Z bash scripts/build-run-report.sh
#
# Overrides:
#   PROJECT_ID   default: the active gcloud project
#   JOB_PREFIX   default adobe-login — matches adobe-login-flow-*, adobe-login-s1-*,
#                adobe-login-s2-* (substring match, so one query covers every batch)
#   REGION       default: every region (asia-south1 and asia-south2 together)
#   SINCE        default: 7 days ago. Set it to the run's start so older runs stay out.
#   INPUT_CSV    default accounts.csv. Optional — without it there are no "Not run" rows.
#   LOGS_FILE    where the raw [ADOBE_RESULT] lines are saved (re-usable with --logs=)
#
# Extra arguments go to build-run-report.mjs, e.g. --include-dead.
#
# Writes reports/run-report-<stamp>.csv (one row per account) and
# tmp/missing-downloads.csv (accounts to run again).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
JOB_PREFIX="${JOB_PREFIX:-adobe-login}"
REGION="${REGION:-}"
SINCE="${SINCE:-$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)}"
INPUT_CSV="${INPUT_CSV:-accounts.csv}"
LIMIT="${LIMIT:-500000}"
LOGS_FILE="${LOGS_FILE:-tmp/run-report-logs-$(date +%Y%m%d%H%M%S).txt}"

[[ -n "$PROJECT_ID" ]] || { echo "ERROR: no PROJECT_ID and no active gcloud project."; exit 1; }
mkdir -p "$(dirname "$LOGS_FILE")"

FILTER="resource.type=\"cloud_run_job\" AND resource.labels.job_name:\"${JOB_PREFIX}\""
FILTER+=" AND textPayload:\"[ADOBE_RESULT]\" AND timestamp>=\"${SINCE}\""
if [[ -n "$REGION" ]]; then
  FILTER+=" AND resource.labels.location=\"${REGION}\""
fi

echo "Pulling [ADOBE_RESULT] lines from Cloud Run logs..."
echo "  project=${PROJECT_ID} region=${REGION:-all} job_prefix=${JOB_PREFIX} since=${SINCE}"

# --order=asc is required: a descending scan whose recent end is empty returns nothing
# (see build-resume-csv.sh). Ascending order also lets the report treat later lines as
# later attempts. Without --limit gcloud stops at 1000 entries.
gcloud logging read "$FILTER" \
  --project="$PROJECT_ID" \
  --limit="$LIMIT" \
  --order=asc \
  --format="value(textPayload)" \
  > "$LOGS_FILE"

echo "Fetched $(grep -c 'ADOBE_RESULT' "$LOGS_FILE" || true) line(s) → ${LOGS_FILE}"

if [[ -f "$INPUT_CSV" ]]; then
  node scripts/build-run-report.mjs "$INPUT_CSV" --logs="$LOGS_FILE" "$@"
else
  echo "NOTE: ${INPUT_CSV} not found — reporting only the accounts seen in the logs."
  node scripts/build-run-report.mjs --logs="$LOGS_FILE" "$@"
fi
