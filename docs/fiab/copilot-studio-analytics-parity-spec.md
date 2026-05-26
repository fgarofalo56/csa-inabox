# Copilot Studio Analytics Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent from Microsoft Learn (Copilot Studio: analytics-overview, analytics-summary, analytics-improve-agent-effectiveness, analytics-csat, analytics-themes, analytics-drill-down-lists, analytics-cost-savings, guidance/analytics, guidance/deflection-overview, guidance/measuring-engagement, guidance/measuring-outcomes, guidance/oc-pva-analytics, viva/insights copilot-studio-agents report) + inspection of `apps/fiab-console/lib/editors/copilot-studio-editors.tsx::CopilotAnalyticsEditor` and `getAnalytics` in `apps/fiab-console/lib/azure/copilot-studio-client.ts`.

## Overview

Copilot Studio's Analytics surface shows how a published agent is performing — how many sessions ran, how many engaged, how many resolved / escalated / abandoned, what topics drove what outcomes, what generative answers got thumbs-up vs thumbs-down, what unrecognized utterances need new topics, and what the deflection / cost-savings impact is. Analytics is the closed-loop authoring tool: makers use it weekly to identify which topics need updating, which knowledge sources are stale, and which tools fail too often. Data is retained for 28 days at session granularity and 12 months in aggregate.

## Copilot Studio UX

### Analytics page chrome
- Tabs: **Summary** · **Customer satisfaction** · **Sessions** · **Topics** · **Themes** · **Generative answers** · **Cost savings** · **Custom analytics**
- Time-range picker: Last 24 hours · 7 days · 28 days · custom · compare-to-previous-period
- Channel filter (Teams / Web / M365 / Slack / etc.) · Language filter · Locale filter · Authenticated/Unauthenticated filter
- **Export** to CSV / PowerBI / Application Insights connector

### Summary tab (the headline dashboard)
KPI tiles + sparklines:
- **Total Sessions** — analytics sessions in range (vs prior period delta)
- **Engagement Rate** — % of sessions that triggered a custom topic OR ended in escalation
- **Resolution Rate** — % of engaged sessions where End-of-Conversation confirmed `Yes` or no-response
- **Escalation Rate** — % of engaged sessions that hit Escalate or Transfer-to-agent
- **Abandon Rate** — % of engaged sessions that timed out after 60 min unresolved
- **CSAT** — average customer satisfaction score (1–5) from End-of-Conversation surveys
- **Billed Sessions** (separate from analytics sessions — for licensing)
- **Average session duration** · **Average messages per session**

### Customer satisfaction (CSAT) tab
- Distribution histogram of 1–5 ratings
- Trend chart over time
- Drill-down: low-CSAT sessions list with transcript viewer
- Comments view — text feedback users left alongside the rating
- **Reactions** — thumbs-up / thumbs-down on individual messages with optional comment

### Sessions tab
- List of recent sessions (up to 10,000/day, 28-day window)
- Columns: start time · duration · message count · outcome (Resolved / Escalated / Abandoned / Unengaged) · outcome reason (Resolved confirmed / Resolved implied / Escalate triggered / Transfer-to-agent / System error / Abandoned) · channel · CSAT · authenticated-user ID
- Filters: outcome · outcome reason · channel · topic triggered · authenticated/unauthenticated · CSAT range · duration range · contained-generative-answer
- Click row → **Session transcript** drawer with full message log + variable trace + tool-call trace (requires **Bot Transcript Viewer** security role)

### Topics tab
- Per-topic table: name · sessions triggered · resolution % · escalation % · abandonment % · average CSAT · last-triggered-time
- Per-topic drill-down: trend chart · top exit-from-topic paths · top input variables that drove escalation
- **Topic recommendations** — Copilot-Studio-suggested new topics based on unmatched utterances

### Themes tab
- Auto-clustering of user questions that triggered Generative answers → grouped into themes
- Per-theme: question count · sample questions · response quality (Good / Poor for sampled answers) · suggested action (create topic / improve knowledge source)
- Used to find emerging intents

### Generative answers tab
- **Generated answer rate** — % of sessions where the agent gave a generative answer
- **Response quality** — sampled questions labeled `Good` / `Poor` with reason (knowledge gap / hallucination / formatting / out-of-scope)
- Per-question drill-down: user query · response · knowledge sources cited · reaction · sample timestamp
- Knowledge source attribution — which sources actually fed grounded answers

### Cost savings tab
- Agent-assisted impact — deflected sessions × cost-per-human-session = $$ saved
- Maker-led inputs (cost-per-session, hours-saved-per-session) pass through to Viva Insights
- ROI calculator with adjustable assumptions

### Custom analytics
- Export raw session events to Application Insights (`Microsoft.Insights/components`) via the agent's linked App Insights resource — full Kusto/KQL access
- Power BI template app for Copilot Studio agents
- Viva Insights Copilot Studio Agents report integration

## What Loom has today

From `apps/fiab-console/lib/editors/copilot-studio-editors.tsx::CopilotAnalyticsEditor` and `app/api/items/copilot-studio-analytics/**`:
- Env picker + agent picker (shared)
- `getAnalytics(envId, agentId, days)` calls BAP `/copilots/{agentId}/analytics?window={days}d` (admin BAP endpoint)
- KPI cards: Sessions · Resolved · Escalated · Resolution rate · Escalation rate · CSAT (when present)
- Daily session sparkline placeholder fed from `daily[]` array (when BAP returns it)
- Window picker: 7 / 30 / 90 days
- Empty-state handling — when BAP analytics pipeline hasn't produced data yet, surfaces zeros rather than throws
- MessageBar for Copilot-Studio-not-enabled 503

