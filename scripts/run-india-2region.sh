#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Run the Adobe login -> "Let's Go" flow across BOTH Indian GCP regions in
# parallel, on a split of the full account list, to beat a tight deadline.
#
#   asia-south1 (Mumbai)  -> first  half of the accounts
#   asia-south2 (Delhi)   -> second half of the accounts
#
# Each region runs the safe per-region config (PARALLELISM=8 x WORKERS=4 = ~32
# accounts in flight, within the ~20 vCPU / 40 GiB regional quota). With the run
# stopping right after Let's Go (ADOBE_STOP_AFTER_LETS_GO=1), each account takes
# ~login time (~60-90s) instead of ~6 min, so ~29.6k accounts finish well inside
# a ~15h window across two regions.
#
# PREREQS:
#   1. tests/adobe/script.spec.ts honors ADOBE_STOP_AFTER_LETS_GO=1 (restored).
#   2. Build the image once:   bash scripts/setup-run.sh
#      then copy the printed IMAGE_URI.
#
# USAGE:
#   export IMAGE_URI=asia-south1-docker.pkg.dev/<project>/playwright-jobs/adobe-login-flow:<tag>
#   bash scripts/run-india-2region.sh
#
# The asia-south1 image is pulled cross-region by asia-south2 (same project) — no
# second build needed. If asia-south2 cannot pull it, build there too and pass
# IMAGE_URI_S2=<asia-south2 image>.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

: "${IMAGE_URI:?IMAGE_URI is required. Run scripts/setup-run.sh first and copy the printed IMAGE_URI.}"

PROJECT_ID="${PROJECT_ID:-project-8606ec18-5b16-4826-af3}"
IMAGE_URI_S1="${IMAGE_URI_S1:-$IMAGE_URI}"
IMAGE_URI_S2="${IMAGE_URI_S2:-$IMAGE_URI}"

REGION_S1="${REGION_S1:-asia-south1}"
REGION_S2="${REGION_S2:-asia-south2}"

# Source CSVs (the full account list is split across these two files).
CSV_A="${CSV_A:-accounts.csv}"
CSV_B="${CSV_B:-accounts-11.csv}"

# Per-region throughput knobs (exported through to run-batches.sh). Defaults are
# the safe within-quota values. Bump PARALLELISM to 10 only if the region's
# Cloud Run vCPU quota is confirmed at 20 (10 x CPU=2 = 20 vCPU, no headroom).
export CPU="${CPU:-2}"
export MEMORY="${MEMORY:-4Gi}"
export PARALLELISM="${PARALLELISM:-8}"
export ADOBE_PLAYWRIGHT_WORKERS="${ADOBE_PLAYWRIGHT_WORKERS:-3}"
export ADOBE_STOP_AFTER_LETS_GO="${ADOBE_STOP_AFTER_LETS_GO:-0}"
export TASK_TIMEOUT="${TASK_TIMEOUT:-8h}"

STAMP="$(date +%Y%m%d%H%M%S)"
PREP_DIR="tmp/india-2region-${STAMP}"
mkdir -p "$PREP_DIR"

MASTER="$PREP_DIR/accounts-master.csv"
HALF1="$PREP_DIR/accounts-s1.csv"
HALF2="$PREP_DIR/accounts-s2.csv"
HEADER="Email,Password"

log() { echo "[INDIA-2R][$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# Count non-empty data rows in a CSV (header excluded; tolerant of CRLF and a
# missing trailing newline) — same robust method as run-batches.sh.
count_rows() { tail -n +2 "$1" | sed 's/\r$//' | grep -c '[^[:space:]]' || true; }

for f in "$CSV_A" "$CSV_B"; do
  [[ -f "$f" ]] || { echo "ERROR: input CSV not found: $f"; exit 1; }
done

# ── 1) Merge both files + dedupe by lowercased email (keep first occurrence) ───
{
  echo "$HEADER"
  { tail -n +2 "$CSV_A"; tail -n +2 "$CSV_B"; } \
    | sed 's/\r$//' \
    | awk -F',' 'NF>=2 { key=tolower($1); gsub(/^[ \t]+|[ \t]+$/,"",key); if (key != "" && !seen[key]++) print }'
} > "$MASTER"

DATA_ROWS=$(count_rows "$MASTER")
[[ "$DATA_ROWS" -gt 0 ]] || { echo "ERROR: merged master has no data rows"; exit 1; }
HALF=$(( (DATA_ROWS + 1) / 2 ))

# ── 2) Split into two halves (each keeps the header) ──────────────────────────
{ echo "$HEADER"; tail -n +2 "$MASTER" | head -n "$HALF"; }            > "$HALF1"
{ echo "$HEADER"; tail -n +2 "$MASTER" | tail -n +"$((HALF + 1))"; }   > "$HALF2"

S1_ROWS=$(count_rows "$HALF1")
S2_ROWS=$(count_rows "$HALF2")

log "============================================================"
log "India two-region login run"
log "Project:        ${PROJECT_ID}"
log "Merged unique:  ${DATA_ROWS} accounts (from ${CSV_A} + ${CSV_B})"
log "${REGION_S1}:   ${S1_ROWS} accounts   image=${IMAGE_URI_S1}"
log "${REGION_S2}:   ${S2_ROWS} accounts   image=${IMAGE_URI_S2}"
log "Per region:     PARALLELISM=${PARALLELISM} x WORKERS=${ADOBE_PLAYWRIGHT_WORKERS} = $(( PARALLELISM * ADOBE_PLAYWRIGHT_WORKERS )) in flight"
log "Stop after Let's Go: ${ADOBE_STOP_AFTER_LETS_GO}"
log "Prep dir:       ${PREP_DIR}"
log "============================================================"

# ── 3) Launch both regions in parallel ────────────────────────────────────────
run_region() {
  local region="$1" input="$2" image="$3" jobbase="$4" runid="$5"
  RUN_ID="$runid" \
  IMAGE_URI="$image" \
  PROJECT_ID="$PROJECT_ID" \
  REGION="$region" \
  INPUT_CSV="$input" \
  TOTAL_ACCOUNTS="$(count_rows "$input")" \
  BATCH_SIZE="100000000" \
  BASE_JOB_NAME="$jobbase" \
  bash scripts/run-batches.sh
}

run_region "$REGION_S1" "$HALF1" "$IMAGE_URI_S1" "adobe-login-s1" "${STAMP}-s1" > "$PREP_DIR/s1.log" 2>&1 &
PID1=$!
run_region "$REGION_S2" "$HALF2" "$IMAGE_URI_S2" "adobe-login-s2" "${STAMP}-s2" > "$PREP_DIR/s2.log" 2>&1 &
PID2=$!

log "asia-south1 launched: pid=${PID1}  log=${PREP_DIR}/s1.log"
log "asia-south2 launched: pid=${PID2}  log=${PREP_DIR}/s2.log"
log "Monitor:"
log "  tail -f ${PREP_DIR}/s1.log"
log "  tail -f ${PREP_DIR}/s2.log"
log "  gcloud run jobs list --region=${REGION_S1} --project=${PROJECT_ID}"
log "  gcloud run jobs list --region=${REGION_S2} --project=${PROJECT_ID}"

fail=0
wait "$PID1" || { log "asia-south1 batch FAILED — see ${PREP_DIR}/s1.log"; fail=1; }
wait "$PID2" || { log "asia-south2 batch FAILED — see ${PREP_DIR}/s2.log"; fail=1; }

if [[ "$fail" -ne 0 ]]; then
  log "One or both regions failed. Debug with the logs above."
  exit 1
fi

log "Both regions completed."
