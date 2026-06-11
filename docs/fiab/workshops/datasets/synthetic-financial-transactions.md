# Synthetic financial transactions dataset (CUI-safe)

A fabricated retail-banking transaction set for FSI / regional-bank workshops.
Used as the Day-3 alternate workload and for fraud-pattern KQL exploration.

!!! warning "CUI-safe by construction"
    All account numbers, customer IDs, merchants, and amounts are
    machine-generated. **No real financial records, account numbers, or PII are
    present.** Account IDs are obviously synthetic (`ACCT-…`) and never resemble
    real card/account formats.

## Files

| File | Purpose | Rows (workshop size) |
|---|---|---|
| `transactions.csv` | Transaction fact (Bronze source) | ~80,000 |
| `accounts.csv` | Account dimension | ~2,000 |
| `merchants.csv` | Merchant dimension | ~300 |

## Schema — `transactions`

| Column | Type | Notes |
|---|---|---|
| `txn_id` | string (UUID) | Synthetic surrogate key |
| `account_id` | string | FK → `accounts.account_id` (e.g., `ACCT-018273`) |
| `txn_timestamp` | timestamp (UTC) | Spread across ~90 synthetic days |
| `merchant_id` | string | FK → `merchants.merchant_id` |
| `amount` | decimal(12,2) | Plausible spend; ~1% injected fraud-like outliers |
| `channel` | string | `card_present` \| `online` \| `transfer` \| `atm` |
| `country` | string | Generic 2-letter code; some mismatched for fraud labs |
| `is_flagged` | boolean | Synthetic fraud label (ground truth for the lab) |

## Schema — `accounts`

| Column | Type | Notes |
|---|---|---|
| `account_id` | string | PK (synthetic) |
| `account_type` | string | `checking` \| `savings` \| `credit` |
| `open_date` | date | Synthetic |
| `home_country` | string | Generic code (drives the country-mismatch signal) |

## Schema — `merchants`

| Column | Type | Notes |
|---|---|---|
| `merchant_id` | string | PK |
| `merchant_category` | string | MCC-like label (e.g., `grocery`, `travel`) |
| `risk_tier` | string | `low` \| `medium` \| `high` (synthetic) |

## Sample rows — `transactions`

```csv
txn_id,account_id,txn_timestamp,merchant_id,amount,channel,country,is_flagged
e5a1...,ACCT-018273,2026-05-02T13:22:00Z,MER-0142,42.10,card_present,US,false
f6b2...,ACCT-018273,2026-05-02T13:31:00Z,MER-0307,2980.00,online,RO,true
07c3...,ACCT-004511,2026-05-03T08:05:00Z,MER-0211,11.75,atm,US,false
```

## Lab use

- **Day 3 (Transform, FSI alternate):** Bronze → Silver normalizes channels +
  country codes; Silver → Gold builds `gold.account_daily_spend` and a
  fraud-candidate view keyed on `is_flagged` + country mismatch.
- **Day 3 (KQL):** ingest `transactions` into ADX and run a fraud-pattern query
  (velocity + country mismatch) producing a candidate list.
- **Day 4 (Data Agent):** ground an agent on the Gold spend tables for
  natural-language questions ("largest flagged transaction last week").

## Related

- [Datasets index](index.md) · [Day 3 — Transform](../5-day-commercial-coe/day-3-transform.md)
- [Financial fraud detection example](../../examples/financial-fraud-detection.md)
