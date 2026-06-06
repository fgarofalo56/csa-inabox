# Tutorial 05 — Data Agent over Lakehouse

Author, test, and publish a Loom Data Agent that answers natural-language
questions about your Silver table from [Tutorial 02](02-first-lakehouse.md).
**30 minutes.**

## Prerequisites

- Workspace with `noaa_silver_daily` table from Tutorial 02
- (Optional) The Power BI model from [Tutorial 03](03-direct-lake-parity.md)
- An AOAI deployment (e.g. gpt-4o) in your boundary's region

## How the Data Agent editor works

A Data Agent is an item with three tabs — **Build**, **Test chat**, and
**Publish**. You configure sources + instructions on Build, try it on Test
chat (grounded against the real backends), and Publish to Foundry Agent
Service. There is no per-workspace "Data Agents pane" and no public chat
endpoint for outside consumers — the Test chat tab calls
`POST /api/items/data-agent/<id>/chat`, and publishing registers the agent
with Foundry.

## Steps

### 1. Create a Data Agent

Left nav → **Data agents** (the global page) **or** open your workspace →
**New item** → category **Fabric IQ** → **Data agent** → **Create**. The
editor opens at `/items/data-agent/<id>`.

### 2. Build — instructions

On the **Build** tab, fill the **Instructions** textarea (the system
prompt). Include any few-shot Q→query examples and field notes directly in
this text block — there is no separate examples grid:

```
You are an expert at answering questions about NOAA daily weather data.
Always cite the underlying query you generated. Prefer SQL over the
lakehouse for detail questions; prefer DAX over the semantic model for
aggregate questions like "monthly average temperature".

Column notes:
- temperature_c: Temperature in Celsius, converted from Fahrenheit
- date: Date of observation (UTC)
- station_id: NOAA station identifier (e.g. GHCND:USW00094728)

Examples:
Q: What was the average temperature in January?
SQL: SELECT AVG(temperature_c) FROM noaa_silver_daily WHERE MONTH(date) = 1

Q: How many days did we record above 100F?
SQL: SELECT COUNT(*) FROM noaa_silver_daily WHERE temperature_c > 37.7

Q: Monthly average temperature year-over-year
DAX: EVALUATE SUMMARIZE(noaa_silver_daily, YEAR(date), MONTH(date),
     "AvgTemp", AVERAGE(noaa_silver_daily[temperature_c]))
```

### 3. Build — sources

Still on **Build**, add up to 5 sources. For each: pick a **type**
(Warehouse, Lakehouse, KQL database, Semantic model, AI Search, Ontology,
or Graph model), then pick the item from the picker (loaded from
`GET /api/items/by-type?types=<itemType>`). Each source card lets you
scope it to specific tables (comma-separated) and add per-source
instructions.

For this tutorial add:

1. **Lakehouse** → `noaa_silver_daily`
2. (Optional) **Semantic model** → the Power BI model from Tutorial 03

### 4. Test chat

Switch to the **Test chat** tab. Ask questions in the composer and click
**Send**. Each turn POSTs `{ question, history }` to
`POST /api/items/data-agent/<id>/chat`. Try:

- "What was the average temperature in January?"
- "How many days were above 100°F?"
- "Show me the trend over the year"

Each response shows the natural-language `answer`, the generated `query`
(SQL/KQL/DAX), the `sourceUsed`, and the executed `tools` (with
`rowCount`, `columns`, and `rows` — or an honest `gate` if a backend isn't
provisioned). Tabular tool results render inline via `DataAgentResultViz`.

### 5. Publish

Switch to the **Publish** tab. Enter a description and an optional alias,
then click **Publish** (POSTs `{ description, alias }` to
`POST /api/items/data-agent/<id>/publish`).

- **Commercial** (Foundry available): `publishResult.ok = true` and the
  tab shows the Foundry agent artifact ID and `publishedAt`. Use the
  **Inspect** form to look the agent up by artifact ID. Consumers call the
  published Foundry agent.
- **Gov** (no Foundry): `publishResult.deferred = true` with an honest
  banner "Foundry Agent Service not configured". Use the **Test chat** tab
  to interact with the agent until an MCP-compatible registration path is
  available in your boundary.

## What's next

- [Tutorial 06 — Mirroring from Cosmos DB](06-mirroring-cosmos.md) —
  bring a live operational source to the agent
- [Data Agents parity workload](../workloads/data-agents-parity.md)
- [Sovereign AI Agents use case](../use-cases/sovereign-ai-agents.md)

## Cleanup

- Delete the Data Agent from the workspace item tree (right-click →
  Delete), or leave it — agents are cheap when idle

## Troubleshooting

- Agent gives the wrong query: add more examples and tighten the
  instructions
- Agent doesn't answer: check AOAI throttling per
  [Copilot throttling runbook](../runbooks/loom-copilot-throttling.md)
- A source returns a `gate`: provision the named backend (env var / role)
  it reports
