# Loom Setup Orchestrator

The internal deploy backend for the Loom Setup Wizard's **Deploy** step. The
Console BFF (`/api/setup/deploy`) forwards the captured Data Landing Zone config
to this service, which submits a **real subscription-scoped ARM deployment** of
`main.bicep` (compiled to a `main.json` templateLink) under its own managed
identity and reports progress the wizard polls.

Two orchestrator tiers share one FastAPI surface (selected at startup via
`AGENT_ORCHESTRATOR`):

- `foundry-agent-service` — Commercial / GCC (Foundry Agent Service is the
  conversational layer).
- `maf` — GCC-High / IL5 (Microsoft Agent Framework + AOAI-direct, where Foundry
  Agent Service isn't Gov-GA).

Both converge on the same real deploy driver
(`orchestrator.run_bicep_deploy`) — there is no simulated progress.

## HTTP surface

| Method + path | Purpose |
|---|---|
| `GET  /health` | Liveness probe |
| `POST /api/setup/deploy` | Start a deployment. Body = the wizard config (camelCase). Header `x-loom-caller-oid` = signed-in user's oid. Returns `{ deployment_id, status, stream_url }`. |
| `GET  /api/setup/{deployment_id}` | Poll status `{ status, progress, current_stage, … }`. |
| `GET  /api/setup/{deployment_id}/sse` | Server-Sent Events stream of progress. |

## How a deploy runs (real, no simulation)

`run_bicep_deploy`:

1. Validates a target subscription + region are present.
2. Builds a `ResourceManagementClient` under the orchestrator UAMI
   (`AZURE_CLIENT_ID`), using the boundary's ARM endpoint/authority
   (`LOOM_ARM_ENDPOINT`).
3. Submits `deployments.begin_create_or_update_at_subscription_scope` against the
   hub subscription with a templateLink to `LOOM_SETUP_TEMPLATE_URI` (the
   published `main.json`) and the captured parameters (boundary, deploymentMode,
   capacitySku, `dlzDomainNames`, `dlzSubscriptionIds`).
4. Polls the LRO to a terminal state.
5. Marks `succeeded` only when ARM reports `provisioningState == Succeeded`; any
   other terminal state — or a missing `LOOM_SETUP_TEMPLATE_URI` — fails honestly
   with the exact remediation (per `.claude/rules/no-vaporware.md`).

The orchestrator UAMI must hold **Contributor** on each target subscription —
granted by `platform/fiab/bicep/modules/admin-plane/setup-orchestrator-rbac.bicep`.

## Tech stack

- Python 3.12 + FastAPI + uvicorn
- `azure-identity` (managed identity) + `azure-mgmt-resource` (ARM deployments)
- Deployment state: in-memory (dev) or Cosmos DB (`COSMOS_ENDPOINT` set)
- App Insights via OpenTelemetry (`APPLICATIONINSIGHTS_CONNECTION_STRING`)
- Container Apps (Commercial / GCC) or AKS GitOps (GCC-High / IL5)

## Environment

| Var | Purpose |
|---|---|
| `AGENT_ORCHESTRATOR` | `foundry-agent-service` (default) or `maf` |
| `AZURE_CLIENT_ID` | UAMI client id the container runs as |
| `LOOM_ARM_ENDPOINT` | ARM management endpoint for the active cloud |
| `LOOM_SETUP_TEMPLATE_URI` | templateLink URI to the published `main.json` (required for a real deploy) |
| `LOOM_INTERNAL_TOKEN` | shared Bearer the Console presents |
| `COSMOS_ENDPOINT` | optional; enables Cosmos-backed deployment state |
| `LOOM_SETUP_POLL_SECS` | LRO poll interval (default 5s) |

## Build + run

```bash
cd apps/fiab-setup-orchestrator
pip install -e ".[dev]"
uvicorn loom_setup_orchestrator.main:app --reload --port 8000
pytest                       # deterministic; Azure SDK calls mocked
```

Container image:
```bash
docker build -t loom-setup-orchestrator .
docker run -p 8000:8000 loom-setup-orchestrator
```

## Related

- [Setup Wizard parity doc](../../docs/fiab/parity/setup-wizard.md)
- [PRP-04](../../PRPs/active/csa-loom/PRP-04-setup-wizard.md)
- ADR: [fiab-0009 Copilot orchestration](../../docs/fiab/adr/0009-copilot-orchestration.md)