## Gaps for parity

1. **Abandon Rate** — Loom shows Resolved + Escalated only; missing the Abandoned outcome (and the implicit Engagement Rate that ties them together)
2. **Engagement Rate KPI** — % of sessions that became engaged is not computed
3. **Billed Sessions** — separate from analytics sessions for licensing; not shown
4. **Average session duration / messages per session** — not surfaced
5. **Compare-to-previous-period** delta on every KPI — not implemented
6. **Channel / Language / Locale / Auth filters** — not exposed
7. **CSAT distribution** — Loom shows a scalar; missing 1–5 histogram and trend chart
8. **Reactions feed** — thumbs-up/down on individual messages with comments not surfaced
9. **Sessions list with transcript viewer** — Loom has no per-session drill-down; no transcript drawer, no variable trace, no tool-call trace
10. **Outcome-reason filter** — `Resolved confirmed` vs `Resolved implied` vs `System error` vs `Abandoned` not exposed
11. **Topics tab** — per-topic resolution/escalation/abandonment rates not computed; no per-topic trend chart
12. **Topic recommendations** — Copilot Studio's AI-suggested new topics from unmatched utterances not surfaced
13. **Themes tab** — auto-clustering of generative-answers questions into themes not surfaced
14. **Generative answers quality panel** — Good/Poor sampling, knowledge-source attribution, per-question reaction drill-down all missing
15. **Cost savings / ROI tab** — agent-assisted impact + Viva Insights pass-through not surfaced
16. **Export to CSV / Power BI / Application Insights** — no export button
17. **Application Insights link** — Loom doesn't show whether the env has an App Insights resource linked, or surface the App Insights workspace ID for KQL drill-down
18. **Comparison across multiple agents** — no cross-agent KPI comparison in the env
19. **Real-time / near-real-time refresh** — Loom has manual refresh only; Copilot Studio's analytics dashboard auto-refreshes
20. **Drill-down lists with filtering** — Loom has no filterable list at all

## Backend mapping

Multiple surfaces feed Copilot Studio analytics:
- **Admin BAP analytics endpoint** — `https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/{envId}/copilots/{agentId}/analytics?api-version=2020-10-01&window={N}d` (Loom uses this for the headline KPIs)
- **Per-session transcripts** — Dataverse `msdyn_botsession` + `msdyn_botconversationtranscript` tables (28-day retention)
- **Reactions** — `msdyn_botconversationmessagereaction` table
- **Topic-level metrics** — pre-aggregated in `msdyn_botsessiontopicmetrics` (Dataverse) + raw events in Application Insights
- **Themes** — `msdyn_botgenanswertheme` table populated by background ML job
- **Generative-answer quality samples** — `msdyn_botgenanswersample` table with `quality` ∈ {Good, Poor} + `reason`
- **Cost-savings inputs** — `msdyn_botcostsavingsconfig` (maker-led $/session, hrs-saved) + Viva Insights API for analyst-led overrides
- **Application Insights** — every published agent has an associated App Insights resource (configured at env-create time or linked later); raw events available via Kusto. Schema: `customEvents` table with `name` ∈ {`BotMessageReceived`, `BotMessageSent`, `TopicTriggered`, `KnowledgeQueried`, `ToolCalled`, `Escalation`, `Resolution`}, `customDimensions` with `botId`, `sessionId`, `conversationId`, `userId`, `topicName`, `outcomeReason`
- **Power BI template** — `https://aka.ms/PowerBITemplate-CopilotStudio` (PBIT file binding to Application Insights via Kusto queries)
- **Auth** — most of the deep telemetry requires either BAP admin scope or direct Dataverse access on `msdyn_bot*` tables; App Insights requires `Microsoft.Insights/components/read` on the resource

## Required Azure resources / tenant settings

- All Agent-editor prerequisites
- **Application Insights resource** (`Microsoft.Insights/components`) linked to the Copilot Studio env — auto-created on first publish, or attachable via env settings
- **Log Analytics workspace** (`Microsoft.OperationalInsights/workspaces`) — backs the App Insights workspace-based mode
- **Bot Transcript Viewer security role** assigned to the SP — required to read session transcripts from `msdyn_botconversationtranscript`
- **Power BI license + service capacity** — for the template app embed
- **Viva Insights license** (optional) — for advanced analyst-led cost-savings reports
- **For real-time refresh**: SignalR / WebSocket fan-out from Loom BFF, or just polling every 60s (Copilot Studio dashboard polls)

## Estimated effort

3 sessions. KPI tile completeness (Abandon Rate · Engagement Rate · Billed Sessions · avg duration · compare-to-previous-period) + filters (channel/language/auth) + CSAT distribution histogram is ~1 session. Sessions tab with transcript viewer (calls `msdyn_botconversationtranscript`) + drill-down filters is ~1 session. Topics tab + Themes tab + Generative answers quality + Reactions feed is ~1 session. Cost savings tab + Application Insights link + Power BI / CSV export can fold into the third session if scope tight, otherwise a separate ~0.5-session follow-on. Real-time refresh + cross-agent comparison are nice-to-haves on a separate track.
