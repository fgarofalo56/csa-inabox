# copilot-fabric-optin — Fabric / Power BI Copilot capacity opt-in

**Surface:** cross-item Copilot orchestrator (`apps/fiab-console/lib/azure/copilot-orchestrator.ts`)
**Config store:** `apps/fiab-console/lib/azure/copilot-config-store.ts` → `TenantCopilotConfig`
**Admin UI:** `apps/fiab-console/lib/components/admin/copilot-agents-config.tsx`
**Types + gate:** `apps/fiab-console/lib/types/copilot-config.ts`
**Tenant toggle:** `apps/fiab-console/lib/types/tenant-settings.ts` → `ai.fabricCopilotOptIn`

Source references (grounded in Microsoft Learn, 2026-06):
- https://learn.microsoft.com/fabric/fundamentals/copilot-fabric-overview
- https://learn.microsoft.com/fabric/fundamentals/copilot-enable-fabric
- https://learn.microsoft.com/power-bi/create-reports/copilot-introduction
- https://learn.microsoft.com/power-bi/create-reports/copilot-enable-power-bi
- https://learn.microsoft.com/fabric/data-science/data-agent-service-principal

## Real Fabric / Power BI Copilot behavior (grounded, not aspirational)

Fabric Copilot and Power BI Copilot are **UI-only features** in the Fabric
portal / Power BI Desktop / Power BI Service. They:

- Require a Fabric capacity (F2+) or Power BI Premium (P1+) assigned to the
  workspace.
- Require the tenant setting "Users can use Copilot and other features powered
  by Azure OpenAI" enabled in the Fabric admin portal.
- Bill LLM inference against Fabric capacity CUs (tracked in the Capacity
  Metrics app).
- **Do NOT expose a public programmatic REST API** for invoking Copilot on
  behalf of an application. There is no
  `POST api.fabric.microsoft.com/v1/workspaces/{ws}/copilot` endpoint in the
  public surface as of 2026-06.
- Are **not available in sovereign clouds** (GCC-High / IL5 / DoD) due to GPU
  availability. GCC runs on Commercial Azure endpoints and may be available if
  the customer holds a Commercial Fabric capacity, but licensing must be
  confirmed separately.

**Honest consequence:** the only non-vaporware Fabric opt-in implementation is
to (1) validate the bound workspace against the real `api.fabric.microsoft.com`
surface that *does* exist (`GET /v1/workspaces`), (2) enrich the model context
with Fabric tooling, and (3) keep LLM inference on Azure OpenAI. Any claim to
"call Fabric Copilot for inference" would be vaporware because that API does not
exist in the public surface.

## Loom design: opt-in, never default

| Condition | Orchestrator behavior | Fabric/Power BI hosts called |
|---|---|---|
| `LOOM_COPILOT_BACKEND` unset (default) | Azure-native AOAI path — silent | **zero** |
| Flag=fabric + workspace set + Commercial/GCC | Validates workspace via `GET /v1/workspaces`, then AOAI loop | workspace validation only |
| Flag=fabric + workspace set + GCC-High/IL5/DoD | `isFabricCopilotEnabled()` returns false → Azure-native silently | **zero** |
| Flag=fabric + workspace UNREACHABLE | Honest error step emitted; falls through to Azure-native | workspace validation attempt |

**No "bind a Fabric workspace" message appears on the default path.**
**No `api.fabric.microsoft.com` / `api.powerbi.com` call occurs on the default path.**

## The single gate

`isFabricCopilotEnabled(cfg, isGovCloud)` in `copilot-config.ts` returns true
ONLY when ALL hold:

1. `cfg.fabricCopilotBackend === true` **or** `process.env.LOOM_COPILOT_BACKEND === 'fabric'`
2. A Fabric workspace id resolves (`cfg.fabricCopilotWorkspaceId` > `LOOM_COPILOT_FABRIC_WORKSPACE`)
3. `!isGovCloud()` (the orchestrator passes the real `cloud-endpoints.isGovCloud`)

The orchestrator's opt-in block is a pure `if` with no `else` — when the gate is
false, nothing happens and the AOAI loop runs identically to today.

## Acceptance grep gate

```bash
# Default-path Fabric/Power BI hosts — must be ZERO outside the opt-in `if`:
grep -n "api.fabric.microsoft.com\|api.powerbi.com" \
  apps/fiab-console/lib/azure/copilot-orchestrator.ts
# Expected: zero literal host hits in this file (the validation call goes
# through fabric.listFabricWorkspaces(), which owns the FABRIC_BASE literal in
# fabric-client.ts and is only reached inside the isFabricCopilotEnabled() block).
```

## What the Fabric opt-in path does (honest)

1. Reads `LOOM_COPILOT_BACKEND=fabric` (env) or `cfg.fabricCopilotBackend=true` (Cosmos).
2. Reads workspace id from `cfg.fabricCopilotWorkspaceId` or `LOOM_COPILOT_FABRIC_WORKSPACE`.
3. Calls `fabric.listFabricWorkspaces()` → `GET https://api.fabric.microsoft.com/v1/workspaces`
   to validate the workspace is accessible and the UAMI has the required role.
