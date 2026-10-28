# Run report: Login only vs Login + Download

How a run records each account's outcome and how to build the per-account report from
GCP. PNGs are **not** kept. The record that the download finished is enough.

## What gets recorded per account

The test attaches proof as it goes (`tests/adobe/script.spec.ts`), and the reporter
(`src/adobe/reporter.ts`) turns it into one line per account in the Cloud Run logs:

```
[ADOBE_RESULT] status=passed email=a@x.in logged_in=yes downloaded=yes outcome=login_download login_s=31.0 editor_open_s=24.6 export_s=11.2 editor_reloads=0
[ADOBE_RESULT] status=failed email=b@x.in logged_in=yes downloaded=no outcome=login_only login_s=33.4 step="Download (after reload 2)" reason="..."
[ADOBE_RESULT] status=failed email=c@x.in logged_in=no downloaded=no outcome=no_login step="Login with accounts.google.com" reason="..."
```

- `downloaded=yes` means the PNG export finished. It is set from the download attachment,
  which is the test's last step, not from `status`. An activation-only run
  (`ADOBE_STOP_AFTER_LETS_GO=1`) therefore passes with `outcome=login_only`.
- `logged_in=yes` means the Adobe dashboard was reached, even if a later step failed.
- Timings (seconds) appear once that point was reached:
  - `login_s`: from the test start to the dashboard.
  - `editor_open_s`: from opening the postcard to the editor's Download button being enabled. Editor reloads are included.
  - `export_s`: from the Download button to the PNG being saved.
  - `editor_reloads`: how many editor reloads were needed.
- The same fields are in the local results CSV (`reports/adobe_results_<run>.csv`, columns
  `downloaded`, `outcome`, `login_s`, `editor_open_s`, `export_s`, `editor_reloads`).
- Each task's `[ADOBE_TASK_SUMMARY]` line now also carries `downloaded=N`, so
  `bash scripts/count-logins.sh` prints logged in, + downloaded, and login only totals.

## Build the report from GCP

```bash
INPUT_CSV=accounts.csv SINCE=2026-10-25T00:00:00Z bash scripts/build-run-report.sh
```

This pulls every `[ADOBE_RESULT]` line from Cloud Logging. It covers both India regions
and every job whose name contains `JOB_PREFIX` (default `adobe-login`). It then writes:

| File | What |
|---|---|
| `reports/run-report-<stamp>.csv` | one row per account: `result` = **Login + Download** / **Login only** / **Login failed** / **Not run**, plus the last failed step and reason, whether credentials were rejected, and the timings |
| `tmp/missing-downloads.csv` | Email,Password of every account without a download, except rejected credentials. Re-run these. |
| `tmp/dead-accounts.csv` | accounts whose password or account was rejected; no re-run can help |

It also prints the counts per result and avg/p50/p90 of login, editor-open and export
time.

If an account appears in several runs, its best result wins. A re-run that downloads
upgrades an earlier "Login only". Set `SINCE` to the start of the run, or older runs in
the same project are mixed in. The raw lines are kept in `tmp/run-report-logs-*.txt`.
To rebuild without fetching again:
`node scripts/build-run-report.mjs accounts.csv --logs=tmp/run-report-logs-<stamp>.txt`.

Local runs: `node scripts/build-run-report.mjs accounts.csv` reads
`reports/adobe_results_*.csv` instead of the logs.

## Re-running the accounts without a download

```bash
INPUT_CSV=tmp/missing-downloads.csv bash scripts/run-batches.sh         # cloud
ADOBE_ACCOUNTS_CSV=tmp/missing-downloads.csv npm run test:adobe          # local
```

Inside a run, an account already gets two chances before it lands here:
- **Editor reloads.** `downloadDesign()` makes up to 3 attempts, reloading the editor
  between them.
- **One test retry.** The account runs again with a fresh login (`ADOBE_TEST_RETRIES`,
  default 1).

## Keeping the PNGs (off by default)

Set `DOWNLOADS_GCS_URI=gs://<bucket>/downloads` for `run-batches.sh`, or
`ADOBE_DOWNLOADS_GCS_URI` for the task. Each test then also uploads its PNG as
`<email>.png` (`src/adobe/download-upload.ts`). An upload failure then fails the test.
Unset or `off` means no upload; the PNG dies with the container.
