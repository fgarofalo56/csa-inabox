# operations-agent — parity with the Fabric IQ Operations agent (preview)

Source UI: **Fabric IQ — Operations agent** (preview): an agent that monitors
real-time data and recommends/triggers actions via **Activator** + **Power
Automate** (<https://learn.microsoft.com/fabric/fundamentals/fabric-iq>).
Azure-native realization: an **Azure AI Foundry Agent Service** prompt-agent
(<https://learn.microsoft.com/azure/ai-foundry/agents/overview>) bound to an
Eventhouse (ADX) signal source and an Activator/Monitor action path. No
Microsoft Fabric dependency (`no-fabric-dependency.md`).

Editor: `apps/fiab-console/lib/editors/phase4-editors.tsx` →
`OperationsAgentEditor`. Catalog: `fabric-item-types.ts` slug
`operations-agent`, category **Fabric IQ**, `preview: true`.

## Azure/Fabric feature inventory

1. **Set what to watch** — choose the items / workspaces / streams to monitor.
2. **Define signals** — drift / threshold rules that raise an incident.
3. **Author the agent** — instructions (system prompt), model, tools.
4. **Wire actions** — connect Activator + Power Automate so the agent can act.
5. **Deploy the agent** to a runtime.
6. **Continuous monitoring** — periodic polling of the real-time source.
7. **Playbook generation** — turn findings into remediation playbooks.
8. **Notifications / handshake** — Activator + Power Automate + Teams.

## Loom coverage    (built ✅ / honest-gate ⚠️ / MISSING ❌)

| # | Capability | Status | Notes |
|---|---|---|---|
| 1 | Set what to watch | ✅ | Eventhouse binding + Ontology binding inputs (item ids) persisted to Cosmos. |
| 3 | Author the agent | ✅ | System prompt (Textarea), Model, Tools (CSV) inputs; functional `setState` (no clobber on save/reload). |
| 5 | Deploy the agent | ✅ / ⚠️ | **Deploy to Foundry** saves then POSTs a prompt-agent (instructions + model + tools + metadata) to the Azure AI Foundry Agent Service (`createOrUpdateAgent`); deployment receipt (agentId/projectId/lastDeployedAt) persisted. Honest 501 "Deploy deferred — Foundry not configured" MessageBar when `LOOM_FOUNDRY_PROJECT_ENDPOINT` / `LOOM_FOUNDRY_PROJECT_ID` unset. |
| 2 | Define signals (drift/threshold rules) | ❌ | Phase-1 stub — disclosed in-editor; tracked in `docs/fiab/operations-agent-parity-spec.md`. |
| 4 | Wire Activator + Power Automate actions | ❌ | Same spec doc; the Azure-native action path is Activator (Azure Monitor scheduled-query alert) + Logic App / Power Automate. |
| 6 | Continuous 5-minute polling | ❌ | Tracked for follow-up. |
| 7 | Playbook generation | ❌ | Tracked for follow-up. |
| 8 | Teams notifications / handshake | ❌ | Tracked for follow-up. |

The editor renders an explicit `intent="warning"` MessageBar titled **"Phase 1:
Foundry Agent deploy stub"** disclosing exactly what is built vs. deferred — no
fake buttons (`no-vaporware.md`). This surface is **preview** in the catalog.

## Backend per control

- Config persistence → `useItemState('operations-agent', id)` (Cosmos).
- Deploy → `POST /api/items/operations-agent/[id]/deploy`
  (`app/api/items/operations-agent/[id]/deploy/route.ts`):
  `loadOwnedItem` (tenant-owned) → builds a `FoundryAgentBody` (name, model,
  instructions, tools, metadata carrying loomEventhouseId / loomOntologyId) →
  `createOrUpdateAgent(projectId, name, body)` in the Foundry Agent Service →
  persists `foundryAgentId` / `foundryProjectId` / `lastDeployedAt`.
- Error mapping: `FoundryAgentNotConfiguredError` → 501 `{deferred:true, hint}`;
  `FoundryAgentError` → 502 with upstream status/body; empty prompt/model → 400.
