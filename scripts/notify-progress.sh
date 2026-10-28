#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Push run progress into Google Chat so you never have to download or grep logs.
#
# WHY NOT NOTIFY PER TASK: a full run is ~2,018 tasks per region (~4,036 total).
# One message each would blow past the Chat webhook rate limit (~60/min per space)
# and bury the channel. Instead this posts ONE aggregated update per interval,
# built from two cheap sources:
#
#   1. `gcloud run jobs executions describe` — task counts (succeeded/running/failed).
#      A single tiny API call. Works from the first minute, before any task finishes.
#   2. `[ADOBE_TASK_SUMMARY]` log lines — one line per FINISHED task (not per
#      account), so the exact attempted / logged-in totals cost a small query.
#
# Reading 2,018 summary lines is cheap; reading 84,752 per-account lines is not.
# That is the whole reason the reporter emits a per-task tally.
#
# SETUP
#   Put the webhook in .env.local (git-ignored) and source it:
#     set -a && . ./.env.local && set +a
#   or just: export GOOGLE_CHAT_WEBHOOK_URL='https://chat.googleapis.com/...'
#
# USAGE
#   # one-shot update
#   bash scripts/notify-progress.sh
#
#   # continuous, every 30 min, until the run finishes (survives disconnects under tmux)
#   INTERVAL=1800 TOTAL_ACCOUNTS=84752 tmux new -s notify 'bash scripts/notify-progress.sh'
#
#   # single region
#   REGION=asia-south2 JOB_PREFIX=adobe-login-s2 bash scripts/notify-progress.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Defaults to the active gcloud project (projects rotate per trial; never hardcode one).
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null | tr -d '\r')}"
: "${PROJECT_ID:?set PROJECT_ID, or pick a project with: gcloud config set project <id>}"
JOB_PREFIX="${JOB_PREFIX:-adobe-login}"
REGIONS="${REGIONS:-asia-south1 asia-south2}"
[[ -n "${REGION:-}" ]] && REGIONS="$REGION"

TOTAL_ACCOUNTS="${TOTAL_ACCOUNTS:-0}"        # 0 = unknown, percentages omitted
INTERVAL="${INTERVAL:-0}"                     # 0 = post once and exit
# "2d" / "36h" shorthand, or any GNU date expression. `date -d "-2d"` is invalid
# GNU syntax, so shorthand is normalized to "N days ago" below.
FRESHNESS="${FRESHNESS:-2d}"
RUN_LABEL="${RUN_LABEL:-Adobe activation}"
# Groups every update into one Chat thread instead of spraying the space.
THREAD_KEY="${GOOGLE_CHAT_THREAD_KEY:-adobe-progress-$(date -u +%Y%m%d)}"
STATE_FILE="${STATE_FILE:-tmp/notify-progress.state}"
# Post even when nothing changed, if this many seconds have passed (liveness ping).
HEARTBEAT="${HEARTBEAT:-7200}"

if [[ -z "${GOOGLE_CHAT_WEBHOOK_URL:-}" ]]; then
  echo "ERROR: GOOGLE_CHAT_WEBHOOK_URL is not set."
  echo "  set -a && . ./.env.local && set +a"
  exit 1
fi

mkdir -p "$(dirname "$STATE_FILE")"

log() { echo "[NOTIFY][$(date -u +%H:%M:%SZ)] $*"; }

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

send_chat() {
  GOOGLE_CHAT_WEBHOOK_URL="$GOOGLE_CHAT_WEBHOOK_URL" \
  GOOGLE_CHAT_MESSAGE="$1" \
  GOOGLE_CHAT_THREAD_KEY="$THREAD_KEY" \
  node scripts/send-google-chat-update.mjs
}

# ── Task counts straight off the execution objects (no log reads) ──────────────
collect_task_counts() {
  local region="$1" succeeded=0 running=0 failed=0 total=0
  local execs
  execs=$(gcloud run jobs executions list \
            --region="$region" --project="$PROJECT_ID" \
            --filter="metadata.name~${JOB_PREFIX}" \
            --format="value(metadata.name)" 2>/dev/null || true)
  for e in $execs; do
    # Missing counters read as empty -> normalize to 0.
    local vals s r f t
    vals=$(gcloud run jobs executions describe "$e" \
             --region="$region" --project="$PROJECT_ID" \
             --format="value(status.succeededCount,status.runningCount,status.failedCount,spec.taskCount)" 2>/dev/null || true)
    s=$(echo "$vals" | awk '{print ($1=="")?0:$1}')
    r=$(echo "$vals" | awk '{print ($2=="")?0:$2}')
    f=$(echo "$vals" | awk '{print ($3=="")?0:$3}')
    t=$(echo "$vals" | awk '{print ($4=="")?0:$4}')
    succeeded=$((succeeded + s)); running=$((running + r))
    failed=$((failed + f));       total=$((total + t))
  done
  echo "$succeeded $running $failed $total"
}

