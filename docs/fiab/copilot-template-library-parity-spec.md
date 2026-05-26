# Copilot Template Library Editor — Power Platform parity spec

> Captured 2026-05-26 by catalog agent from Microsoft Learn (Copilot Studio Agent Library + microsoft/m365-agent-templates + Copilot Studio Kit) and inspection of `apps/fiab-console/lib/editors/copilot-studio-editors.tsx::CopilotTemplateLibraryEditor` + `app/api/items/copilot-template-library/**`. Loom has a working CSA-curated, Cosmos-backed template gallery with five seed templates and live "Use template → create agent" flow; this spec compares it against Microsoft's first-party **Agent Library** marketplace experience.

## Overview

Microsoft's **Agent Library** is a curated, marketplace-style catalog of production-ready agent templates and reusable components for Copilot Studio and Microsoft 365 Copilot. It ships as a Power Platform app installed from Microsoft Marketplace into a chosen environment, plus a parallel GitHub repository (`microsoft/m365-agent-templates`). Each template card carries metadata (type · category · prerequisites · suggested model · knowledge sources · topics) and a guided **Deploy** flow that imports the solution, wires up connection references, fills environment variables, enables cloud flows, and publishes the agent. Reusable **Components** (Research, Document Extraction, Content Synthesis, Log Chain of Thoughts, Executive Brief, Save Conversation History, ServiceNow Ticket Management, etc.) install as modular building blocks invoked from agent topics via `Call an action`.

## Microsoft Agent Library UX

### Catalog landing
- Marketplace-style grid of template cards, each showing title · category · description · agent type badge (**Custom agent** vs **Declarative agent**) · prerequisites · estimated install time
- Filter facets: agent type, category (Productivity · Sales · HR · IT · Compliance · Analytics), industry, language, complexity, certification
- Search by name, capability, or knowledge source
- **Featured** carousel for newly published or seasonally relevant templates

### Template detail
- Hero card: title, hero image, publisher (Microsoft / partner / first-party CSA), version, last-updated date
- **Description** prose + **Sample prompts** (3–5 to verify post-deploy behavior)
- **Prerequisites** section: required licenses (Copilot Studio · M365 Copilot · per-message capacity), environment kind (Dataverse-enabled), connectors (Office 365 · SharePoint · ServiceNow · Dynamics, etc.)
- **What's included** manifest: topics, knowledge sources, cloud flows, connection references, environment variables, plug-in actions, AI prompts
- **Customize before deploy** form: agent name override, instructions override, model picker, target environment dropdown
- **Deploy** button → guided install → post-install checklist (configure connections · set env vars · enable flows · publish · test)

### Built-in templates (current MS catalog)
Plan My Day · Know Your Customer · Executive Brief · My Company Policy · Request Tracker · AI Learning Advisor · Status Update Agent · Project Delta Digest · Personal News Digest · SME Finder.

### Reusable components
Research · Document Extraction · Content Synthesis · Log Chain of Thoughts · Executive Brief (component variant) · Save Conversation History · ServiceNow Ticket Management. Install once per env, then reference from any topic via `Call an action`.

### Custom agents vs declarative agents
Two install paths per card:
- **Custom agents** — Copilot Studio solution import (Dataverse-backed, multi-channel)
- **Declarative agents** — Customize & Download (json + manifest) | Use Agent Builder (M365 Copilot Chat) | Build with Visual Studio (Agents Toolkit clone)

### Post-deploy operator runbook
1. Configure connection references (verify all show green checkmark)
2. Set environment variables (API endpoints, SharePoint URLs, ServiceNow base URL)
3. Enable cloud flows (template flows ship disabled by default)
4. Publish the agent (imported solutions land unpublished)
5. Test using the template's sample prompts

## What Loom has today

From `apps/fiab-console/lib/editors/copilot-studio-editors.tsx::CopilotTemplateLibraryEditor` and `app/api/items/copilot-template-library/**`:

- **Cosmos-backed CSA-curated catalog** — container `copilot-template-library` in the `loom` database, partitioned by `/tenantId`, auto-created on first call, auto-seeded with five CSA templates if empty
- **Seed templates**: Data Steward · Contract Analyzer · RFP Responder · FedRAMP Compliance Coach · Lakehouse Q&A Assistant
- **Template card grid grouped by category** — Body1 title + Caption1 description + suggested-model badge + knowledge-type badges + topic count badge
- **Environment picker** — drives target Dataverse environment for the `Use template` action (shared with all v3 Power Platform editors)
- **Use template** button — POSTs `/api/items/copilot-template-library/{tid}` with `{ envId }` → creates a Copilot Studio agent (bot) record in Dataverse, plus knowledge source records, plus topic records, returns success MessageBar with counts
- **Add template** flow (POST `/api/items/copilot-template-library`) — accepts `{ name, description, instructions, knowledge?, topics?, suggestedModel?, category? }` and upserts a non-builtin template into the catalog
- **Ribbon stub** — Refresh · Use template (labels only on detail header)
- **Refresh** button reloads catalog from Cosmos
- Error MessageBars surface verbatim from BFF including the auth `hint`

