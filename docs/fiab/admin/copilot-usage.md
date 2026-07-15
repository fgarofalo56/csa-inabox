# Copilot usage admin page

> **Surface:** `/admin/copilot-usage`
> **BFF:** `apps/fiab-console/app/api/admin/copilot-usage/route.ts`
> **Source:** Azure Application Insights (real token telemetry)

The **Copilot usage** page reports per-persona Copilot token consumption drawn
from Application Insights — real **prompt + completion** tokens broken down by
persona, model, day, and user (hashed). There are **no synthetic numbers**: an
empty window means no telemetry, shown honestly.

## What you can do

- **Per-persona breakdown** — token consumption by Copilot persona (chat,
  build-assist, explain, per-item assistants).
- **By model & day** — usage split across the deployed AOAI models over time.
- **By user (hashed)** — attribute consumption to hashed user ids for fair-use
  review without exposing raw identities.

## Backend

| Control | Backend |
|---|---|
| Token telemetry | Azure Application Insights queries (real prompt/completion tokens emitted per turn) |

The orchestrator emits token counts per turn to App Insights; this page queries
them. No local mock — the honest gate is "App Insights not configured / no
telemetry in range".

## RBAC & honest gates

Tenant-admin, with the Console UAMI holding a **Monitoring/Application Insights
reader** role. When App Insights isn't wired, the page names the exact resource /
connection string to set.

## Related

- [Usage metrics](usage.md) · [API tokens](developer-tokens.md)
