# Run 22,003 Accounts — Login + Let's Go + 30s Dwell (single region, asia-south1)

Runbook for the bulk activation run: log in each account, dismiss **"Let's Go"** via
API, **dwell 30s on the dashboard**, then stop. One Cloud Run Job in `asia-south1`.

## What each account does

1. Adobe login (Google / Microsoft, auto-detected)
2. Wait for dashboard
3. Dismiss "Let's Go" via API (`skipLetsGoViaAPI`)
4. **Dwell 30s on the dashboard** (`dwellOnDashboard(30_000)`) — runs because this
   job is launched with `ADOBE_STOP_AFTER_LETS_GO=0`
5. End (the template / share-link flow stays commented out in `script.spec.ts`)

Roughly **~90–120s per account**.

> `ADOBE_STOP_AFTER_LETS_GO=1` would return **before** the dwell (fastest, login-only).
> We use `=0` here specifically to keep the 30s dwell.

## Prerequisites

- Run on **Cloud Shell** (has `gcloud`).
- Repo pulled on Cloud Shell.
- GCP project already has the bucket / service account / Artifact Registry from earlier
  runs. `setup-run.sh` re-ensures them idempotently **and rebuilds the image** with the
  latest code — which is what we need (the code changed).

---

## Steps (on Cloud Shell)

### 0. Select the project

```bash
gcloud config set project project-28b03595-59c0-441d-b79
```

### 1. Load the 22,003 accounts into `accounts.csv`

Put them at the repo root as `accounts.csv`. Header must be `Email,Password`.

```bash
head -1 accounts.csv                              # -> Email,Password
echo "rows: $(( $(wc -l < accounts.csv) - 1 ))"   # -> 22003
```

`*.csv` is in `.dockerignore`, so accounts are **not** baked into the image — they are
uploaded to GCS at run time by `run-batches.sh`.

### 2. Build the image with the updated code

```bash
bash scripts/setup-run.sh
```

Copy the printed `IMAGE_URI=...`.

### 3. Launch the run (single region, 30s dwell kept)

```bash
export IMAGE_URI=<paste the IMAGE_URI from step 2>
export REGION=asia-south1
export INPUT_CSV=accounts.csv
export TOTAL_ACCOUNTS=22003
export ADOBE_STOP_AFTER_LETS_GO=0     # 0 = KEEP the 30s dwell; 1 = stop right after Let's Go
export CPU=2
export MEMORY=4Gi
export PARALLELISM=8                   # 8 x CPU2 = 16 vCPU ; 8 x 4Gi = 32 GiB (within asia-south1 20 vCPU / 40 GiB)
export ADOBE_PLAYWRIGHT_WORKERS=4
export TASK_TIMEOUT=8h

# Run under tmux so the local monitor survives a Cloud Shell disconnect.
# (Even without tmux, the Cloud Run job runs server-side and finishes on its
#  own once it's been triggered — see "Disconnects" below.)
tmux new -s run22k 'bash scripts/run-batches.sh 2>&1 | tee run22k.log'
```

This deploys **one** Cloud Run Job with about **1,048 tasks** (~21 accounts/task) and
`--parallelism=8`, i.e. ~8 tasks × 4 workers = **~32 accounts in flight**.

### 4. Monitor

```bash
gcloud run jobs list                 --region=asia-south1
gcloud run jobs executions list      --region=asia-south1
tail -f tmp/batch-logs-*/batch-01.log     # local per-batch log
```

Per-account outcomes appear in the Cloud Run logs as:

```
[ADOBE_RESULT] status=passed email=...
[ADOBE_RESULT] status=failed email=... step="..." reason="..."
```

Count passes from logs (Logs Explorer or gcloud logging), or rebuild a resume/results
CSV with `scripts/build-resume-csv.sh`.

---

## Timing vs. the deadline

- ~32 accounts in flight, ~105s each → **22,003 × 105s / 32 ≈ ~20–22h**.
- Worst case (slow logins / failures) ~28–30h.
- Started Tue night, this finishes **Wed evening → Thu morning**, well inside the
  Fri-midnight deadline.

To go faster: raise `PARALLELISM` (needs a Cloud Run vCPU quota increase for
`asia-south1`), or split across `asia-south2` with `scripts/run-india-2region.sh`.

## Disconnects

`gcloud run jobs execute` **triggers a server-side execution**; `--wait` only polls it.
Once the job is triggered (after the CSV upload + deploy, ~1–2 min), it runs to completion
on Cloud Run **even if Cloud Shell disconnects**. `tmux` just keeps the local log/monitor
alive; if the session drops, reconnect and check `gcloud run jobs executions list`.

## Notes

- **No retries** — each account is consumed on first attempt (pass or fail).
- **Stale passwords** fail at "Wait for Adobe Dashboard" — a data issue, not a bug; refresh
  the password in the CSV.
- Results stay in Cloud Run **logs only** (`SAVE_ARTIFACTS=false`). To upload result CSVs to
  GCS instead, `export SAVE_ARTIFACTS=true` before step 3.
