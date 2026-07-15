# ops-agent-evaluator (G3)

Timer-triggered Azure Function that runs the CSA Loom **Operations Agent**
autonomous *monitor → reason → act* loop. Azure-native — **no Microsoft Fabric /
Power Automate dependency** (`.claude/rules/no-fabric-dependency.md`).

## What it does (every 5 minutes, `OPS_AGENT_EVALUATOR_CRON`)

1. Reads every `operations-agent` item (and its persisted triggers) from the Loom
   Cosmos `items` container.
2. Evaluates each **ADX / Eventhouse-sourced** trigger's KQL against the bound
   cluster via the ADX v2 REST query API. (Log-Analytics-sourced triggers already
   evaluate continuously via Azure Monitor and fire their own action group, so the
   evaluator does not double-fire them.)
3. When a trigger **fires** (KQL returns ≥ 1 row), calls **Azure OpenAI** to
   interpret the situation and recommend a concrete action, grounded on the
   agent's instructions + the fired rows.
4. Routes the recommendation:
   - `requireApproval = true` → dispatches the **approval Logic App** (Teams
     adaptive card, human-in-the-loop) via ARM `listCallbackUrl`;
   - otherwise → **autonomous** (the trigger's Azure Monitor action group fires
     the bound action directly; the evaluator records the reasoning for audit).

Everything is a **real** Azure call under the Function's managed identity — no
mocks. Missing config produces an honest early-exit log (no-vaporware).

## Deploy

Provisioned by `platform/fiab/bicep/modules/admin-plane/monitor-ops-agent.bicep`
(Function App + approval Logic App + Teams connection + role assignments). Then:

```bash
cd azure-functions/ops-agent-evaluator
npm ci && npm run build
func azure functionapp publish <func-opsagent-xxxx>
```

## Managed-identity grants

- **Cosmos DB Built-in Data Contributor** on the Loom Cosmos account (data-plane).
- **Database Viewer** on the bound Eventhouse/ADX database (inlined by the bicep
  when the cluster is co-located; otherwise granted out-of-band).
- **Monitoring Reader** on the alert resource group (granted by the bicep).
- **Microsoft Graph `Chat.ReadWrite`** for the Teams card — an AAD app-role
  granted out-of-band (`docs/fiab/v3-tenant-bootstrap.md`).

## Test

```bash
npm ci && npm test   # vitest — covers the pure decision core (evaluator-core.ts)
```
