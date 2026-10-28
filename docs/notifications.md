# Google Chat notifications

Every GCP run reports itself to the Google Chat space, so nobody has to watch the
launcher or read logs. You only need to look when an alert arrives.

## Setup (once per machine that launches runs)

Put the webhook in `.env.local` at the repo root. The file is git-ignored and kept out of
the Docker image:

```
GOOGLE_CHAT_WEBHOOK_URL='https://chat.googleapis.com/v1/spaces/…/messages?key=…&token=…'
```

`scripts/run-batches.sh` (and `run-india-2region.sh`, which calls it) loads it and passes
it to the Cloud Run tasks as an env var. Without it, nothing is posted. The image must be
built from this version (`bash scripts/setup-run.sh`), because the tasks run
`scripts/run-notify.mjs`.

## What gets posted

| When | Who posts | Where |
|---|---|---|
| 🚀 Run triggered: accounts, tasks, mode, sizing, rough time estimate, image, run id | launcher | run thread |
| ▶️ Batch launched | launcher | run thread |
| ▶️ Tasks started, i.e. the first task is actually running | task 0 | run thread |
| 📊 Progress at every 10% of tasks: Login + Download / Login only / Login failed, elapsed, time left. Warns if the login rate falls below 50% | the task that crosses each 10% | run thread |
| 🚨 Logins failing: a task with 0 logins out of 3 or more accounts (captcha/block, bad passwords) | first task that hits it | **new message** |
| 🚨 Downloads failing: a task where 3 or more accounts logged in but none downloaded | first task that hits it | **new message** |
| 🚨 Task crashed: no results summary (out of memory, browser crash) | first task that hits it | **new message** |
| 🚨 Task failed before testing started (accounts CSV download, slicing) | first task that hits it | **new message** |
| ❌ Execution failed: tasks crashed, timed out or never scheduled (quota) | launcher | **new message** |
| 🏁 Run finished: totals, crashed tasks, duration, and the report command | the last task to finish | **new message** |

Each alert kind posts **once per execution**, so a systematic problem, for example
captcha on every task, gives one alert and not a thousand. The final summary counts all
of them. Two regions launched with `run-india-2region.sh` share one thread, and each
message names its job and region.

## How it works

- `scripts/run-batches.sh` posts the trigger and the launcher-side failures.
- Everything else comes from inside the tasks (`scripts/run-cloud-batch.sh` →
  `scripts/run-notify.mjs`). It therefore still arrives when the launcher is closed or the
  laptop sleeps.
- The tasks coordinate through small objects under
  `gs://<reports bucket>/adobe-runs/<run>/<batch>/status/<execution>/`:
  - `tasks/<n>.json` is one tally per finished task.
  - `sent/*` holds markers created with "only if absent". Each marker makes sure exactly
    one task posts a given milestone, alert or the final summary.

## Limits

- A task killed from outside (out of memory, or the 8h task timeout) never records a
  tally, so the 🏁 final summary does not come. The launcher's ❌ "execution FAILED"
  covers that case, as long as the launcher is still running. Either way, the per-account
  report (`bash scripts/build-run-report.sh`) still works from the logs.
- "Tasks started" only proves that the first task is running. If no ▶️ arrives within a
  few minutes of 🚀, the execution is probably stuck on quota.

## Testing without posting

```bash
ADOBE_NOTIFY_DRY_RUN=1 ADOBE_STATUS_URI=tmp/notify-status CLOUD_RUN_TASK_COUNT=2 \
CLOUD_RUN_TASK_INDEX=0 node scripts/run-notify.mjs task-end <playwright.log> 1 21
```

This prints the messages instead of posting them, and uses a local directory in place of
GCS.
