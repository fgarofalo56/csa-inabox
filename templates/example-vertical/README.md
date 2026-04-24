# CSA-in-a-Box — Example Vertical Cookiecutter Template


This [Cookiecutter](https://cookiecutter.readthedocs.io/) template scaffolds a
new analytics vertical that conforms to the CSA-in-a-Box vertical structure —
matching the patterns already shipped under `examples/noaa/`, `examples/epa/`,
`examples/iot-streaming/`, etc.

The generated skeleton includes:

- `README.md` with the canonical section layout (Architecture, Streaming
  Patterns, Directory Structure, Deployment, Related Documentation).
- `ARCHITECTURE.md` with a Mermaid diagram starter.
- `domains/dbt/` — dbt medallion project (bronze / silver / gold) with `sources`
  correctly declared in `models/schema.yml` (not in `dbt_project.yml` — see
  CSA-0089).
- `data/generators/generate_seed.py` + pytest — deterministic `--seed`
  generator following the iot-streaming pattern (sha256 stability guaranteed).
- `deploy/bicep/main.bicep` — a starter Bicep that references the shared
  modules under `deploy/bicep/shared/modules/`.
- `contracts/*.yaml` — an example data contract.

## Usage

### Via `scripts/new-vertical.sh` (recommended)

From the repo root:

```bash
bash scripts/new-vertical.sh
```

The script runs `cookiecutter templates/example-vertical/ -o examples/` and
prints next-step guidance.

### Directly with cookiecutter

```bash
pip install "cookiecutter>=2.6.0,<3.0.0"
cookiecutter templates/example-vertical/ -o examples/
```

You will be prompted for:

| Variable                 | Example                                   |
|--------------------------|-------------------------------------------|
| `vertical_name`          | `NOAA Climate`                            |
| `vertical_slug`          | `noaa-climate`                            |
| `description`            | `Weather + ocean buoys.`                  |
| `fedramp_level`          | `moderate` / `high` / `il4` / `il5`       |
| `domain_owner`           | `data-team@contoso.com`                   |
| `uses_streaming`         | `yes` / `no`                              |
| `uses_iot`               | `yes` / `no`                              |
| `sample_frequency_hours` | `1` (hourly), `24` (daily)                |

### Non-interactive

```bash
cookiecutter templates/example-vertical/ -o examples/ --no-input \
    vertical_slug=my-vertical \
    vertical_name="My Vertical" \
    description="What it does" \
    domain_owner=me@example.com
```

## Conformance lint

After generating a vertical, run:

```bash
bash scripts/lint-vertical.sh examples/<your-vertical-slug>
```

The linter verifies the vertical matches the canonical structure and will
fail any CI job that lands an out-of-spec vertical. The workflow is wired up
at `.github/workflows/vertical-conformance.yml`.

## What does the lint check?

1. `README.md` exists and has the required sections.
2. `domains/dbt/dbt_project.yml` exists.
3. `dbt_project.yml` does **not** contain a top-level `sources:` block — dbt
   rejects this and it is the exact bug CSA-0089 fixed across the fleet.
4. `deploy/bicep/` exists.
5. `contracts/` exists.
6. Any generator `generate_*.py` supports a `--seed` flag.

Exit codes: `0` conformant, `1` violations (printed to stdout).

## Related

- [`examples/README.md`](../../examples/README.md) — vertical index
- [`docs/runbooks/dbt-ci.md`](../../docs/runbooks/dbt-ci.md) — dbt-ci workflow
- [`docs/tutorials/great-expectations.md`](../../docs/tutorials/great-expectations.md) — data quality tutorial
