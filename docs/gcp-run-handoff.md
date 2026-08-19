# GCP Run Handoff — Adobe Activation Automation

Self-contained context for a fresh Claude session. Covers what we run on GCP, why
it is shaped this way, the exact commands, the free-tier limits that dictate the
throughput knobs, and every failure mode hit so far.

Documents the **8–14 Aug 2026** run cycle (the second weekly run in this project).

---

## 1. What the automation does

A Playwright/TypeScript suite logs into Adobe with school-issued accounts
(Bihar ICT + Kendriya Vidyalaya), clicks through to the dashboard, presses
"Let's Go", and stops. The goal is **activation**: proof that each account
successfully reached an authenticated Adobe dashboard.

- Entry point: `tests/adobe/script.spec.ts`
- Page logic: `src/pages/adobe.ts`, `src/pages/msProvider.ts`
- Reporting / markers: `src/adobe/reporter.ts`, `src/adobe/report-files.ts`
- Cloud config: `playwright.cloud.config.ts`, `Dockerfile`

Runs stop right after "Let's Go" (`ADOBE_STOP_AFTER_LETS_GO=1`), so an account
takes ~60–90s instead of ~6 min.

### Log markers (the entire results pipeline depends on these)

```
[ADOBE_LOGIN_OK]     email=... url=... elapsed_ms=... at=...
[ADOBE_LOGIN_FAIL]   email=... elapsed_ms=... reason="..."
[ADOBE_LETSGO_OK]    email=... via=api|ui owner_entity=... status=...
[ADOBE_RESULT]       status=passed|failed email=... logged_in=yes|no [step=... reason=...]
[ADOBE_TASK_SUMMARY] task=N of=M attempted=N login_ok=N login_fail=N passed=N failed=N skipped=N
```

`logged_in` is tracked separately from `status` on purpose: an account can log in
(= activated, which is what we report) and still fail a later step.

---

## 2. GCP architecture

```
xlsx (local)  ->  Email,Password CSV  ->  Cloud Shell
                                            |
                                     run-batches.sh
                                            |
                        +-------------------+-------------------+
                        |                                       |
                 upload CSV to GCS                    deploy + execute
                 gs://<project>-adobe-accounts/       Cloud Run Job
                   accounts/<RUN_ID>/batch-01.csv     <BASE_JOB_NAME>-batch-01
                                                              |
                                                     N tasks x 21 accounts
                                                              |
                                                    stdout -> Cloud Logging
                                                              |
                                              count-logins.sh / build-resume-csv.sh
```

Components used: **Cloud Run Jobs** (execution), **Artifact Registry** (image),
**Cloud Build** (image build), **Cloud Storage** (account CSV in, optional
reports out), **Cloud Logging** (the results database, in practice).

Regions: **asia-south1 (Mumbai)** and **asia-south2 (Delhi)**. Two regions is a
throughput trick, not redundancy — see the next section.

---

## 3. Free-tier / quota constraints (these dictate every number)

**Cloud Run quota is per-region: ~20 vCPU and ~40 GiB concurrent.** That single
fact drives the whole configuration:

| Knob | Value | Why |
|---|---|---|
| `CPU` | 2 | per task |
| `MEMORY` | 4Gi | per task |
| `PARALLELISM` | 8 | 8 x 2 = 16 vCPU, 8 x 4Gi = 32 GiB — fits 20/40 with headroom |
| `ADOBE_PLAYWRIGHT_WORKERS` | 4 | oversubscribes 2 vCPU; safe because the flow is mostly network wait |
| `ADOBE_SCRIPT_ACCOUNT_LIMIT` | 21 | accounts per task, so tasks = ceil(rows / 21) |
| `TASK_TIMEOUT` | 8h | a task of 21 accounts needs ~6–7 min; 8h is slack |

Consequences:

- **Two jobs in one region do not go faster than one.** They split the same
  20 vCPU. To actually double throughput you must use a *second region*.
- Peak concurrency per region is `PARALLELISM x WORKERS` = ~32 accounts in flight.
- A deploy that exceeds the quota fails at deploy time, or the execution sits at
  `runningCount: 0` forever.

