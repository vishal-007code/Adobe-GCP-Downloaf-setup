#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Count how many accounts actually logged in, straight from the Cloud Run logs.
#
# The run emits these greppable markers (see src/pages/adobe.ts, src/adobe/reporter.ts):
#
#   [ADOBE_LOGIN_OK]     email=... url=... elapsed_ms=... at=...
#   [ADOBE_LOGIN_FAIL]   email=... elapsed_ms=... reason="..."
#   [ADOBE_LETSGO_OK]    email=... via=api|ui owner_entity=... status=...
#   [ADOBE_RESULT]       status=passed|failed email=... logged_in=yes|no downloaded=yes|no
#                        outcome=login_download|login_only|no_login [timings] [step=... reason=...]
#   [ADOBE_TASK_SUMMARY] task=N of=M attempted=N login_ok=N login_fail=N passed=N failed=N skipped=N downloaded=N
#
# For the per-account report (login only vs login + download) use scripts/build-run-report.sh.
#
# MODES
#   summary   (default) Sum the per-task [ADOBE_TASK_SUMMARY] lines. Fast — one log
#             line per task (~2k lines), not per account. Use this for "how many
#             logged in so far".
#   accounts  Pull every [ADOBE_LOGIN_OK] line and write a proof CSV of
#             email,dashboard_url,at. Slow at 84k scale but gives per-account
#             evidence you can hand to someone.
#   failures  Pull [ADOBE_LOGIN_FAIL] lines grouped by reason — shows WHY logins
#             failed (bad password vs. timeout vs. Adobe-side block).
#
# USAGE
#   bash scripts/count-logins.sh
#   MODE=accounts FRESHNESS=2d bash scripts/count-logins.sh
#   REGION=asia-south2 JOB_PREFIX=adobe-login-s2 bash scripts/count-logins.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Defaults to the active gcloud project (projects rotate per trial; never hardcode one).
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null | tr -d '\r')}"
: "${PROJECT_ID:?set PROJECT_ID, or pick a project with: gcloud config set project <id>}"
REGION="${REGION:-}"                       # empty = all regions
JOB_PREFIX="${JOB_PREFIX:-adobe-login}"    # matches adobe-login-s1-batch-01 etc.
MODE="${MODE:-summary}"
# How far back to look. Accepts "2d" / "36h" shorthand or any GNU date expression
# ("2 days ago"). NOTE: `date -d "-2d"` is NOT valid GNU syntax — it must be
# "2 days ago" / "-2 days", hence the normalization below.
FRESHNESS="${FRESHNESS:-1d}"
OUT_DIR="${OUT_DIR:-tmp/login-counts}"
# `gcloud logging read` stops at 1000 entries when --limit is omitted, which
# SILENTLY truncates accounts/failures at scale — a run with 9.9k logins came
# back as 307. Summary mode is unaffected (one entry per task, ~2k max) but the
# per-account modes need the ceiling raised.
LIMIT="${LIMIT:-500000}"

normalize_freshness() {
  case "$1" in
    *[0-9]d) echo "${1%d} days ago" ;;
    *[0-9]h) echo "${1%h} hours ago" ;;
    *[0-9]m) echo "${1%m} minutes ago" ;;
    *)       echo "$1" ;;
  esac
}

since_timestamp() {
  local expr
  expr="$(normalize_freshness "$1")"
  date -u -d "$expr" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -v"-${1}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || { echo "ERROR: could not parse FRESHNESS='$1'" >&2; exit 1; }
}
SINCE="$(since_timestamp "$FRESHNESS")"

mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# Cloud Run Jobs write to the cloud_run_job resource. Filter on the job-name prefix
# so several batches/regions of one run are counted together.
FILTER="resource.type=\"cloud_run_job\" AND resource.labels.job_name:\"${JOB_PREFIX}\""
if [[ -n "$REGION" ]]; then
  FILTER+=" AND resource.labels.location=\"${REGION}\""
fi

log() { echo "[COUNT][$(date -u +%H:%M:%SZ)] $*"; }

read_logs() {
  # $1 = extra filter term. --format=value(textPayload) keeps it to raw log text.
  gcloud logging read "${FILTER} AND ${1} AND timestamp>=\"${SINCE}\"" \
    --project="${PROJECT_ID}" \
    --limit="${LIMIT}" \
    --format="value(textPayload)" \
    --order=asc
}

