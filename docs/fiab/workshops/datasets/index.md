# Workshop datasets — CUI-safe synthetic data

All CSA Loom workshop labs run on **synthetic, CUI-safe** data. Every value is
machine-generated; **no real PII, PHI, CUI, or production records are present**.
The datasets are safe to use in any boundary (Commercial, GCC, GCC-High) and in
recorded sessions.

!!! warning "CUI-safe by construction"
    These datasets contain only fabricated identifiers and values. They are
    designed for instruction, not analysis of real populations. Do not augment
    them with real records during a workshop — keep the boundary clean.

## The three datasets

| Dataset | Used in | Vertical fit |
|---|---|---|
| [Synthetic IoT](synthetic-iot.md) | Days 2-4 (primary) | Manufacturing, utilities, transportation, defense telemetry |
| [Synthetic financial transactions](synthetic-financial-transactions.md) | Day 3 alternate | FSI, regional banks, fraud analytics |
| [Synthetic clinical encounters](synthetic-clinical-encounters.md) | Day 3 alternate (Commercial) | Healthcare (HIPAA), pharma |

## How datasets load into Loom

Each dataset page documents the schema, a sample of rows, and the load path.
Labs load data through the **real** Loom panes and provisioners — there is no
mock data:

- **Lakehouse → Get data** (`/lakehouse`) uploads the CSV into a Bronze Delta
  table via the lakehouse provisioner (ADLS Gen2 + Delta).
- **KQL ingest** (`.ingest inline`) loads event rows into the Azure Data Explorer
  (ADX) cluster for the real-time labs, matching the seed pattern used by the
  `kql-db` provisioner.
- **Mirrored database** labs use a pre-provisioned synthetic operational source
  whose connection string the facilitator supplies at the workshop.

## Regenerating / extending

The datasets are intentionally small (workshop-sized). To regenerate or grow
them for a longer engagement, the schema definitions on each page are the
contract — generate more rows that honor the schema and the CUI-safe rule (no
real values). Keep row counts modest so labs stay within the 8-hour day.

## Related

- [Federal CoE Day 2 — Ingest](../5-day-federal-coe/day-2-ingest.md)
- [Commercial CoE Day 2 — Ingest](../5-day-commercial-coe/day-2-ingest.md)
- [Workshop index](../index.md)
