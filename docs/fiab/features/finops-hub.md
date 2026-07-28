# FinOps hub

> **Surface:** `/admin/finops` — the **Cockpit**, **Capacity & LCU** and **Chargeback report** tabs (the old `/admin/usage-chargeback` and `/admin/chargeback` routes redirect here)
> **Backend:** Azure Cost Management, real Azure Budgets CRUD, the Loom cost-attribution ledger, and the scheduled cost-anomaly monitor
> **Kill-switch flags:** `c4-finops-hub` (default ON, gates the Cockpit tab) and `n19e-focus-cost-attribution` (default ON, gates the FOCUS panel)
> **Honest gate:** Cost Management readability — when it cannot be read, spend is reported as **unmetered** rather than estimated silently

One page for every cost question. Forecast and anomalies, capacity and Loom
Capacity Units, per-domain chargeback, and — the part nobody else offers —
**cost per query and cost per dashboard**, in FOCUS column names.

## Why it exists

Cost surfaces sprawl. Loom had capacity in one page, chargeback in another, and
no forecast or budget management at all, which meant a FinOps practitioner had
to leave the product to answer basic questions. The hub folds them into one
place, and every folded route still resolves so bookmarks and Fix-it links keep
working.

The deeper reason is attribution. Azure meters dollars per ARM resource type. It
has no idea which analyst's dashboard caused them. Loom records every query run
with who ran it, in which item, workspace and dashboard, and how long it took —
so the two can be joined.

## The three tabs

### Cockpit

1. **KPI tiles** — spend to date, period-end forecast with an **honest method
   badge**, anomaly count, and budget burn.
2. **Forecast chart** — the actual series plus the forecast, with the method
   (API, linear or seasonal) labelled verbatim rather than presented as a single
   authoritative number.
3. **Anomalies** — a live feed from the scheduled detector running over the real
   daily series, beside a **rules editor** (threshold, method, recipients) in a
   resizable split. **Every rule change is audited.**
4. **Breakdown** — real Cost Management spend by service, resource group,
   subscription, resource type, or cost-allocation tag.
5. **Budgets** — real **Azure Budgets** create, update and delete. Audited.
6. **FOCUS panel** — see below.

### Capacity & LCU

The unified capacity and chargeback dashboard that used to live at
`/admin/usage-chargeback`, moved verbatim. No control was lost in the move.

### Chargeback report

The per-domain chargeback report that used to live at `/admin/chargeback`, also
moved verbatim.

## Cost per query and per dashboard (the FOCUS mart)

The FOCUS panel is mounted on **both** `/admin/finops` and `/admin/chargeback`,
so the same numbers appear wherever a practitioner looks.

1. **KPI tiles** — attributed spend, runs priced, average cost per run, and
   **unattributed engine spend** (surfaced, never hidden).
2. **Group-by strip** — Query, Dashboard, Item, User, Engine. **Query** groups by
   *statement fingerprint*, so repeated runs of the same query roll into one
   cost-per-query line.
3. **Chart and table** — real allocated dollars per group, with the derivation
   badged on **every row**.
4. **Export** — the full mart as FOCUS-column-named CSV, so it drops into the
   same tooling your other clouds already feed.

### The honesty contract on pricing

A query's cost is never invented. Each run is priced by **allocating the real
Cost Management spend of the ARM resource type that actually executed it**,
across every run recorded against that resource type, weighted by recorded Loom
Capacity Units. Every row states its derivation:

| `x_LoomCostSource` | Meaning |
|---|---|
| `cost-management-allocated` | Real metered dollars, LCU-weighted share. |
| `unmetered` | Cost Management data unavailable, or that resource type shows no spend in the window. Billed and effective cost are **0**, and the transparent LCU estimate is carried in `x_LoomEstimatedCost` only. |

Metered spend on an engine resource type with **no** recorded runs is surfaced as
**unattributed cost** rather than being silently spread across the runs that do
exist.

Priced engines: SQL Lab / DuckDB, Synapse dedicated and serverless, ADX/KQL,
Trino, Databricks SQL, Analysis Services DAX, and dashboard tiles — running on
ADX, Synapse, Container Apps, AKS, Databricks and Analysis Services resource
types.

### FOCUS conformance

Column names and semantics follow the FinOps Foundation FOCUS 1.1 specification
and Microsoft's own Cost-Management-to-FOCUS mapping — not from memory.
Notable consequences: `BillingPeriodEnd` and `ChargePeriodEnd` are **exclusive**;
`SubAccountId` / `SubAccountName` are the Azure subscription; provider, publisher
and invoice-issuer names are `Microsoft`; and every non-spec column carries the
mandated `x_` prefix.

## Honest gates

- **Cost Management not readable.** The API still answers with the recorded
  consumption plus a gate; the panel renders a message bar naming the exact
  remediation with an inline **Fix it** button into the gate registry. **The
  panel degrades — it never disappears**, and nothing reads as metered when it
  is not.
- **No runs recorded yet.** A guided empty state, not a zero that looks like a
  finding.

## Kill-switches

| Flag | Default | OFF behaviour |
|---|---|---|
| `c4-finops-hub` | ON | Hides **only** the Cockpit tab on the next load. Capacity & LCU and Chargeback report stay fully available and the hub opens on Capacity & LCU — the estate reverts to precisely the two pre-cockpit surfaces in their new home, with an honest message bar explaining why. **Nothing becomes unreachable.** The scheduled cost-anomaly monitor keeps running either way. |
| `n19e-focus-cost-attribution` | ON | `GET /api/admin/finops/focus` returns a guided 503 and the cost panels on `/admin/finops` and `/admin/chargeback` render that notice. **Query runs keep being recorded to the ledger**, so nothing is lost, and every other cost surface is unaffected. |

## Related

- [Capacity and compute](../admin/capacity.md) · [Usage and chargeback](../admin/usage-chargeback.md) · [Chargeback report](../admin/chargeback.md)
- [Cost management (operations)](../operations/cost.md) · [Persistence, chargeback and multi-DLZ](../operations/persistence-chargeback-multidlz.md)
- [Prompt registry and token budgets](prompt-registry-token-budgets.md) — the model-spend half of the picture