**Other free-tier items to watch:**

- **Cloud Logging ingest** is free to 50 GiB/month/project. The markers are a few
  log lines per account; at 50–85k accounts/week this is the closest free-tier
  ceiling. Trim log volume, not accounts, if it becomes a problem.
- **Artifact Registry** storage: old image tags accumulate (3–4 per project).
  Delete stale tags if storage is charged.
- **Cloud Build** free minutes are ample — one ~5 min build per week.
- **Cloud Run** bills per vCPU-second while a task runs; a full week's run is
  thousands of vCPU-hours, which is the real cost driver.

**Project rotation:** we work inside a fresh GCP project per cycle rather than one
long-lived project. Observed so far:

- `project-517cd71a-7c2f-4e1b-af2` — earlier runs; still the hardcoded default in
  several scripts.
- `project-e075c147-6467-458f-a8f` — current (8–14 Aug cycle).

**Because of that rotation, always pass `PROJECT_ID` explicitly.** The script
defaults point at the *old* project and fail with
`Permission denied on resource project ...` or `projects/... does not exist`.

Cloud Shell account for this cycle: `deekshachaturvedihr@gmail.com`, repo checked
out at `~/Adobe-Typescript`.

---

## 4. One-time setup per new project

```bash
export PROJECT_ID=<new-project-id>
gcloud config set project $PROJECT_ID
REGION=asia-south1 bash scripts/setup-run.sh
```

`scripts/setup-run.sh` is idempotent: enable APIs (artifactregistry, cloudbuild,
storage, run, iam) → create SA `playwright-runner@<project>` → create Artifact
Registry repo `playwright-jobs` → create bucket `gs://<project>-adobe-accounts` →
IAM bindings (SA gets objectViewer + objectCreator + logWriter; the serverless
robot gets serviceAccountUser) → grant the **Cloud Build** SA
`storage.objectAdmin`, `artifactregistry.writer`, `logging.logWriter` → wait 15s
for IAM propagation → `gcloud builds submit`.

That Cloud Build grant matters: new GCP projects have no legacy
`<num>@cloudbuild.gserviceaccount.com` and fall back to
`<num>-compute@developer.gserviceaccount.com`, which has **no roles**. Without the
grant the build dies confusingly on its own staging bucket with a 403 on
`storage.objects.get`.

Only asia-south1 needs a registry. **asia-south2 pulls the asia-south1 image
cross-region** within the same project — no second build.

---

## 5. Build the image

Setup already ran, so build directly (faster than re-running `setup-run.sh`):

```bash
cd ~/Adobe-Typescript
git pull && git log --oneline -1          # the image is built FROM the checkout
export PROJECT_ID=project-e075c147-6467-458f-a8f
export TAG=$(date +%Y%m%d%H%M%S)
export IMAGE_URI=asia-south1-docker.pkg.dev/$PROJECT_ID/playwright-jobs/adobe-login-flow:$TAG
gcloud builds submit --tag="$IMAGE_URI" --project="$PROJECT_ID" .
```

List existing images / recover a URI:

```bash
gcloud artifacts docker images list \
  asia-south1-docker.pkg.dev/$PROJECT_ID/playwright-jobs/adobe-login-flow \
  --include-tags --sort-by=~CREATE_TIME --limit=5 \
  --format='table(package,tags,createTime)' --project=$PROJECT_ID
```

The tag is a UTC `date +%Y%m%d%H%M%S` from the build machine, so compare it
against `git log` to know which commits an image contains.

Image used this cycle: `...adobe-login-flow:20260808055411`.

---

## 6. Data prep (local Windows machine)

Source workbooks arrive as xlsx, e.g.
`Server_Bihar_ICT_Activation_8-14_Aug_26.xlsx` (sheet `Bihar Server`) and
`Server_KV_Activation_8-14_Aug_26.xlsx` (sheet `KV Server`), with columns
`S# | Name | Email Address | Password | Dist|Region`.

The runner needs exactly `Email,Password`. Convert with a throwaway dep so
`package.json` stays clean:

