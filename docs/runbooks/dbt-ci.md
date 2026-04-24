[Home](../../README.md) > [Docs](../) > [Runbooks](./) > **dbt CI**

# dbt CI Runbook (CSA-0089)


!!! note
    **Quick Summary**: The `dbt-ci` GitHub Actions workflow runs
    `dbt deps`, `dbt parse`, and `dbt compile` for all 14 vertical dbt
    projects on every pull request and on pushes to `main` /
    `audit/**`. It validates YAML and Jinja without touching a real
    warehouse by routing every profile through an offline DuckDB stub.
    Real `dbt run` / `dbt test` stay in
    [`deploy-dbt.yml`](../../.github/workflows/deploy-dbt.yml).

This runbook covers: what the workflow does, how to triage a failing
PR, how to reproduce failures locally, and how to bump the dbt version
or add a new project.

## 📑 Table of Contents

- [🎯 1. What the workflow does](#-1-what-the-workflow-does)
- [🚦 2. My PR is blocked by dbt-ci — now what?](#-2-my-pr-is-blocked-by-dbt-ci--now-what)
- [🧪 3. Reproduce locally](#-3-reproduce-locally)
- [➕ 4. Adding a new dbt project](#-4-adding-a-new-dbt-project)
- [🔄 5. Bumping the dbt version](#-5-bumping-the-dbt-version)
- [📦 6. Caching](#-6-caching)
- [🧩 7. Known limitations](#-7-known-limitations)
- [🔗 8. Related](#-8-related)

---

## 🎯 1. What the workflow does

Workflow file:
[`.github/workflows/dbt-ci.yml`](../../.github/workflows/dbt-ci.yml).

1. **Discover**: a setup job enforces that every project in the
   canonical list has a `dbt_project.yml` and warns if a new
   `dbt_project.yml` appears outside that list.
2. **Matrix**: fan out one job per project (`fail-fast: false`) so one
   vertical's failure does not hide others.
3. **Install adapters**: `dbt-core`, `dbt-duckdb`, `dbt-databricks`,
   `dbt-spark` — all `>=1.7,<2.0`. DuckDB is the actual CI adapter;
   the others are installed so projects that reference
   adapter-specific macros still parse.
4. **Stub profile**: every profile name used across the 14 projects
   (`csa_analytics`, `casino_analytics`, `dot_analytics`,
   `csa_iot_streaming`, `tribal_health_analytics`, `usps_analytics`)
   is mapped to a single in-memory DuckDB target via a YAML anchor.
5. **Run**: `dbt deps` (conditional on `packages.yml`) → `dbt parse` →
   `dbt compile`. Any failure uploads the project's `target/` and
   `logs/` directories as an artifact.
6. **Summary**: on pull requests, a sticky comment reports pass/fail
   and links to the run.

Timeout: 15 minutes per matrix entry. Concurrency: one run per ref,
in-progress runs are cancelled on push.

---

## 🚦 2. My PR is blocked by dbt-ci — now what?

1. **Open the failing check** from the PR "Checks" tab. The matrix
   entry name is `Parse+compile (<project-path>)`.
2. **Read the failing step's log**. The three steps that can fail are:
   - `dbt deps` — usually a `packages.yml` version range that can't
     be resolved, or a transient network blip. Re-run first.
   - `dbt parse` — YAML/Jinja error. The log cites the file and line.
   - `dbt compile` — unresolved `ref()`, `source()`, or macro. Often
     a typo or a model that was renamed/moved without updating refs.
3. **Download the artifact** named
   `dbt-target-<index>-<attempt>`. It contains the project's
   `target/` (including `manifest.json` if parse succeeded far
   enough) and `logs/dbt.log`. `dbt.log` has the full stack trace
   even when the console output truncated it.
4. **Fix and push**. The workflow reruns automatically. The sticky PR
   comment is updated in place — no extra noise.

**Common failure modes:**

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Compilation Error ... depends on a node named X which was not found` | A `ref()` points to a deleted/renamed model. | Update the `ref()` or restore the model. |
| `Server error: Could not find profile named 'X'` | A new profile was introduced. | Add `X:` to the stub `profiles.yml` block in `dbt-ci.yml`. |
| `Version X of dbt-labs/dbt_utils is not in the list of valid versions` | Package range is pinned too tightly. | Widen `packages.yml` range or run `dbt deps` locally and pin. |
| `Jinja error at line N: ...` | Macro signature drift. | Reproduce locally (§3) — parse prints the exact template. |
| Many projects fail simultaneously | dbt-core release broke compat. | See §5 (version bump). |

---

## 🧪 3. Reproduce locally

A companion script mirrors the workflow for one project:

```bash
# Install once
python -m pip install --upgrade pip
pip install "dbt-core>=1.7,<2.0" "dbt-duckdb>=1.7,<2.0"

# Default: iot-streaming
bash .github/workflows/dbt-ci-smoke.sh

# Any project
bash .github/workflows/dbt-ci-smoke.sh domains/finance/dbt
bash .github/workflows/dbt-ci-smoke.sh examples/usda/domains/dbt
```

The script:
- Writes the same stub `profiles.yml` to `.dbt-ci-smoke/`.
- Runs `dbt deps` (if applicable), `dbt parse`, `dbt compile`.
- Exits `2` with a SKIP message if dbt is not installed.

If the local run passes but CI fails, check:
- Local dbt version matches the CI pins (`dbt --version`).
- You're running on a clean clone — stale `target/` or
  `dbt_packages/` can mask issues (`rm -rf target dbt_packages`).

---

## ➕ 4. Adding a new dbt project

1. Create the project under `domains/<name>/dbt/` or
   `examples/<vertical>/domains/dbt/`.
2. Add the path to the `EXPECTED` array in the `discover-projects`
   step of `.github/workflows/dbt-ci.yml`.
3. If the `dbt_project.yml` declares a profile name that isn't already
   in the stub `profiles.yml` block (§1 step 4), add an alias:
   ```yaml
   my_new_profile: *ci_duckdb
   ```
4. Push a PR. The discovery step will error loudly if you forget
   step 2; the parse step will error if you forget step 3.

---

## 🔄 5. Bumping the dbt version

The pins live in one place:

```yaml
# .github/workflows/dbt-ci.yml — "Install dbt adapters" step
pip install \
  "dbt-core>=1.7,<2.0" \
  "dbt-duckdb>=1.7,<2.0" \
  "dbt-databricks>=1.7,<2.0" \
  "dbt-spark>=1.7,<2.0"
```

Procedure:

1. Read the dbt-core release notes for breaking changes (especially
   Jinja/macro deprecations).
2. Bump all four adapters to the same minor range in one PR.
3. Also bump the pin in
   [`deploy-dbt.yml`](../../.github/workflows/deploy-dbt.yml)
   (currently `dbt-databricks==1.8.*`) so prod matches CI.
4. If a project's `require-dbt-version` in `dbt_project.yml` excludes
   the new range, update it in the same PR.
5. Watch the first `dbt-ci` run after merge — the cache key is
   keyed on `pyproject.toml`, so bumping adapter versions will cause
   one cold-cache run.

---

## 📦 6. Caching

`actions/cache@v4` caches `~/.cache/pip` plus each project's
`dbt_packages/` directory. Cache key:

```
dbt-ci-<os>-py312-<hashFiles('**/packages.yml', '**/dbt_project.yml')>-<project>
```

Invalidation is automatic when any `packages.yml` or
`dbt_project.yml` changes. To force a cold rebuild without changing
code, bump the literal `dbt-ci-` prefix in the key.

---

## 🧩 7. Known limitations

- **No `dbt run` / `dbt test`**: the stub profile is in-memory DuckDB
  — it won't have Delta, Unity Catalog, or the vertical-specific
  seeds needed for a real run. Those assertions live in
  `deploy-dbt.yml` against the dev Databricks workspace.
- **Adapter-specific SQL**: macros that emit Databricks- or
  Spark-only SQL may compile under DuckDB but wouldn't actually
  execute. Compile errors here are still real; compile successes
  don't prove the SQL will run.
- **Package downloads**: `dbt deps` requires network access to the
  dbt package hub. If the hub is down, CI will fail transiently —
  re-run the job.

---

## 🔗 8. Related

- Workflow: [`.github/workflows/dbt-ci.yml`](../../.github/workflows/dbt-ci.yml)
- Local smoke: [`.github/workflows/dbt-ci-smoke.sh`](../../.github/workflows/dbt-ci-smoke.sh)
- Prod deploy: [`.github/workflows/deploy-dbt.yml`](../../.github/workflows/deploy-dbt.yml)
- All runbooks: [`docs/runbooks/`](./)
