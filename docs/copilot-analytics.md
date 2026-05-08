# Copilot Analytics

Operational dashboards for the Copilot chat widget and the docs site.
All metrics flow into a single **Application Insights** resource:
`appi-csa-inabox-copilot-fg` (East US 2). Raw chat content lives
separately in **Cosmos DB**: `cosmos-csa-inabox-copilot-fg` →
`copilot` database.

## Where to look

| What | Where | URL |
|------|-------|-----|
| Live request stream | Application Insights → Live Metrics | [Open](https://portal.azure.com/#view/AppInsightsExtension/AspNetOverview.ReactView/ComponentId/%2Fsubscriptions%2F363ef5d1-0e77-4594-a530-f51af23dbf8c%2FresourceGroups%2Frg-dlz-aiml-stack-dev%2Fproviders%2Fmicrosoft.insights%2Fcomponents%2Fappi-csa-inabox-copilot-fg) |
| Custom event explorer | Application Insights → Logs (Analytics) | Same resource → "Logs" |
| Saved queries / workbook | Application Insights → Workbooks → "Copilot Analytics" | (created from this doc) |
| Raw chat conversations | Cosmos DB → `copilot/conversations` | [Data Explorer](https://portal.azure.com/#@limitlessdata.ai/resource/subscriptions/363ef5d1-0e77-4594-a530-f51af23dbf8c/resourceGroups/rg-dlz-aiml-stack-dev/providers/Microsoft.DocumentDB/databaseAccounts/cosmos-csa-inabox-copilot-fg/dataExplorer) |
| Auto-filed backlog issues | GitHub Issues with the `from-copilot` label | [Filtered list](https://github.com/fgarofalo56/csa-inabox/issues?q=is%3Aissue+label%3Afrom-copilot) |
| Live function logs | Application Insights → Transaction search | Same resource → "Search" |

## Pre-built KQL queries

Paste these into Application Insights → **Logs** to get instant
answers. Each runs in seconds against the last 24 hours; change
`ago(24h)` to widen the window.

### 1. Chat health overview (last 24h)

```kql
customEvents
| where timestamp > ago(24h)
| where name startswith "chat."
| summarize count() by name, bin(timestamp, 1h)
| render timechart
```

What you'll see: a stacked time-chart of `chat.request`,
`chat.feedback`, `chat.backlog_submission`, `chat.rejected`,
`chat.error` events binned by hour.

### 2. Chat success / failure ratio

```kql
customEvents
| where timestamp > ago(24h) and name in ("chat.request", "chat.error", "chat.rejected")
| summarize requests = countif(name == "chat.request"),
            errors   = countif(name == "chat.error"),
            rejected = countif(name == "chat.rejected")
| extend success_rate = round(100.0 * requests / (requests + errors + rejected), 1)
```

### 3. Latency percentiles

```kql
customEvents
| where timestamp > ago(24h) and name == "chat.request"
| extend latency_ms = toint(customDimensions.latency_ms)
| summarize p50 = percentile(latency_ms, 50),
            p90 = percentile(latency_ms, 90),
            p99 = percentile(latency_ms, 99),
            avg = round(avg(latency_ms), 0)
            by bin(timestamp, 1h)
| render timechart
```

### 4. Uncovered-question rate

How often does the Copilot fall back to "off-topic refusal" or zero
grounding hits? High rates point at documentation gaps.

```kql
customEvents
| where timestamp > ago(7d) and name == "chat.request"
| summarize total = count(),
            uncovered = countif(tostring(customDimensions.uncovered) == "True")
| extend uncovered_pct = round(100.0 * uncovered / total, 1)
```

### 5. Top documentation pages driving chat

Which pages send users to ask the Copilot? Useful for finding pages
that aren't self-explanatory.

```kql
customEvents
| where timestamp > ago(7d) and name == "chat.request"
| summarize chats = count() by page = tostring(customDimensions.page_url)
| where chats > 1
| order by chats desc
| take 20
```

### 6. Feedback summary (thumbs up/down)

```kql
customEvents
| where timestamp > ago(30d) and name == "chat.feedback"
| summarize count() by rating = tostring(customDimensions.rating)
| render piechart
```

### 7. Top distinct sessions (by chat volume)

```kql
customEvents
| where timestamp > ago(7d) and name == "chat.request"
| summarize chats = count(), first = min(timestamp), last = max(timestamp)
            by session = tostring(customDimensions.session_id)
| order by chats desc
| take 20
```

### 8. Token-budget burndown

Tracks the `tokens_used` dimension to forecast spend.

```kql
customEvents
| where timestamp > ago(30d) and name == "chat.request"
| extend tokens = toint(customDimensions.tokens_used)
| summarize total_tokens = sum(tokens), avg_per_chat = avg(tokens) by bin(timestamp, 1d)
| render timechart
```

### 9. Docs-site page-views (page-load analytics)

```kql
pageViews
| where timestamp > ago(7d)
| where customDimensions.site == "docs"  // exclude future apps that share this AI
| summarize views = count() by tostring(name), bin(timestamp, 1d)
| render columnchart
```

### 10. Top docs pages by traffic

```kql
pageViews
| where timestamp > ago(30d) and customDimensions.site == "docs"
| summarize views = count(), users = dcount(user_Id) by name
| order by views desc
| take 20
```

### 11. Geographic distribution

```kql
pageViews
| where timestamp > ago(30d) and customDimensions.site == "docs"
| summarize views = count() by client_CountryOrRegion, client_StateOrProvince
| order by views desc
```

### 12. Multi-page user flows

```kql
pageViews
| where timestamp > ago(7d) and customDimensions.site == "docs"
| summarize pages_viewed = dcount(name), session_length = max(timestamp) - min(timestamp)
            by user_Id
| where pages_viewed > 1
| summarize bins = count() by pages_viewed
| order by pages_viewed asc
```

### 13. Bounce rate (single-page sessions)

```kql
pageViews
| where timestamp > ago(7d) and customDimensions.site == "docs"
| summarize page_count = dcount(name) by user_Id
| summarize bounces = countif(page_count == 1), total = count()
| extend bounce_rate = round(100.0 * bounces / total, 1)
```

### 14. Slow page loads (P90 over 3s)

```kql
pageViews
| where timestamp > ago(7d) and customDimensions.site == "docs"
| summarize p90_load_ms = percentile(duration, 90) by name
| where p90_load_ms > 3000
| order by p90_load_ms desc
```

## Cosmos DB queries (raw chat content)

The App Insights `customEvents` table holds dimensions only — no
message bodies. For full-text analysis (e.g. clustering uncovered
questions), pull from the Cosmos `conversations` container:

```sql
-- Cosmos SQL (NOT KQL). Run via Azure Portal → Cosmos DB →
-- Data Explorer → conversations → New SQL Query.

-- The 50 most recent uncovered questions
SELECT TOP 50 c.user_message, c.ts, c.session_id, c.page_url
FROM c
WHERE c.uncovered = true
ORDER BY c.ts DESC

-- Chat-feedback paired with the original question
SELECT c.session_id, c.conversation_id, c.user_message, c.assistant_reply
FROM c
WHERE c.conversation_id IN (
    SELECT VALUE f.conversation_id
    FROM feedback f
    WHERE f.rating = "down"
)
```

(Cross-container queries aren't natively supported in Cosmos SQL — for
ad-hoc analysis, export both containers via the SDK and merge in
Python / pandas.)

## Building a workbook

Application Insights workbooks let you save these queries as a
single dashboard. To bootstrap one:

1. Open the AI resource → **Workbooks** → **+ New**
2. Pick "Empty"
3. Add **Query** sections for each KQL block above
4. Save as **"Copilot Analytics"** — pin to the resource

The first time you save, the workbook lives at the resource scope.
You can share its URL with the team for read-only access (RBAC at
the resource level: viewers need `Reader` on the AI resource).

## Operational signals to watch

| Signal | Threshold | What it usually means |
|--------|-----------|----------------------|
| `chat.error` rate > 1% | red | Azure OpenAI throttling, AOAI key/MI auth failure, timeout |
| Latency P99 > 30s | red | OpenAI degradation, network egress issue |
| `chat.rejected reason=injection` spiking | yellow | Either a determined attacker or false positives — review the messages |
| Uncovered rate > 50% over 7d | yellow | Doc corpus is missing material; review the top uncovered queries from Cosmos |
| Backlog `status=open` count growing | yellow | Drain workflow stalled — check `Copilot Backlog Drain` workflow runs |
| Storage / telemetry pipeline `enabled=false` | red | App Insights or Cosmos misconfigured — function still serves chat but you're flying blind |

## Privacy notes

Page analytics honor `Do Not Track` and the chat opt-out — see
[Copilot Privacy Notice](copilot-privacy.md). Aggregate metrics
remain useful even with opt-out users excluded; the analytics shouldn't
be used as a definitive traffic counter.