```bash
npm install --no-save --no-audit --no-fund xlsx
node -e "
const XLSX=require('xlsx'), fs=require('fs');
const jobs=[['Server_Bihar_ICT_Activation_8-14_Aug_26.xlsx','aug-week-csvs/bihar-0814.csv'],
            ['Server_KV_Activation_8-14_Aug_26.xlsx','aug-week-csvs/kv-0814.csv']];
for (const [src,dst] of jobs) {
  const wb = XLSX.readFile(src);
  const seen = new Set(), out = ['Email,Password'];
  for (const s of wb.SheetNames)
    for (const r of XLSX.utils.sheet_to_json(wb.Sheets[s], {defval:''})) {
      const e = String(r['Email Address'] ?? '').trim();
      const p = String(r['Password'] ?? '').trim();
      if (!e || !p || !e.includes('@')) continue;
      const k = e.toLowerCase(); if (seen.has(k)) continue; seen.add(k);
      out.push(e + ',' + p);
    }
  fs.writeFileSync(dst, out.join('\n') + '\n');
  console.log(dst + ': ' + (out.length - 1));
}"
```

Output goes to `aug-week-csvs/`, which is **git-ignored** — live credentials must
never be committed. (`.gitignore` covers `accounts*.csv`, `aug-week-csvs/`,
`*.xlsx`; `.gitattributes` forces LF on `*.sh`/`*.mjs` so a CRLF checkout does not
break bash with `bad interpreter: ...^M`.)

### Balance the split by COUNT, not by dataset

8–14 Aug lists: Bihar 18,263 + KV 43,820 = 62,083 (0 duplicate emails, 0 overlap
between the two files).

Splitting by dataset (Bihar → s1, KV → s2) leaves one region idle for ~17h.
Balance by count instead — each region gets ~31,041:

- asia-south1: `bihar-0814.csv` (18,263) then `kv-0814-a.csv` (12,779)
- asia-south2: `kv-0814-b.csv` (31,041)

```bash
H=$(head -1 aug-week-csvs/kv-0814-a.csv)
{ echo "$H"; tail -n +2 aug-week-csvs/kv-0814-a.csv | head -n 6390; }  > aug-week-csvs/kv-0814-a1.csv
{ echo "$H"; tail -n +2 aug-week-csvs/kv-0814-a.csv | tail -n +6391; } > aug-week-csvs/kv-0814-a2.csv
```

CSVs reach Cloud Shell via **⋮ → Upload**, which drops them in `$HOME` — move them
into `~/Adobe-Typescript/aug-week-csvs/` before launching.

---

## 7. Launch

```bash
cd ~/Adobe-Typescript
export PROJECT_ID=project-e075c147-6467-458f-a8f
export IMAGE_URI=asia-south1-docker.pkg.dev/$PROJECT_ID/playwright-jobs/adobe-login-flow:20260808055411

# verify rows FIRST — run-batches.sh exits 1 immediately if the CSV is missing
for f in bihar-0814 kv-0814-a1 kv-0814-a2 kv-0814-b; do
  printf '%s: ' "$f"; tail -n +2 aug-week-csvs/$f.csv | grep -c '[^[:space:]]'
done

REGION=asia-south1 INPUT_CSV=aug-week-csvs/bihar-0814.csv \
BASE_JOB_NAME=adobe-bihar-0814 RUN_ID=0814-bihar \
nohup bash scripts/run-batches.sh > ~/s1.log 2>&1 &

REGION=asia-south2 INPUT_CSV=aug-week-csvs/kv-0814-b.csv \
BASE_JOB_NAME=adobe-kv-0814b RUN_ID=0814-kvb \
nohup bash scripts/run-batches.sh > ~/s2.log 2>&1 &

sleep 120; tail -n 25 ~/s1.log; echo =====; tail -n 25 ~/s2.log
```

Healthy output ends with `Executing <job> (waiting for completion)...`.

