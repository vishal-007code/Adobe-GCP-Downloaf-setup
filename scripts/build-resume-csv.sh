#!/usr/bin/env bash
# Rebuild a CSV of accounts to retry after a run, using only the Cloud Run logs
# (no GCS reports needed — works with SAVE_ARTIFACTS=false).
#
# It pulls the [ADOBE_RESULT] markers the reporter prints for every account,
# treats `status=passed` as done, and writes everything else to a resume CSV.
#
# Usage:
#   INPUT_CSV=accounts.csv bash scripts/build-resume-csv.sh
#
# Common overrides:
#   SINCE="2026-06-29T00:00:00Z"   # only consider logs at/after this UTC time (default: 2 days ago)
#   OUTPUT_CSV=resume.csv          # where to write the accounts to retry
#   JOB_PREFIX=adobe-login-flow    # match jobs whose name starts with this
#
# Then re-run the remaining accounts (gentler concurrency recommended):
#   IMAGE_URI=<uri> INPUT_CSV=resume.csv TOTAL_ACCOUNTS=<count> PARALLELISM=6 bash scripts/run-batches.sh
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-project-8606ec18-5b16-4826-af3}"
REGION="${REGION:-asia-south1}"
JOB_PREFIX="${JOB_PREFIX:-adobe-login-flow}"

INPUT_CSV="${INPUT_CSV:-accounts.csv}"
OUTPUT_CSV="${OUTPUT_CSV:-resume.csv}"
# Default window: last 2 days. gcloud wants an RFC3339 timestamp.
SINCE="${SINCE:-$(date -u -d '2 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-2d +%Y-%m-%dT%H:%M:%SZ)}"
LIMIT="${LIMIT:-500000}"

LOGS_FILE="${LOGS_FILE:-tmp/resume-logs-$(date +%Y%m%d%H%M%S).txt}"

if [[ ! -f "$INPUT_CSV" ]]; then
  echo "ERROR: input CSV not found: $INPUT_CSV"
  exit 1
fi
mkdir -p "$(dirname "$LOGS_FILE")"

echo "Pulling [ADOBE_RESULT] markers from Cloud Run logs..."
echo "  project=${PROJECT_ID} region=${REGION} job_prefix=${JOB_PREFIX} since=${SINCE}"

# resource.labels.job_name uses ':' for a has/substring match so one query covers
# all batch jobs (adobe-login-flow-batch-01, -02, ...).
#
# --order=asc is REQUIRED, not cosmetic: gcloud defaults to descending, and a
# descending scan over a window whose recent end is empty returns ZERO entries
# even when the run's logs sit earlier in the same window. That failure mode is
# indistinguishable from "nothing matched" — the resume CSV comes back with
# every account in it and the WARNING below is the only hint.
gcloud logging read \
  "resource.type=\"cloud_run_job\" AND resource.labels.location=\"${REGION}\" AND resource.labels.job_name:\"${JOB_PREFIX}\" AND textPayload:\"ADOBE_RESULT\" AND timestamp>=\"${SINCE}\"" \
  --project="${PROJECT_ID}" \
  --limit="${LIMIT}" \
  --order=asc \
  --format="value(textPayload)" \
  > "$LOGS_FILE"

marker_count=$(grep -c 'ADOBE_RESULT' "$LOGS_FILE" || true)
echo "Fetched ${marker_count} result marker line(s) → ${LOGS_FILE}"

node scripts/build-resume-csv.mjs "$INPUT_CSV" "$LOGS_FILE" "$OUTPUT_CSV"
