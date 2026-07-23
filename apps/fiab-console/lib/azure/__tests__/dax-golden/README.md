# DAX golden-result harness — fixtures

The G1-grade numeric-correctness gate for the DAX depth track
(`loom-next-level` ws-lineage-depth **A1–A4**). A5 lands the harness + the
seeded reference data + the baseline rows; **A1/A2/A3 add each function's golden
row here, in the same PR that implements the fold** (the harness gates the
*result*, not its own existence — no circularity).

## Layout

| Path | Role |
|------|------|
| `reference-data/{Sales,Date,Customer}.csv` | The seeded star schema — the reference model. Deterministic, hand-verifiable. |
| `expected-results.json` | The golden fixtures: per DAX query, the expected numeric result + how to recompute it. |
| `fixtures.ts` | Loader + types + the pure-JS `referenceEvaluate` (provenance ground truth) + `MODEL_CONTENT` (the model body the live harness PUTs) + `SEED_DATABASE`. |
| `../dax-golden-fixtures.test.ts` | **Offline** vitest provenance gate — recomputes every golden from the CSV; runs in ordinary CI, no Synapse. |
| `../../../../e2e/dax-golden.spec.ts` | **Live** Playwright `dax-golden` project — asserts the same numbers against real Synapse serverless. |
| `scripts/csa-loom/seed-dax-golden.sh` | Provisions `dbo.{Sales,Date,Customer}` views in the `loom_dax_golden` serverless DB from the same CSVs. |

## Reference data (crosscheck)

`Sales`: 12 fact rows, `Amount = Quantity × UnitPrice`, `SUM(Amount)=3500`
(2023 = 1650, 2024 = 1850), `MIN=100`, `MAX=600`. `Date`: 24 monthly rows
(2023-01 … 2024-12). `Customer`: 4 rows. Sales joins to Date on `DateKey` and to
Customer on `CustomerKey` (valid star — enforced by the provenance test).

## Fixture format

```jsonc
{
  "id": "agg-sum-amount",            // unique
  "fn": "SUM",                        // DAX function under test
  "category": "aggregation",          // table | aggregation | filter | time-intelligence | iterator
  "since": "A5",                      // PR that added the row (A5 baseline; A1/A2/A3 later)
  "status": "implemented",            // implemented = gated live; pending = declared, not yet foldable
  "dax": "EVALUATE ROW(\"Total Sales\", CALCULATE(SUM(Sales[Amount])))",
  "reference": { "op": "sum", "table": "Sales", "column": "Amount" },  // pure-JS recomputation
  "expect": { "kind": "scalar", "column": "Total Sales", "value": 3500, "tolerance": 0 },
  "provenance": "SUM(Amount) over 12 rows = 3500"
}
```

- `expect.kind`: `scalar` (read `rows[0][column]`), `rowCount` (assert `rows.length`), or `table`.
- `expect.tolerance`: absolute tolerance for non-terminating decimals (e.g. `AVERAGE`).
- `reference.op`: the reduction the offline gate recomputes — `rowcount` (with
  optional `limit` for `TOPN`), `sum`, `count`, `average`, `min`, `max`,
  `distinctcount`. **When you add a fold whose expected value needs a new
  reduction shape, extend the `referenceEvaluate` switch in `fixtures.ts` in the
  same PR.**

## Adding a golden row (A1/A2/A3)

1. Add the row to `expected-results.json` with `status:"implemented"` and
   `since:"A2"` (etc.).
2. If its number needs a reduction `referenceEvaluate` doesn't have yet, add the
   `op` to that switch (with a unit-obvious computation over the CSV rows).
3. Run `pnpm -C apps/fiab-console vitest run lib/azure/__tests__/dax-golden-fixtures.test.ts`
   — the provenance gate proves your recorded value matches the CSV.
4. The live `dax-golden` Playwright project then gates the same number against
   real serverless (after `seed-dax-golden.sh` has run in the target env).

A row you have declared but cannot fold yet is `status:"pending"` — it is skipped
live and (if it carries a `reference`) still provenance-checked offline.
