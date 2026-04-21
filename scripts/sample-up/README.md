# `scripts/sample-up/` — single-command vertical bring-up (CSA-0052)

Stage scripts for `make sample-up NAME=<vertical>`. The Makefile target
runs these in order and aborts at the first non-zero exit.

Pipeline stages:

| Stage       | Script                  | What it does                                                |
| ----------- | ----------------------- | ----------------------------------------------------------- |
| 1. validate | `01-validate.sh`        | Confirms `examples/<vertical>/` exists and has the required files |
| 2. deploy   | `02-deploy.sh`          | Runs `scripts/deploy/deploy-platform.sh --dry-run` by default; pass `FULL_DEPLOY=1` for a real deploy |
| 3. seed     | `03-seed.sh`            | Invokes `scripts/seed/load_sample_data.py --mode local`     |
| 4. dbt      | `04-dbt.sh`             | `dbt deps && dbt run && dbt test` in `domains/shared/dbt`   |
| 5. verify   | `05-verify.sh`          | Smoke-check: portal health endpoint + dbt row counts        |

Each script is POSIX-bash, uses `set -euo pipefail`, logs to stdout,
and echoes a clear `TODO:` banner when an underlying capability is
missing for the vertical in question. The scripts intentionally do
**not** duplicate deploy logic — they call existing scripts under
`scripts/deploy/` and `scripts/seed/` so the sample-up pipeline and
the canonical deploy path stay in lockstep.

## Running manually

```bash
make sample-up NAME=usda            # full chain
bash scripts/sample-up/01-validate.sh usda   # one stage
```

## Design intent

Aligns the 60-90 minute QUICKSTART path with the 15-minute target in
the audit by offering a single command that `validate → deploy →
seed → dbt → verify` in one go, with clear failure isolation per
stage.
