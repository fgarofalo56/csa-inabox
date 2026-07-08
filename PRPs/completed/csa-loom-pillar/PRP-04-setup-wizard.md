# PRP-04 — Loom Setup Wizard (Two-Tier Orchestration)

## Context

The conversational deployment surface. User opens the wizard from the
deployed Console, interviews them about environment, renders a live
`.bicepparam` preview, calls Azure MCP to deploy DLZs with JIT
Contributor elevation, streams progress back to chat, narrates next
steps post-deploy.

Two orchestration tiers: Foundry Agent Service in Commercial /
GCC; Microsoft Agent Framework 1.0 + AOAI direct in GCC-High.

PRD ref: `temp/fiab-prd/06-custom-apps.md` §6.2; AMENDMENTS §A8.

## Goal

Wizard route inside Loom Console (`/setup`) drives conversational
deploy of additional DLZs after the initial Admin Plane install. Same
Console UI in both Commercial and Gov tiers; only the orchestration
backend differs.

## Acceptance criteria

- [ ] Wizard route at `apps/fiab-console/app/setup/*` (inside the
  Console from PRP-03)
- [ ] SSE chat surface with conversation turn rendering
- [ ] Live `.bicepparam` preview pane (right-rail; updates as user
  answers)
- [ ] Validation pass via Azure Bicep MCP `snapshot` before deploy
- [ ] Confirm-gate before any write to ARM
- [ ] **Tier A backend** (Commercial / GCC): Foundry Agent Service
  hosting `fiab-deploy-agent` with tools: render_bicepparam,
  submit_deployment, poll_deployment, activate_pim_for_group,
  MCP tools (Azure MCP + Azure Bicep MCP)
- [ ] **Tier B backend** (GCC-High / IL5 future): Microsoft Agent
  Framework 1.0 orchestrator in Container App / AKS workload calling
  AOAI direct + same Azure MCP server
- [ ] Boundary auto-detection (uses `environment().name` at runtime)
  selects which tier to call
- [ ] Progress streaming during ARM deploy (poll-and-narrate)
- [ ] Error handling with remediation suggestions ("VNet CIDR
  conflicts; suggest 10.10.0.0/16")
- [ ] Post-deploy next-step narration ("create your first workspace...")

## Validation gates

- E2E test: scripted user input → wizard runs → deploy → assert FiaB
  Admin Plane RGs exist + Console URL 200 (against staging
  Commercial sub)
- E2E Gov test: same against GCC-High sub
- Unit tests on BicepRenderer (per-permutation of inputs)
- Telemetry asserts every tool call lands in App Insights with
  correlation ID

## Implementation outline

1. Scaffold the `/setup` route + Copilot-style chat component
2. Build the deterministic BicepRenderer function (answers → .bicepparam)
3. Build the Tier A orchestrator integration (Foundry Agent Service
   SDK)
4. Build the Tier B orchestrator (.NET 10 container with Microsoft
   Agent Framework 1.0)
5. Wire Azure MCP server from PRP-05 + Azure Bicep MCP integration
6. Implement the PIM-for-Groups JIT elevation flow (per PRD §07.6.2)
7. SSE streaming via Next.js Route Handlers + EventSource client
8. Error remediation logic (deployment Failed state → propose fix)

## File changes

```
apps/fiab-console/app/setup/                             created
apps/fiab-console/app/setup/page.tsx                     created
apps/fiab-console/app/api/setup/chat/route.ts            created (SSE endpoint)
apps/fiab-console/app/api/setup/render/route.ts          created
apps/fiab-console/app/api/setup/deploy/route.ts          created
apps/fiab-console/lib/setup/bicep-renderer.ts            created
apps/fiab-console/lib/setup/foundry-orchestrator.ts      created
apps/fiab-console/lib/setup/maf-orchestrator-client.ts   created
apps/fiab-setup-orchestrator/                            created (.NET 10 MAF service)
apps/fiab-setup-orchestrator/Program.cs                  created
apps/fiab-setup-orchestrator/Dockerfile                  created
platform/fiab/bicep/modules/admin-plane/setup-orchestrator.bicep created
```

## Open questions / risks

- Foundry Agent Service Gov-region GA unconfirmed (mitigated: Tier B
  is the Gov primary; Tier A is Commercial-only)
- Azure MCP `azmcp_deployment_create` doesn't exist as first-class
  tool; deploy via `azmcp extension az` proxy or direct ARM SDK from
  agent code (per `temp/fiab-research/06-copilot-driven-deploy.md`)
- Service principals can't be PIM-eligible directly; use PIM-for-Groups
  with MCP MI as member, or time-bound active ARM assignments via REST

## References

- `temp/fiab-prd/06-custom-apps.md` §6.2
- `temp/fiab-research/06-copilot-driven-deploy.md`
- `temp/fiab-prd/AMENDMENTS.md` §A8

## Validation receipt

**Validated 2026-05-27 — 16/16 pytest GREEN.**

Test harness: `apps/fiab-setup-orchestrator/tests/test_orchestrator.py`. Tests
exercise the same code path the live Container App hits:

- `_render_bicep_parameters` produces correct cloud env (`AzureCloud` vs
  `AzureUSGovernment`) and container platform (`containerApps` vs `aks`) per
  boundary (Commercial / GCC / GCC-High / IL5)
- `DeploymentStateStore` CRUD: in-memory create / update / get; missing-key
  semantics (silent skip on unknown id)
- `run_bicep_deploy` state machine: walks every stage and completes
  `status=succeeded`; on stage exception flips to `status=failed` with the
  error preserved
- `FoundryOrchestrator` (Commercial / GCC tier) + `MafOrchestrator` (Gov-H / IL5
  tier) both dispatch to the shared deploy driver
- `DeployRequest` pydantic schema rejects invalid boundary, malformed
  domain_name (must match `[a-z0-9-]+`), unknown capacity SKU; accepts all
  4 valid boundaries

**Operator action remaining:** Live deploy through the wizard pane against a
provisioned Container App (no remaining code gates). Tracked in audit page.
