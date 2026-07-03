# CSA Loom — v1.18 GREEN handoff (resume here in next session)

**Last updated:** 2026-05-24
**Status:** v1.18 live, MSAL working end-to-end, full UAT 100% pass
**Branch:** `access-patterns-vpn-agw-fd` (PR #331 open to main, 24+ commits)

## Where things stand

### LIVE deploy
- URL: <https://<your-console-hostname>>
- Revision: `loom-console--0000025` on tag `v1.18`, 100% traffic, Healthy
- Container: `acrloomm56yejezt7bjo.azurecr.io/loom-console:v1.18`
- MSAL works (verified end-to-end this session — user signed in successfully and saw avatar)

### UAT v1.18 results (last run 2026-05-24 20:52 UTC)
- Routes: 60/60 GREEN (14 top-nav, 8 governance, 9 admin, 23 editors, 6 new-item flows)
- Interactions: 5/5 GREEN (Ctrl+K palette, +New item, Feedback, Copilot pane, theme toggle)
- API: 3/3 (`/api/me` 200, `/api/health` 200, `/api/version` 200 returning v1.18)
- 0 console errors, 0 broken images, 0 network errors
- Full report + per-route screenshots: `temp/loom-uat-v1.18/summary.json` + 60 PNGs

### MSAL plumbing (working)
- Entra app: `CSA Loom Console (UAT)` · client `<app-client-id>` · tenant `<tenant-id>`
- Container env: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET=secretref:azure-client-secret`, `SESSION_SECRET=secretref:session-secret`, `AZURE_CLOUD=AzureCloud`, `LOOM_VERSION=v1.18`
- Bug history (all fixed): v1.13 redirect-cookie quirk → v1.15 raw header → v1.16 200 HTML → v1.17 raw Web Response → v1.18 **dropped MSAL access token from cookie** (root cause: ~4KB cookie was over Front Door's per-header limit, FD silently dropped it)
- Cookie payload now: `{claims, exp}` only — ~100 bytes. Access tokens re-acquired silently via MSAL confidential-client cache when needed.

### Key files
- `apps/fiab-console/lib/auth/session.ts` — encodeSessionCookie + getSession + clearSessionCookieHeader
- `apps/fiab-console/app/auth/callback/route.ts` — raw Web Response, 200 HTML splash
- `apps/fiab-console/app/auth/sign-out/route.ts` — same raw-Response pattern
- `apps/fiab-console/app/api/debug/cookie/route.ts` — diagnostic gated by `?secret=$LOOM_VERSION`

## What remains BEFORE we start v2

### Authed-only smoke (not yet tested via Playwright)
Each Playwright session has isolated cookies, so I couldn't run these with the user's session. Can be tested manually OR via Playwright with user re-signing in:
- [ ] Avatar dropdown opens with email + Sign out
- [ ] Sign-out clears session, lands at AAD logout
- [ ] `/api/me` returns the user's identity when authed
- [ ] Per-user data on `/workspaces` (currently `/api/workspaces` returns [] until Cosmos is wired)

### Open PRs / branches
- PR #331 `access-patterns-vpn-agw-fd → main` open with v1.5–v1.18. **Ready to merge.**
- 3 dependabot PRs open (#310 next@15.5.18, #276 msal-react, #272 react types). Worth a sweep.
- Working tree clean. No worktrees.

## v2 backlog (already documented)

Full scope at `docs/fiab/loom-csa-alignment-and-v2-backlog.md`:

### v2 — real REST wiring + Foundry
- Real Azure REST APIs behind every editor (Synapse / Databricks / ADF / APIM / Purview)
- Real Monaco editor (replacing styled textareas) + real React Flow (replacing styled divs)
- Azure OpenAI behind Copilot with APIM LLM policies
- MCP server item type, RAG service item type, production-readiness checklist
- Per-region capacity views, SBOM, per-domain chargeback, IL5/FedRAMP badges per page
- **New: AI Foundry tab** (`/foundry`) — hub & projects, models catalog, deployments, prompt flow editor, evaluations, datasets, AI Search indexes, content safety, tracing, agents, compute. 9 new item types under "AI Foundry" workload.

### v2.5 — Unleashed Loom
- Full-stack DG (DQ + MDM + metadata mgmt + auto-onboarding)
- SQL Server 2025 + Azure SQL family first-class (mirroring, replication)
- Geoanalytics platform (Maps + ST_* + H3/S2 indexing)
- Graph + knowledge stores (Gremlin / Cypher / GQL / vector + graph extraction)
- Push-button data-products library (Modern DW, Lambda, Kappa, Medallion, IoT, Federated mesh, RAG+agent, Geospatial)
- Truly-everything-in-Loom (every Azure data studio surfaced or embedded)
- Cross-item Copilot that orchestrates pipelines + notebooks + models + APIM + Activator in one prompt

### v3 — Power Platform + Copilot Studio
- `/power-platform` (Environments, Dataverse tables as item types, Power Apps, Power Automate, Power Pages, AI Builder, 1100+ connectors)
- `/copilot-studio` (Agents, knowledge sources, topics, actions, analytics, channel publishing, CSA-curated template library)
- Cross-cutting: unified ALM + observability + governance across data + AI + apps

## Recommended v2 starting point

Per my prior recommendation: **Synapse Dedicated SQL Pool** as the first real-REST slice. Small surface, real value, exercises the SP→SQL TDS path that everything else (Databricks, APIM, etc.) will follow.

## Resume command for next session

Paste this in a fresh session to bring me back up to speed:

```
You're picking up CSA Loom v2 work. Background:

1. Read these in order:
   - docs/fiab/v118-handoff.md        (this file — full current state)
   - docs/fiab/loom-csa-alignment-and-v2-backlog.md  (v2/v2.5/v3 scope)
   - docs/fiab/ui-audit-v1.10.md      (UI audit + design tokens)
   - docs/fiab/fabric-feature-inventory.md  (every Fabric item type we mirror)

2. Verify v1.18 still GREEN: run `node temp/uat-pw/uat-v118.mjs` (60-route sweep). Should print "passed: 60, failed: 0".

3. Latest build marker: `apps/fiab-console/.build-marker`. Bump it on every code change so the GHA Docker layer cache invalidates.

4. Deploy cycle:
   git push
   gh workflow run full-app-deploy-commercial --ref access-patterns-vpn-agw-fd -f tag=v1.X -f skip_build=false -f enable_apps_after=false
   gh run watch <id> --interval 30 --exit-status
   az account set --subscription <YOUR_DLZ_SUBSCRIPTION_ID>
   az containerapp update -g rg-csa-loom-admin-eastus2 -n loom-console --image acrloomm56yejezt7bjo.azurecr.io/loom-console:v1.X --set-env-vars LOOM_VERSION=v1.X NEXT_PUBLIC_LOOM_VERSION=v1.X

5. Start v2 with Synapse Dedicated SQL Pool: wire the real Azure SQL TDS path behind apps/fiab-console/lib/editors/azure-services-editors.tsx → SynapseDedicatedSqlPoolEditor. BFF route at /api/items/synapse-dedicated-sql-pool/[id]/query proxies T-SQL via @azure/identity DefaultAzureCredential.

6. Ground all REST calls per the v2 backlog. After Synapse SQL works end-to-end, do Databricks Notebook (Databricks REST + WebSocket), then APIM (APIM mgmt REST), then Purview iframe embed.
```
