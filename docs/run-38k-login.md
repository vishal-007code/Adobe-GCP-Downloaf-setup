# Run 38k Accounts Until Login

Use this runbook when you need to process a large account CSV in Cloud Run Jobs and stop after the login/dashboard check.

## Important Behavior

- The account CSV is downloaded from GCS at container startup.
- Cloud Run task sharding is enabled automatically through `CLOUD_RUN_TASK_INDEX` and `CLOUD_RUN_TASK_COUNT`.
- Each Cloud Run task receives a different subset of accounts.
- `ADOBE_STOP_AFTER_LOGIN=1` stops the test after `waitForDashboard()` succeeds.
- Retries stay disabled because this project treats accounts as consumable.
- The deploy script can send run updates into Google Chat when `GOOGLE_CHAT_WEBHOOK_URL` is set.
- Each task uploads its merged result CSV, consumed ledger, and a summary JSON to GCS after it finishes.

Do not run multiple executions against the same full CSV at the same time. Use one Cloud Run Job execution with many tasks instead.

## Recommended Starting Config

For 38,000 accounts, start with 200 Cloud Run tasks and 100 running at once:

```bash
export TASKS=200
export PARALLELISM=100
export ADOBE_PLAYWRIGHT_WORKERS=1
export ADOBE_STOP_AFTER_LOGIN=1
export TASK_TIMEOUT=24h
export CPU=2
export MEMORY=2Gi
export GOOGLE_CHAT_WEBHOOK_URL=https://chat.googleapis.com/v1/spaces/...
export TOTAL_ACCOUNTS=38000
export AVG_SECONDS_PER_ACCOUNT=90
export REPORTS_BUCKET=new-adobe-type-adobe-accounts
export REPORTS_OBJECT_PREFIX=adobe-runs

bash scripts/deploy-gcp-cloud-run-job.sh
```

This assigns about 190 accounts to each task:

```text
38000 accounts / 200 tasks = about 190 accounts per task
```

With `PARALLELISM=100`, Cloud Run runs about 100 browsers at a time because each task uses one Playwright worker.

At the current defaults, the peak burn is about `$14.40/hour` when `PARALLELISM=100`, `CPU=2`, and `MEMORY=2Gi`.
If the average login takes `90 seconds`, a 38,000-account run is roughly `$136.80` total on Cloud Run compute.

If your Google Cloud quota allows more instances, increase `PARALLELISM`:

```bash
export PARALLELISM=200
```

That runs all 200 tasks at once.

## Sizing Formula

Use this formula to estimate required concurrency:

```text
required_concurrency = total_accounts * average_seconds_per_account / target_seconds
```

Examples for 38,000 accounts:

```text
60 seconds/account, 24 hours target  = about 27 concurrent browsers
120 seconds/account, 24 hours target = about 53 concurrent browsers
180 seconds/account, 24 hours target = about 80 concurrent browsers
120 seconds/account, 12 hours target = about 106 concurrent browsers
```

In this repo:

```text
active_concurrency = PARALLELISM * ADOBE_PLAYWRIGHT_WORKERS
```

Keep `ADOBE_PLAYWRIGHT_WORKERS=1` unless you also increase CPU and memory per task. One browser per Cloud Run task is easier to reason about and reduces memory pressure.

## Test With a Small CSV First

Before running all 38k, create a smaller CSV and run:

```bash
export ACCOUNTS_CSV=sample-100.csv
export OBJECT_NAME=sample-100.csv
export TASKS=10
export PARALLELISM=5
export ADOBE_PLAYWRIGHT_WORKERS=1
export ADOBE_STOP_AFTER_LOGIN=1
export TASK_TIMEOUT=2h
export GOOGLE_CHAT_WEBHOOK_URL=https://chat.googleapis.com/v1/spaces/...
export REPORTS_BUCKET=new-adobe-type-adobe-accounts
export REPORTS_OBJECT_PREFIX=adobe-runs

bash scripts/deploy-gcp-cloud-run-job.sh
```

Check that logs show:

```text
Login flow completed successfully
```

Also check for shard logs like:

```text
Adobe account shard 1/10: 10 account(s) assigned.
```

## Run the Full CSV

After the sample run is clean:

```bash
export ACCOUNTS_CSV=accounts.csv
export OBJECT_NAME=accounts.csv
export TASKS=200
export PARALLELISM=100
export ADOBE_PLAYWRIGHT_WORKERS=1
export ADOBE_STOP_AFTER_LOGIN=1
export TASK_TIMEOUT=24h
export CPU=2
export MEMORY=2Gi

bash scripts/deploy-gcp-cloud-run-job.sh
```

If you update only job settings and do not change code, you can execute the existing job again:

```bash
gcloud run jobs execute adobe-login-flow \
  --region=us-central1 \
  --wait
```

## Monitoring

Watch Cloud Run Job execution logs for:

```text
Adobe account shard X/Y: N account(s) assigned.
Login flow completed successfully
```

If the run is too slow, increase `PARALLELISM` first.

If tasks run out of memory, keep `ADOBE_PLAYWRIGHT_WORKERS=1` and increase `MEMORY`.

If tasks hit timeout, increase `TASK_TIMEOUT` or increase `TASKS` so each task receives fewer accounts.

## Check Billing

For the actual charge, use the Cloud Billing Cost table report and filter by your project and the `Cloud Run` service.
Cloud Run pricing is based on vCPU-seconds and GiB-seconds, rounded up to the nearest 100 ms.

With the current defaults in this repo, one active Cloud Run task costs about `$0.144/hour`.
At `PARALLELISM=100`, peak spend is about `$14.40/hour`.
If the average login takes `90 seconds`, a 38,000-account run is about `$136.80` on Cloud Run compute.

## Failure Rules

- Keep `--max-retries=0`.
- Keep the same `TASKS` value for one full run.
- If a task fails, inspect the task logs before re-running.
- Re-running the same full CSV can re-attempt accounts because consumed-account state is local to each container execution.

## Current Limitation

The project writes Playwright and Adobe CSV reports inside each container. Cloud Run container files are not persisted after the task exits. For a large production run, use Cloud Logging for immediate monitoring, or add a follow-up change to upload `playwright-report/` if you need the HTML report preserved as well.