## Gaps for parity

1. **Marketplace-style hero / featured carousel** — Loom shows a flat category-grouped grid; no featured/recommended carousel, no hero imagery per template
2. **Filter facets + search** — no facets (agent type · category · industry · language · complexity) and no full-text search across `name + description + knowledge`
3. **Template detail drawer** — Loom card → direct `Use template`; no detail view showing sample prompts, prerequisites, manifest of what's included, customize-before-deploy form
4. **Sample prompts** — not stored in template doc, not surfaced anywhere
5. **Prerequisites declaration** — no field for required licenses, connectors, env kind; no automated pre-flight check against the target environment before clicking `Use template`
6. **Customize-before-deploy** — Loom uses template defaults verbatim; no override form for `name`, `instructions`, model
7. **Declarative-agent path** — Loom only creates Custom agents in Dataverse; no Customize & Download (json + manifest), no Agent Builder hand-off, no Visual Studio / Agents Toolkit export
8. **Reusable components catalog** — no separate Components tab and no `Call an action` wiring to install Research / Document Extraction / etc. independent of an agent
9. **Microsoft first-party template ingestion** — Loom catalog is CSA-only; no sync from `microsoft/m365-agent-templates` GitHub releases or Marketplace
10. **Post-deploy checklist** — success MessageBar reports counts only; no actionable checklist (configure connections · set env vars · enable flows · publish · test) with per-step status
11. **Connection-reference resolver** — templates with connectors (SharePoint, ServiceNow) don't prompt the user to pick / create the matching connection reference at deploy time
12. **Environment-variable form** — same gap; env vars in `flowYaml` aren't surfaced for user input
13. **Versioning + update flow** — no template version field, no "Update available" indicator for previously-deployed instances
14. **Publisher metadata** — no publisher field (Microsoft · partner · CSA · custom), no signed/verified badge
15. **Industry / language metadata** — not modeled; can't filter by industry vertical or supported locale
16. **Template usage telemetry** — no view-count, deploy-count, success-rate on each card
17. **Preview pane** — no rendered preview of a sample agent conversation before deploying

## Backend mapping

Live Cosmos + Dataverse path (working today in Loom):
- **Catalog store** — Cosmos DB container `copilot-template-library` partitioned by `/tenantId` (UAMI-auth via `LOOM_COSMOS_ENDPOINT`)
- **Template doc shape** — `{ id, tenantId, name, description, instructions, knowledge[], topics[], suggestedModel, category, builtin }`
- **Use template** — `/api/items/copilot-template-library/[id]` POSTs to Dataverse Web API `bot`, `botcomponent` (topic), and knowledge-source records inside the target environment (Copilot Studio agents live in Dataverse)
- **Auth** — Cosmos uses UAMI; Dataverse uses MSAL Web App SP (`LOOM_DATAVERSE_*`) — Application User role required on each target env

Full Microsoft parity adds:
- **Microsoft Marketplace install** — Power Platform admin centre `/Environments/{env}/Resources/Dynamics 365 apps` install flow for `aka.ms/agentlibrarymarketplace`
- **GitHub solution import** — solution zip from `microsoft/m365-agent-templates` imported via Dataverse `/api/data/v9.2/ImportSolution`
- **Declarative-agent export** — M365 Copilot manifest schema (`copilot.manifest.json`) + Teams app package upload
- **Connection-reference upsert** — Dataverse `connectionreferences` entity with `connectionreferencelogicalname` + `connectionid`
- **Environment variables** — Dataverse `environmentvariabledefinition` + `environmentvariablevalue` entities

## Required Azure resources / tenant settings

For the Loom path (working today):
- Cosmos DB account + `loom` database — already provisioned
- `copilot-template-library` container — auto-created on first call
- Dataverse-enabled Power Platform environment per target
- MSAL Web App SP registered as Application User on each target env (System Administrator security role)

For full Microsoft parity:
- **Power Platform admin centre Marketplace install** — admin-only, requires `Power Platform admin` or `Dynamics 365 admin` role
- **GitHub Releases mirror** for `microsoft/m365-agent-templates` (so disconnected/Gov tenants can ingest)
- **AppSource / Marketplace publisher account** if Loom intends to publish CSA templates back to Microsoft Marketplace

## Estimated effort

3 sessions. Filter + search + detail drawer + customize-before-deploy form is ~1 session (biggest UX lift). Microsoft Marketplace ingestion (GitHub mirror, solution-zip import, connection-reference + env-var resolver) is ~1 session. Declarative-agent export path + reusable-components tab + post-deploy checklist + versioning is the third session. Telemetry (view/deploy counts) is a small follow-up.
