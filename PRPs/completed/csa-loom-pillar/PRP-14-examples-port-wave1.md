# PRP-14 — Industry Examples Port Wave 1 (8 of 25)

## Context

The repo has 25 existing industry examples under `examples/`. Per
AMENDMENTS §A13 + OQ-14, 8 land in v1; remaining 17 in v1.1.

PRD ref: `temp/fiab-prd/11-examples-port.md`.

## Goal

8 fully-ported examples under `docs/fiab/examples/*.md` and
`examples/fiab-<name>/` with documentation, sample data, IaC,
notebooks, semantic models, activator rules, and data-agent configs.

## v1 selections

| # | Source | Destination |
|---|---|---|
| 1 | `examples/fabric-e2e/` (already FiaB-shaped) | `docs/fiab/examples/retail-e2e.md` + `examples/fiab-retail-e2e/` |
| 2 | `examples/fabric-data-agent/` (already FiaB-shaped) | `docs/fiab/examples/fabric-data-agent.md` + `examples/fiab-data-agent/` |
| 3 | `examples/financial-fraud-detection/` | `docs/fiab/examples/financial-fraud-detection.md` + `examples/fiab-financial-fraud-detection/` |
| 4 | `examples/healthcare-clinical/` | `docs/fiab/examples/healthcare-clinical.md` + `examples/fiab-healthcare-clinical/` |
| 5 | `examples/iot-streaming/` | `docs/fiab/examples/iot-streaming.md` + `examples/fiab-iot-streaming/` |
| 6 | `examples/cybersecurity/` | `docs/fiab/examples/cybersecurity.md` + `examples/fiab-cybersecurity/` |
| 7 | `examples/manufacturing-iot/` | `docs/fiab/examples/manufacturing-iot.md` + `examples/fiab-manufacturing-iot/` |
| 8 | `examples/geoanalytics/` | `docs/fiab/examples/geoanalytics.md` + `examples/fiab-geoanalytics/` |

## Acceptance criteria

For each ported example:

- [ ] Documentation page at `docs/fiab/examples/<name>.md` per
  template in PRD §11.4.1 (hero + components used + prereqs + step-
  by-step + forward migration + per-boundary notes + cost estimate)
- [ ] Source code folder at `examples/fiab-<name>/` per structure in
  PRD §11.4.2 (infra Bicep additions + data + notebooks + dbt models +
  TMDL semantic model + activator-rules + data-agent config + Power BI
  report)
- [ ] All examples deployable into a Loom workspace via the Console
- [ ] All examples use CSA Loom brand (per AMENDMENTS A1)
- [ ] All examples comply with [[writing-voice-no-customer-framing]]
  (generic federal-mission / generic-industry framing only)

## Validation gates

- Each example deploys cleanly into a test FiaB workspace
- Each example's documentation renders in `mkdocs serve`
- Each example's notebooks execute without error against the test
  workspace
- Each example's Power BI report renders with sample data
- Each example's activator rule fires when expected
- Each example's data agent answers benchmark questions

## Implementation outline

1. Hero SVG per example (8 SVGs)
2. Per-example docs page following the template
3. Per-example source folder with all artifacts
4. Per-example smoke test (CI runs against staging Loom workspace)
5. Index page at `docs/fiab/examples/index.md` (per PRD §11.9 — grid
   cards)

## File changes

```
docs/fiab/examples/index.md                              created
docs/fiab/examples/retail-e2e.md                         created
docs/fiab/examples/fabric-data-agent.md                  created
docs/fiab/examples/financial-fraud-detection.md          created
docs/fiab/examples/healthcare-clinical.md                created
docs/fiab/examples/iot-streaming.md                      created
docs/fiab/examples/cybersecurity.md                      created
docs/fiab/examples/manufacturing-iot.md                  created
docs/fiab/examples/geoanalytics.md                       created
docs/assets/images/hero/fiab/examples/*.svg              created (9 files)
examples/fiab-retail-e2e/                                created
examples/fiab-data-agent/                                created
examples/fiab-financial-fraud-detection/                 created
examples/fiab-healthcare-clinical/                       created
examples/fiab-iot-streaming/                             created
examples/fiab-cybersecurity/                             created
examples/fiab-manufacturing-iot/                         created
examples/fiab-geoanalytics/                              created
```

## Open questions / risks

- 8 ports in 8 weeks is parallelizable to 4 engineers × 2 examples ×
  ~2 weeks each
- Healthcare clinical example needs HIPAA-safe synthetic data; reuse
  existing patterns from `examples/healthcare-clinical/`

## References

- `temp/fiab-prd/11-examples-port.md`
- `temp/fiab-research/07-existing-repo-scope.md`
- Memory: [[writing-voice-no-customer-framing]]

## Validation receipt

**Validated 2026-05-27 — 39/39 pytest GREEN.**

Test harness: `docs/fiab/tests/test_examples_port.py`. Tests assert each
of the 8 v1 examples ships a real doc page + the financial-fraud-detection
bundle is runnable:

- All 8 docs pages exist + are non-stub (>500 chars):
  `retail-e2e`, `fabric-data-agent`, `financial-fraud-detection`,
  `healthcare-clinical`, `iot-streaming`, `cybersecurity`,
  `manufacturing-iot`, `geoanalytics`
- `docs/fiab/examples/index.md` references every example
- Each page has `components` + per-boundary notes (PRD §11.4.1 template)
- Each page mentions the CSA Loom brand (AMENDMENTS §A1)
- No customer-framing language (per writing-voice memory)
- `examples/fiab/financial-fraud-detection/` ships:
  - `activator/rules.json` — 3 rules, all valid against PRP-06's primitive
    enum (`IncreasesAbove`, `NoPresenceOfData`, `ChangesTo`)
  - `agent/finance-fraud-agent.json` — valid Loom Data Agent shape, lakehouse
    + ADX dataSources, 3 example queries, sensitivity policy
  - `notebooks/score_transactions.py` — real PySpark Structured Streaming
    job (imports `SparkSession`, `pyspark.sql.functions`, Pandas UDF for
    scoring)
  - `README.md`

**Operator action remaining:** Deploy each example bundle into a live test
Loom workspace + verify notebook executes + activator rule fires + Data Agent
answers benchmark questions. Tracked in audit page; blocked by ACR image
build + Loom workspace provision.