What `scripts/run-batches.sh` does: sources `.env.local` → auto-detects
`TOTAL_ACCOUNTS` from the CSV → splits into batches (`BATCH_SIZE` defaults to the
full count, so ONE job) → uploads each batch CSV to
`gs://<bucket>/accounts/<RUN_ID>/batch-NN.csv` → `gcloud run jobs deploy` with
`tasks = ceil(rows/21)` and `--max-retries=0` → `gcloud run jobs execute --wait` →
posts Google Chat notifications per batch.

**Naming rule: week-stamp `BASE_JOB_NAME`.** Job names persist across weeks;
redeploying `adobe-kv` would overwrite last week's `adobe-kv-batch-01` and mix both
weeks' logs under one name, which breaks every `JOB_PREFIX` query. `RUN_ID` must
also be unique — it namespaces the GCS object paths.

**Notifications** need `GOOGLE_CHAT_WEBHOOK_URL` in `.env.local`, which is
git-ignored and therefore absent from a fresh clone. Without it the run works
silently. Notifications fire per *batch* only — per task would blow the Chat rate
limit at thousands of tasks. `scripts/notify-progress.sh` gives interval-based
aggregate updates.

---

## 8. Monitoring

```bash
gcloud run jobs list --region=asia-south1 --project=$PROJECT_ID
gcloud run jobs executions list --job=<job>-batch-01 --region=<region> --project=$PROJECT_ID \
  --format='table(name,status.runningCount,status.succeededCount,status.failedCount,status.completionTime)'
```

`runningCount` should reach `PARALLELISM` (8). Stuck at 0 = quota block, not a code
bug. Complete = `runningCount: 0` **and** a populated `completionTime`.

Login tallies via `scripts/count-logins.sh` (sums `[ADOBE_TASK_SUMMARY]`):

```bash
REGION=asia-south1 JOB_PREFIX=adobe-bihar-0814 FRESHNESS=3d bash scripts/count-logins.sh
JOB_PREFIX=adobe-kv-0814 FRESHNESS=3d bash scripts/count-logins.sh   # substring: matches a1+a2+b, all regions
```

Modes: `summary` (default, fast, authoritative), `accounts` (per-account proof CSV
of email/dashboard_url/at — slow), `failures` (grouped by reason).

`JOB_PREFIX` is a **substring** match on the job name, so a short prefix aggregates
several batches and regions into one total.

---

## 9. Measured results, 8–14 Aug cycle

| Job | Region | Accounts | Tasks | Window (UTC) | Logged in | Rate |
|---|---|---|---|---|---|---|
| `adobe-bihar-0814-batch-01` | asia-south1 | 18,263 | 870/870 ok | Aug 8 06:13 → Aug 9 11:11 (~29h) | 9,938 | 54.42% |
| `adobe-kv-0814b-batch-01` | asia-south2 | 31,041 | 1479/1479 ok | → Aug 10 06:31 (~48h) | 19,866 | 64.00% |
| `adobe-kv-0814a1` / `a2` | s1 / s2 | 12,779 | — | launched after the above completed | pending | — |

Totals at that point: **29,804 logged in of 49,304 attempted**; 19,500 failures.

**Real throughput is ~640 accounts/hour/region**, NOT the ~1,500/hr that
`PARALLELISM x WORKERS` at ~75s/account predicts. Use 640 for all planning:
~31k accounts per region ≈ 48h. Zero *task* failures in either region — every
failure was a per-account login failure, not lost infrastructure.

For context, the same code on 150 accounts locally logged in at 84–86%. The cloud
rate of 54–64% is a large unexplained gap, likely worth investigating (cloud IP
reputation / Adobe-side rate limiting) before assuming retries will close it.

---

## 10. Retry flow for failed accounts

`scripts/build-resume-csv.sh` + `build-resume-csv.mjs` diff the input CSV against
`[ADOBE_RESULT] status=passed` markers; anything not passed goes to a resume CSV.

```bash
SINCE=2026-08-08T00:00:00Z REGION=asia-south1 JOB_PREFIX=adobe-bihar-0814 \
INPUT_CSV=aug-week-csvs/bihar-0814.csv OUTPUT_CSV=aug-week-csvs/retry-bihar.csv \
bash scripts/build-resume-csv.sh
```

