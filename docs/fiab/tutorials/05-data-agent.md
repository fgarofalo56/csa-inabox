# Tutorial 05 — Data Agent over Lakehouse

Author + test a Loom Data Agent that answers natural-language questions
about your Silver table from [Tutorial 02](02-first-lakehouse.md).
**30 minutes.**

!!! warning "Navigation accuracy (2026-06-06)"
    There is **no per-workspace “Data Agents” pane.** Create one with **+ New
    item → Data agent** (or the global **Data agents** left-nav). Configure it on
    the **Build** tab (sources + instructions + few-shot examples), try it on the
    **Test** tab, and **Publish** to the Foundry Agent Service. There is **no
    `POST /api/agent/<id>/chat` endpoint** — test in the editor or call the
    published Foundry agent.

## Prerequisites

- Workspace with `noaa_silver_daily` table from Tutorial 02
- Power BI semantic model from Tutorial 03 (optional but recommended)
- AOAI deployment with gpt-4o (in your boundary's region)

## Steps

### 1. Open Data Agents pane

In the workspace, click **Data Agents** in the left rail. Click
**+ New Agent**.

### 2. Configure the agent

Basics:
- **Name**: `weather-analyst`
- **Description**: `Answers questions about NOAA daily weather data`
- **Instructions**:
  ```
  You are an expert at answering questions about NOAA daily weather
  data. Always cite the underlying query you generated. Prefer SQL
  over the lakehouse for detail questions. Prefer DAX over the
  semantic model for aggregate questions like "monthly average
  temperature". For real-time current-conditions questions, use ADX
  if a streaming table exists; otherwise note that you only have
  daily-resolution historical data.
  ```

Data sources (up to 5):
1. Lakehouse: select `<your-workspace> → noaa_silver_daily`
2. Semantic model: select `noaa-semantic-model` (if you completed
   Tutorial 03)

### 3. Add example queries (the highest-leverage signal)

These are the few-shot examples the LLM uses for shape-matching.
Add 5-10 high-quality examples:

| Question | Language | Generated query |
|---|---|---|
| What was the average temperature in January? | SQL | `SELECT AVG(temperature_c) FROM noaa_silver_daily WHERE MONTH(date) = 1` |
| Show me the warmest day each month | SQL | `SELECT MONTH(date) AS m, MAX(temperature_c) AS max_temp, date FROM noaa_silver_daily GROUP BY MONTH(date), date QUALIFY ROW_NUMBER() OVER (PARTITION BY m ORDER BY max_temp DESC) = 1` |
| How many days did we record above 100°F? | SQL | `SELECT COUNT(*) FROM noaa_silver_daily WHERE temperature_c > 37.7` |
| Monthly average temperature year-over-year | DAX | `EVALUATE SUMMARIZE(noaa_silver_daily, YEAR(date), MONTH(date), "AvgTemp", AVERAGE(noaa_silver_daily[temperature_c]))` |

Add via Console "Data Agents → Examples → + Add Example".

### 4. Add field descriptions

For each column the LLM should understand:
- `temperature_c` — "Temperature in Celsius, converted from Fahrenheit"
- `date` — "Date of observation (UTC)"
- `station_id` — "NOAA station identifier (e.g., GHCND:USW00094728)"

### 5. Test the agent

Click **Test Chat** in the agent config.

Try:
- "What was the average temperature in January?"
- "How many days were above 100°F?"
- "Show me the trend over the year"

The agent should:
1. Pick the right source (lakehouse vs semantic model)
2. Generate the SQL or DAX
3. Execute under your Entra identity (OBO)
4. Return rows + the generated query
5. Surface the result in natural language

Sample output:
> "The average temperature in January was 5.2°C. Generated SQL:
> `SELECT AVG(temperature_c) FROM noaa_silver_daily WHERE MONTH(date)
> = 1` — returned 1 row with `avg_temperature_c = 5.234`."

### 6. Publish the agent

Click **Publish**. The agent is now:
- Callable via REST: `POST /api/agent/<agent-id>/chat`
- Callable via Console "Copilot" sidebar (select the agent)
- (Commercial only) Surfaceable as a tool in Foundry Agent Service

### 7. Export the agent config (Git-friendly)

Console "Data Agents → Export". Saves JSON with all instructions,
examples, descriptions. Commit to Git.

## What's next

- [Tutorial 06 — Mirroring from Cosmos DB](06-mirroring-cosmos.md) —
  build a real-time data source for the agent
- [Data Agents parity workload](../workloads/data-agents-parity.md)
- [Sovereign AI Agents use case](../use-cases/sovereign-ai-agents.md)

## Cleanup

- Console "Data Agents → Disable" then "Delete"
- Or leave it — agents are cheap when idle

## Troubleshooting

- Agent gives wrong query: add more example queries; tighten
  instructions
- Agent doesn't answer: check AOAI throttling per [Copilot throttling runbook](../runbooks/loom-copilot-throttling.md)
- Agent answers questions about restricted data: verify
  `sensitivityPolicy` is set