# ── Exact account tallies from the per-task summary lines ─────────────────────
collect_account_totals() {
  local region="$1"
  gcloud logging read \
    "resource.type=\"cloud_run_job\" AND resource.labels.location=\"${region}\" AND resource.labels.job_name:\"${JOB_PREFIX}\" AND textPayload:\"[ADOBE_TASK_SUMMARY]\" AND timestamp>=\"${SINCE}\"" \
    --project="$PROJECT_ID" --format="value(textPayload)" 2>/dev/null \
  | awk '
      match($0, /attempted=[0-9]+/)  { a += substr($0, RSTART+10, RLENGTH-10) }
      match($0, /login_ok=[0-9]+/)   { o += substr($0, RSTART+9,  RLENGTH-9)  }
      match($0, /login_fail=[0-9]+/) { f += substr($0, RSTART+11, RLENGTH-11) }
      END { printf "%d %d %d %d\n", NR+0, a+0, o+0, f+0 }
    '
}

build_and_send() {
  local t_succ=0 t_run=0 t_fail=0 t_total=0
  local a_tasks=0 a_att=0 a_ok=0 a_fail=0
  local per_region=""

  for region in $REGIONS; do
    read -r s r f t <<<"$(collect_task_counts "$region")"
    read -r rt ra ro rf <<<"$(collect_account_totals "$region")"
    t_succ=$((t_succ + s)); t_run=$((t_run + r)); t_fail=$((t_fail + f)); t_total=$((t_total + t))
    a_tasks=$((a_tasks + rt)); a_att=$((a_att + ra)); a_ok=$((a_ok + ro)); a_fail=$((a_fail + rf))
    per_region+=$'\n'"  • ${region}: tasks ${s}/${t} done, ${r} running — logged in ${ro}"
  done

  # Delta since the previous notification, so each message shows the rate of work.
  local prev_ok=0 prev_at=0 now_epoch delta_ok rate_line=""
  if [[ -f "$STATE_FILE" ]]; then
    prev_ok=$(awk 'NR==1{print $1+0}' "$STATE_FILE")
    prev_at=$(awk 'NR==1{print $2+0}' "$STATE_FILE")
  fi
  now_epoch=$(date -u +%s)
  delta_ok=$((a_ok - prev_ok))

  if [[ "$prev_at" -gt 0 && "$now_epoch" -gt "$prev_at" && "$delta_ok" -gt 0 ]]; then
    local mins=$(( (now_epoch - prev_at) / 60 ))
    [[ "$mins" -lt 1 ]] && mins=1
    local per_hr=$(( delta_ok * 60 / mins ))
    rate_line=$'\n'"📈 +${delta_ok} since last update (~${per_hr}/hr)"
    if [[ "$TOTAL_ACCOUNTS" -gt 0 && "$per_hr" -gt 0 ]]; then
      local remaining=$(( TOTAL_ACCOUNTS - a_att ))
      [[ "$remaining" -lt 0 ]] && remaining=0
      local eta_min=$(( remaining * 60 / per_hr ))
      if [[ "$eta_min" -lt 60 ]]; then
        rate_line+=$'\n'"⏳ ~${eta_min}m left at this rate"
      else
        rate_line+=$'\n'"⏳ ~$(( eta_min / 60 ))h $(( eta_min % 60 ))m left at this rate"
      fi
    fi
  fi

  local pct="" rate_pct=""
  if [[ "$TOTAL_ACCOUNTS" -gt 0 ]]; then
    pct=" ($(( a_att * 100 / TOTAL_ACCOUNTS ))% of ${TOTAL_ACCOUNTS})"
  fi
  if [[ "$a_att" -gt 0 ]]; then
    rate_pct=" ($(( a_ok * 100 / a_att ))% success)"
  fi

  local msg
  msg="*${RUN_LABEL}* — $(date -u '+%Y-%m-%d %H:%M UTC')
✅ *Logged in: ${a_ok}*${rate_pct}
📊 Attempted: ${a_att}${pct}
❌ Login failed: ${a_fail}
🧩 Tasks finished: ${t_succ}/${t_total} (${t_run} running, ${t_fail} failed)${per_region}${rate_line}"

  # Suppress no-op posts unless the heartbeat window has passed.
  if [[ "$delta_ok" -eq 0 && "$prev_at" -gt 0 && $(( now_epoch - prev_at )) -lt "$HEARTBEAT" ]]; then
    log "no change (logged_in=${a_ok}) and heartbeat not due — skipping post"
    return 0
  fi

  send_chat "$msg"
  echo "${a_ok} ${now_epoch}" > "$STATE_FILE"
  log "posted: logged_in=${a_ok} attempted=${a_att} tasks=${t_succ}/${t_total}"

  # Stop the loop once every task has settled and at least one has run.
  if [[ "$t_total" -gt 0 && "$t_run" -eq 0 && $(( t_succ + t_fail )) -ge "$t_total" ]]; then
    send_chat "🏁 *${RUN_LABEL} complete* — ${a_ok} accounts logged in of ${a_att} attempted."
    log "run complete — exiting"
    return 2
  fi
  return 0
}

if [[ "$INTERVAL" -le 0 ]]; then
  build_and_send || true
else
  log "posting every ${INTERVAL}s (thread=${THREAD_KEY}); Ctrl-C to stop"
  while true; do
    set +e; build_and_send; rc=$?; set -e
    [[ "$rc" -eq 2 ]] && break
    sleep "$INTERVAL"
  done
fi
