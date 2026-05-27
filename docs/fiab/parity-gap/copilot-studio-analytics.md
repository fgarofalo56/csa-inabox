# copilot-studio-analytics — parity gap (validator v2, 2026-05-26)

**Loom URL**: `/items/copilot-studio-analytics/new`
**Fabric reference**: copilotstudio.microsoft.com — Analytics (KPI cards · daily session line chart · sessions by topic · escalation funnel · session viewer with transcript)
**Loom screenshot**: `temp/parity/copilot-studio-analytics-loom.png`

## Phase 4

| Route | Status | Notes |
|---|---|---|
| `GET /api/items/copilot-studio-analytics/<agentId>?envId=<env>&days=30` | 503 | Same Copilot Studio honest gate when env not enabled |

UI shows 3 window-preset buttons (7d / 30d / 90d), env picker, agent picker, and a placeholder for KPI cards + daily sparkline that would render if backend returned data.

## Phase 3 — Fabric vs Loom

| Copilot Studio element | Loom present? | Severity |
|---|---|---|
| 7d / 30d / 90d window presets | YES | — |
| **Custom date range picker** | NO | MINOR |
| KPI cards (Sessions · Resolved · Escalated · CSAT) | YES (when data present) | — |
| **Daily session line chart** | partial — Loom has a CSS bar sparkline (1 row of bars), not a proper recharts line chart | MAJOR |
| **Sessions by topic** breakdown (top topics, success rate per topic) | NO | MAJOR |
| **Escalation funnel** | NO | MAJOR |
| **CSAT survey results breakdown** (1–5 stars distribution) | NO | MAJOR |
| **Session viewer** (click a session → see full transcript + nodes hit + tools called) | NO | BLOCKER |
| **Topic performance table** (success/abandonment per topic) | NO | MAJOR |
| **Average session length / messages per session** | NO | MINOR |
| **Export to CSV / Power BI** | NO | COSMETIC |
| Honest 503 MessageBar | YES | — |

## Functional

- Window-preset buttons fire reload of the analytics endpoint
- Sparkline renders as a row of CSS bars (very basic; not a real chart library)
- Cannot drill into individual sessions

## Grade — **D**

Backing route is honest (503 + MessageBar). KPI cards render real data when present. But missing the per-topic breakdown, escalation funnel, and especially the **session viewer** which is the most operationally important Copilot Studio analytics feature. **Grade D.**