**`SINCE` defaults to 2 days ago — set it explicitly**, or an older run gets
clipped and already-passed accounts are retried.

### Faster alternative (log pulls are the slow part)

`gcloud logging read` pages through the API; pulling all 18k/31k markers takes many
minutes. Since every task completed, no account was silently lost, so the **failed
markers alone are the retry list** (~half the lines):

```bash
S=2026-08-08T00:00:00Z
gcloud logging read "resource.type=\"cloud_run_job\" AND resource.labels.location=\"asia-south1\" AND resource.labels.job_name:\"adobe-bihar-0814\" AND textPayload:\"ADOBE_RESULT\" AND textPayload:\"status=failed\" AND timestamp>=\"$S\"" \
  --project=$PROJECT_ID --limit=100000 --format='value(textPayload)' > ~/fail-bihar.txt

sed -n 's/.*\[ADOBE_RESULT\] status=failed email=\([^ ]*@[^ ]*\).*/\1/p' ~/fail-bihar.txt \
  | tr 'A-Z' 'a-z' | sort -u > /tmp/e.txt

{ head -1 aug-week-csvs/bihar-0814.csv
  awk -F, 'NR==FNR{f[$1];next} FNR>1 && (tolower($1) in f)' /tmp/e.txt aug-week-csvs/bihar-0814.csv
} > aug-week-csvs/retry-bihar.csv
```

For a *diagnosis sample* use `--limit=800` — it returns in seconds and is plenty to
see the reason distribution.

Launch retries at gentler concurrency, in case the failures are load-induced:

```bash
REGION=asia-south1 INPUT_CSV=aug-week-csvs/retry-bihar.csv \
BASE_JOB_NAME=adobe-retry-bihar RUN_ID=0814-rtbihar \
PARALLELISM=6 ADOBE_PLAYWRIGHT_WORKERS=3 \
nohup bash scripts/run-batches.sh > ~/r1.log 2>&1 &
```

Note: accounts that logged in but failed a later step land in the resume CSV even
though they ARE activated. The script reports that count; it was ~113 for Bihar,
small enough to ignore.

---

## 11. Gotchas hit in practice

1. **Wrong `PROJECT_ID`** → `Permission denied on resource project ...` or
   `projects/... does not exist`. Script defaults point at the *old* project.
   Always export `PROJECT_ID`.
2. **Empty results with no error** → the job-name prefix does not match. Enumerate
   with `gcloud run jobs list --region=<r>` per region; that is authoritative.
3. **Using `gcloud logging read --limit=N` to discover job names is misleading** —
   it returns the N most *recent* entries, so one busy job fills the whole window
   and hides the others. Use `jobs list`.
4. **Cloud Shell uploads land in `$HOME`**, not the current directory. Move files
   into `aug-week-csvs/` before launching.
5. **`run-batches.sh` exits 1 immediately if `INPUT_CSV` is missing** — before any
   gcloud call, so nothing ends up half-deployed. Verify row counts first.
6. **`&&`-chained launches die with the Cloud Shell VM** (it recycles after ~1h
   idle). The Cloud Run job survives server-side; the waiting shell does not, so
   the queued second job never starts. Check manually and launch by hand.
7. **Nested tmux**: `tmux new` inside an existing session warns "sessions should be
   nested with care". Reuse the session instead.
8. **`tail -20 f1 f2`** → `option used in invalid context`. Use `tail -n 20`.
9. **`FRESHNESS` defaults to 1d** in `count-logins.sh` — silently undercounts a
   multi-day run. Set it wider than the run window.
10. **`date -d "-1d"` is invalid GNU syntax**; the scripts normalize `2d`/`36h`
    shorthand into "2 days ago" internally.
11. **`--order=asc` on a large logging read is the slowest query shape.** Avoid it,
    or cap with `--limit`.
12. **`SAVE_ARTIFACTS=false` is the default**, so Cloud Logging is the only results
    store. See §12.
13. **Failure counts over-report if not deduped** — Playwright reprints a failed
    test's stdout in its recap (20 raw lines for 11 accounts), and its error output
    echoes the failing source line, which literally contains `email=${loginAccount}`.
    Marker parsers require an `@` in the email and dedupe by email for this reason.