4. Emits a `thought` step naming the validated workspace.
5. Enriches the `SYSTEM_PROMPT` with Fabric workspace context so the model
   prefers the Fabric tools (`fabric_list_workspaces`, `fabric_create_notebook`,
   `fabric_run_notebook`) for items in the bound workspace.
6. Continues with the Azure OpenAI inference loop — LLM calls always go to AOAI.

Note: billing for LLM inference on this path falls on the operator's Azure
OpenAI subscription, NOT on the Fabric capacity CU budget. To bill against
Fabric capacity, the operator must configure Copilot through the Fabric admin
portal separately. This gap is inherent to the absence of a public Fabric
Copilot invocation API.

## Per-cloud behavior

| Boundary | `isGovCloud()` | `isFabricCopilotEnabled()` | Notes |
|---|:---:|:---:|---|
| Commercial | false | follows flag | Fabric Copilot available (F2+ required) |
| GCC | false | follows flag | Commercial Azure endpoints; Fabric licensing separate |
| GCC-High | true | **always false** | Fabric not available in sovereign clouds |
| IL5 | true | **always false** | Fabric not available in sovereign clouds |
| DoD | true | **always false** | Fabric not available in sovereign clouds |

The bicep env injection applies the same gate at deploy time
(`boundary != 'GCC-High' && boundary != 'IL5'`), so the env vars are never even
present on sovereign deployments. The code gate (`!isGovCloud()`) is a second,
independent guard.

## Bicep wiring

```bicep
// platform/fiab/bicep/modules/admin-plane/main.bicep
@allowed(['', 'fabric'])
param loomCopilotBackend string = ''  // default '' = Azure-native silently

// Injected to the Console Container App env ONLY when all three hold:
//   1. loomCopilotBackend == 'fabric'
//   2. loomDefaultFabricWorkspace is set
//   3. boundary != 'GCC-High' && boundary != 'IL5'
(loomCopilotBackend == 'fabric' && !empty(loomDefaultFabricWorkspace) && boundary != 'GCC-High' && boundary != 'IL5') ? [
  { name: 'LOOM_COPILOT_BACKEND',          value: 'fabric' }
  { name: 'LOOM_COPILOT_FABRIC_WORKSPACE', value: loomDefaultFabricWorkspace }
] : []
```

No new Azure resource is required. The Fabric workspace is customer-owned and
provisioned separately (the UAMI needs Member or Contributor role on it).

## Prerequisites for the Fabric opt-in path

1. A Microsoft Fabric workspace on F2+ capacity (customer-provisioned).
2. Fabric tenant admin enables "Service principals can use Fabric APIs" under
   Developer settings in the Fabric admin portal.
3. Console UAMI added to the Fabric workspace as Member or Contributor.
4. `loomCopilotBackend=fabric` + `loomDefaultFabricWorkspace=<ws-id>` in the
   bicepparam OR an admin sets both fields in Tenant settings → Copilot & Agents.

## Loom coverage

| Capability | Status | Notes |
|---|---|---|
| Azure-native AOAI default path (silent when flag unset) | ✅ built | Zero Fabric calls, zero "bind workspace" messages |
| Opt-in flag schema in `TenantCopilotConfig` | ✅ built | `fabricCopilotBackend`, `fabricCopilotWorkspaceId` |
| `isFabricCopilotEnabled()` gate | ✅ built | flag + wsId + `!isGovCloud()` |
| Admin UI toggle + workspace input | ✅ built | `CopilotAgentsConfig` Switch + conditional Input |
| Persisted via PUT /api/admin/copilot-config | ✅ built | boolean + string sanitized + audited |
| Fabric workspace validation (real API) | ✅ built | `listFabricWorkspaces()` on opt-in path only |
| Fallback to Azure-native on validation failure | ✅ built | Error step + continue (no abort) |
| GCC-High / IL5 / DoD guard | ✅ built | `isGovCloud()` → false → Azure-native silent; bicep also excludes |
| Tenant settings toggle | ✅ built | `ai.fabricCopilotOptIn` (informational, default=false) |
| Bicep param + env injection | ✅ built | `loomCopilotBackend`, `LOOM_COPILOT_BACKEND`, `LOOM_COPILOT_FABRIC_WORKSPACE` |
| Fabric Copilot REST invocation API | ❌ not available | No public API exists (2026-06). Honest gap, documented. |
| Billing against Fabric capacity CUs | ❌ not available | Requires Fabric UI path; no programmatic equivalent |
| Parity doc | ✅ this file | — |

## Verification

- Flag unset: `grep api.fabric.microsoft.com apps/fiab-console/lib/azure/copilot-orchestrator.ts` → 0 host literals; Copilot works fully on AOAI.
- Flag + workspace set (Commercial): orchestrator calls `GET /v1/workspaces`, emits the validated-workspace thought, then runs the AOAI loop.
- `vitest run lib/azure/__tests__/copilot-config.test.ts` covers the gate matrix (unset, flag-without-ws, gov, commercial-on).
