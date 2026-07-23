# dax-golden — DAX numeric-correctness harness (A5)

Source of truth: `ws-lineage-depth.md` A5. This is a **test/verification surface**
(no product UI), so per the `loom-next-level` PRP it carries an explicit
**Per-cloud: cloud-neutral** declaration plus an IL5 design note rather than the
full per-cloud contract.

The harness gates the **numeric result** of every *implemented* DAX function
against a seeded Sales/Date/Customer reference model on a **real
Synapse-serverless backend** — the correctness gate for the A1→A2→A3 DAX→SQL
fold engine. It does **not** gate its own existence: a function is asserted live
only once its fold lands (`implemented:true`).

## Files

| Path | Role |
|------|------|
| `apps/fiab-console/lib/azure/__tests__/dax-golden/data/{sales,date,customer}.csv` | Seeded star-schema reference data (12 monthly Sales rows × 2 yrs, 4 Customers, 24-month Date dim). |
| `apps/fiab-console/lib/azure/__tests__/dax-golden/model.json` | The semantic-model content (tables/columns/measures/relationships) the harness PUTs to seed the reference model. |
| `apps/fiab-console/lib/azure/__tests__/dax-golden/expected-results.json` | The golden cases (DAX + expected numeric + provenance + `implemented` flag). |
| `apps/fiab-console/lib/azure/__tests__/dax-golden/fixtures.ts` | Typed loader + CSV reference evaluator + `assertLiveResult` comparator (shared by both gates). |
| `apps/fiab-console/lib/azure/__tests__/dax-golden/dax-golden.test.ts` | **Offline gate** (vitest): schema validation + CSV cross-check + negative controls. Runs in ordinary CI, no backend. |
| `apps/fiab-console/e2e/dax-golden.spec.ts` | **Live gate** (Playwright `dax-golden` project): asserts each implemented case's numeric result on real serverless. |
| `scripts/csa-loom/seed-dax-golden.sh` | Idempotent seeder: uploads the CSVs + creates the serverless golden DB + typed views. |

## Fixture format (`expected-results.json`)

Each `cases[]` entry:

```jsonc
{
  "id": "a5-sum-amount",          // unique, stable id
  "fn": "SUM",                    // DAX function/feature under test
  "landedBy": "A5",               // which PR owns this row (A1..A5)
  "implemented": true,            // live harness asserts ONLY when true; false = pending template
  "dax": "EVALUATE ROW(\"TotalAmount\", CALCULATE(SUM(Sales[Amount])))",
  "database": "loom_dax_golden",  // optional serverless db override (defaults to the golden db)
  "expect": {                     // how the live result is asserted
    "kind": "scalar",             //   scalar | rowCount | groupRows
    "column": "TotalAmount",
    "value": 2940
  },
  "reference": {                  // how the golden is INDEPENDENTLY recomputed offline
    "kind": "csv-agg",            //   csv-rowcount | csv-agg | csv-sumproduct | csv-groupagg | manual
    "table": "sales", "op": "sum", "column": "Amount"
  },
  "provenance": "SUM(Sales[Amount]) over data/sales.csv",
  "tolerance": 0.000001           // optional; else suite defaultTolerance
}
```

**Two independent computations must agree.** `expect.value` is the number Power BI
Desktop produced (provenance names the source); `reference` recomputes the same
number straight from the CSVs in `dax-golden.test.ts`. A `manual` reference
(time-intelligence goldens captured in Power BI) is not CSV-recomputable and is
gated only by the live run + provenance. The negative-control tests prove the
cross-check actually bites (a corrupted golden must fail).

## Adding a function golden (A1/A2/A3 authors)

1. Add (or flip) the case in `expected-results.json`: set `implemented:true`,
   `landedBy` = your item, a CSV-recomputable `reference` where possible.
2. `dax-golden.test.ts` cross-checks your number offline automatically.
3. The live `dax-golden` project asserts it against real serverless once seeded.

No edits to `playwright.config.ts` (the `dax-golden` project is reserved) or to
`fixtures.ts` are needed for a plain new row.

## Per-cloud

**Cloud-neutral.** The fold engine and the harness are backend-agnostic; the live
run targets Synapse serverless via the existing `synapse-sql-client`
(`<ws>-ondemand.sql.azuresynapse.net`, Gov `.usgovcloudapi.net` via
`LOOM_SYNAPSE_HOST_SUFFIX`). **No AAS, no Power BI/Fabric** on this path
(`no-fabric-dependency`). Commercial: live in CI. Gov: the same goldens re-run in
the Gov UAT harness.

## IL5 note (design-constraint documentation only)

- **In-boundary services only.** Serverless SQL over ADLS Gen2 — both GA at IL5;
  no external engine, no Power BI/Fabric/AAS dependency.
- **No egress.** OPENROWSET reads the in-account CSVs via AAD passthrough; no
  public endpoint. The seed runs in-VNet (ACA job pattern), reaching the
  serverless PE endpoint only.
- **Air-gapped:** the reference data ships in-repo (CSV) and the offline vitest
  cross-check needs no network — the numeric correctness of every golden is
  verifiable with zero connectivity; the live gate adds the real-backend proof
  when an IL5 estate is stood up.
- **No secrets in fixtures**; the seed authenticates with the caller's AAD token
  (Storage Blob Data Contributor + serverless db_owner), no storage keys.

## Cost

`Cost: +$0/mo always-on | ~$0 idle | serverless per-query only on live runs`
(a handful of tiny OPENROWSET scans per harness run; no dedicated compute).