14. **`MODE=failures` undercounts by design**: `[ADOBE_LOGIN_FAIL]` only fires for
    accounts that reached the dashboard wait. Earlier failures (provider password
    screen) never emit it. `MODE=summary` is authoritative. The gap between the two
    tells you how many died pre-dashboard.

---

## 12. Improvements for the next cycle

1. **Launch with `SAVE_ARTIFACTS=true`.** Per-account results then land in
   `gs://<project>-adobe-accounts/adobe-runs/<RUN_ID>/...`, and counting or
   building a retry list becomes `gcloud storage cat` + `awk` — seconds instead of
   a log crawl. Single biggest quality-of-life fix.
2. **Plan at 640 accounts/hr/region**, and split by count across both regions from
   the start.
3. **Investigate the 54–64% cloud rate vs 84–86% local** before spending ~15h on
   retries. Sample `[ADOBE_RESULT] status=failed` reasons with `--limit=800`; if
   they are credential errors, no amount of retrying helps.
4. **Do not rely on shell chaining** for sequential jobs — keep the Cloud Shell tab
   alive in tmux, or hand off manually.
5. **Consider a Cloud Run quota increase** for asia-south1/asia-south2 — raising
   `PARALLELISM` is the only real lever beyond adding regions.

---

## 13. Quick command reference

```bash
# context
export PROJECT_ID=project-e075c147-6467-458f-a8f
export IMAGE_URI=asia-south1-docker.pkg.dev/$PROJECT_ID/playwright-jobs/adobe-login-flow:<tag>

# what exists
gcloud run jobs list --region=asia-south1 --project=$PROJECT_ID
gcloud run jobs list --region=asia-south2 --project=$PROJECT_ID
gcloud artifacts docker images list asia-south1-docker.pkg.dev/$PROJECT_ID/playwright-jobs/adobe-login-flow \
  --include-tags --sort-by=~CREATE_TIME --limit=5 --format='table(package,tags,createTime)' --project=$PROJECT_ID

# is it done
gcloud run jobs executions list --job=<job>-batch-01 --region=<r> --project=$PROJECT_ID \
  --format='table(name,status.runningCount,status.succeededCount,status.failedCount,status.completionTime)'

# results
REGION=<r> JOB_PREFIX=<prefix> FRESHNESS=3d bash scripts/count-logins.sh
MODE=failures REGION=<r> JOB_PREFIX=<prefix> FRESHNESS=3d bash scripts/count-logins.sh
MODE=accounts REGION=<r> JOB_PREFIX=<prefix> FRESHNESS=3d bash scripts/count-logins.sh

# retry list
SINCE=<rfc3339> REGION=<r> JOB_PREFIX=<prefix> INPUT_CSV=<in> OUTPUT_CSV=<out> bash scripts/build-resume-csv.sh
```

### Script map

| Script | Purpose |
|---|---|
| `scripts/setup-run.sh` | one-time per project: APIs, SA, registry, bucket, IAM, first build |
| `scripts/run-batches.sh` | the launcher: split, upload, deploy, execute, notify |
| `scripts/run-india-2region.sh` | merge + dedupe + 50/50 split across both regions in one call |
| `scripts/count-logins.sh` | summary / accounts / failures tallies from logs |
| `scripts/build-resume-csv.sh` + `.mjs` | build a retry CSV of not-passed accounts |
| `scripts/notify-progress.sh` | interval aggregate Google Chat progress |
| `scripts/dispatch-job.sh` | single-job deploy + execute (simpler path) |
| `scripts/estimate-cloud-run-cost.mjs` | cost estimate |

### Related docs in this repo

`docs/gcp-setup.md` (full project setup), `docs/gcs-setup.md` (bucket/IAM),
`docs/gcp-cloud-run-job.md` (job basics), `docs/run-22k-login.md` and
`docs/run-38k-login.md` (earlier runbooks), `docs/source_of_truth.md` (flow
reference), `cmds.md` (ad-hoc command scratchpad).