case "$MODE" in
  summary)
    log "Reading [ADOBE_TASK_SUMMARY] lines (last ${FRESHNESS}, jobs matching '${JOB_PREFIX}')..."
    RAW="$OUT_DIR/summaries-${STAMP}.txt"
    read_logs 'textPayload:"[ADOBE_TASK_SUMMARY]"' > "$RAW"

    if [[ ! -s "$RAW" ]]; then
      echo "No [ADOBE_TASK_SUMMARY] lines found."
      echo "Either no task has FINISHED yet (the summary is emitted at task end), or the"
      echo "filter is off. Check: JOB_PREFIX='${JOB_PREFIX}' REGION='${REGION:-all}' FRESHNESS='${FRESHNESS}'"
      exit 0
    fi

    awk '
      match($0, /attempted=[0-9]+/)   { a += substr($0, RSTART+10, RLENGTH-10) }
      match($0, /login_ok=[0-9]+/)    { o += substr($0, RSTART+9,  RLENGTH-9)  }
      match($0, /login_fail=[0-9]+/)  { f += substr($0, RSTART+11, RLENGTH-11) }
      match($0, /passed=[0-9]+/)      { p += substr($0, RSTART+7,  RLENGTH-7)  }
      match($0, / failed=[0-9]+/)     { x += substr($0, RSTART+8,  RLENGTH-8)  }
      match($0, /downloaded=[0-9]+/)  { d += substr($0, RSTART+11, RLENGTH-11) }
      END {
        printf "tasks reporting : %d\n", NR
        printf "attempted       : %d\n", a
        printf "LOGGED IN       : %d\n", o
        printf "  + downloaded  : %d\n", d
        printf "  login only    : %d\n", o - d
        printf "login failed    : %d\n", f
        printf "test passed     : %d\n", p
        printf "test failed     : %d\n", x
        if (a > 0) printf "login rate      : %.2f%%\n", (o * 100.0) / a
        if (a > 0) printf "download rate   : %.2f%%\n", (d * 100.0) / a
      }
    ' "$RAW"
    echo
    log "Raw summary lines: $RAW"
    ;;

  accounts)
    log "Reading [ADOBE_LOGIN_OK] lines (last ${FRESHNESS}) — this is slow at scale..."
    RAW="$OUT_DIR/login-ok-${STAMP}.txt"
    CSV="$OUT_DIR/logged-in-accounts-${STAMP}.csv"
    read_logs 'textPayload:"[ADOBE_LOGIN_OK]"' > "$RAW"

    {
      echo "email,dashboard_url,at"
      sed -n 's/.*\[ADOBE_LOGIN_OK\] email=\([^ ]*@[^ ]*\) url=\([^ ]*\).* at=\([^ ]*\).*/\1,\2,\3/p' "$RAW" \
        | sort -u -t, -k1,1
    } > "$CSV"

    TOTAL=$(( $(wc -l < "$CSV") - 1 ))
    log "Unique accounts with a confirmed dashboard: ${TOTAL}"
    log "Proof CSV: $CSV"
    log "Raw lines: $RAW"
    ;;

  failures)
    log "Reading [ADOBE_LOGIN_FAIL] lines (last ${FRESHNESS})..."
    RAW="$OUT_DIR/login-fail-${STAMP}.txt"
    read_logs 'textPayload:"[ADOBE_LOGIN_FAIL]"' > "$RAW"

    # Dedupe by email: Playwright reprints a failed test's stdout in its failure
    # recap, so the SAME marker appears twice for some accounts (measured: 20 raw
    # lines for 11 distinct accounts). Counting raw lines over-reports.
    RAWN=$(grep -c 'ADOBE_LOGIN_FAIL' "$RAW" || true)
    # The '@' guard matters: Playwright echoes the failing SOURCE LINE in its error
    # output, and that line literally contains `email=${loginAccount}` — without the
    # guard those echoes get counted as accounts.
    TOTAL=$(sed -n 's/.*\[ADOBE_LOGIN_FAIL\] email=\([^ ]*@[^ ]*\).*/\1/p' "$RAW" | sort -u | wc -l)
    log "Login failures: ${TOTAL} distinct accounts (${RAWN} raw marker lines — duplicates are Playwright's failure recap)"
    echo
    echo "NOTE: this marker only fires for failures AT the dashboard wait. Accounts that"
    echo "      failed EARLIER (e.g. the provider password screen) never reach it — use"
    echo "      MODE=summary for the authoritative did-not-log-in count."
    echo
    echo "Grouped by reason (top 20, one row per distinct account):"
    sed -n 's/.*\[ADOBE_LOGIN_FAIL\] email=\([^ ]*@[^ ]*\).*reason="\([^"]*\)".*/\1\t\2/p' "$RAW" \
      | sort -u -t$'\t' -k1,1 \
      | cut -f2 \
      | sed 's/[0-9]\{3,\}/N/g' \
      | sort | uniq -c | sort -rn | head -20
    echo
    log "Raw lines: $RAW"
    ;;

  *)
    echo "ERROR: unknown MODE='${MODE}'. Use summary | accounts | failures."
    exit 1
    ;;
esac
