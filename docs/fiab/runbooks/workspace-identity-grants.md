# Workspace-identity grants — the I2 per-backend matrix

> loom-next-level **I2** (ws-identity-cloudmatrix). Phase A (shadow): these
> grants are provisioned but **unused** — every call still runs as the shared
> Console UAMI. They make the I3 *"would the workspace UAMI have had access?"*
> shadow check answerable from **real RBAC**, and they are what the I6 enforce
> flip switches onto.

## Where the grants are applied

| Path | Trigger | Code |
|---|---|---|
| **Runtime (default)** | Workspace create, when `LOOM_WORKSPACE_IDENTITY_MODE != off` and the sub/RG gate is clear | `apps/fiab-console/lib/azure/workspace-grants.ts` → `ensureWorkspaceGrants()` (called from `applyWorkspaceIdentity`) |
| **Bulk / IaC** | Topology deploy | `platform/fiab/bicep/modules/landing-zone/workspace-identity.bicep` (UAMI + lake container grant) + `workspace-identity-grants.bicep` (Event Hubs + Cosmos rows) + the data-plane scripts below |

Every outcome is recorded per grant on the workspace doc
(`workspaceIdentity.grants[]`: `granted | exists | failed | skipped`), and the
apply path **never throws** — a failed grant never blocks workspace create.

## The matrix (per workspace UAMI `uami-ws-<workspaceId>`)

| Backend | Mechanism | Role | Tightest scope Azure allows | Counts vs 4,000-RBAC cap? |
|---|---|---|---|---|
| ADLS Gen2 lake | ARM RBAC | Storage Blob Data Contributor `ba92f5b4-2d11-453d-a403-e96b0029c9fe` | **container** (`…/blobServices/default/containers/<c>`, from `LOOM_BRONZE_URL`/`LOOM_LANDING_URL`; `ws.storageAccountId` account fallback) | **Yes** (1/workspace) |
| Cosmos DB | **Data-plane** `sqlRoleAssignments` | Built-in Data Contributor `00000000-0000-0000-0000-000000000002` | **account** (data-plane RBAC has no container scope; partition isolation is logical) | No |
| Synapse dedicated SQL | **Data-plane** T-SQL | `db_datareader` + `db_datawriter` external user | **database** (`LOOM_SYNAPSE_DEDICATED_POOL`) | No |
| ADX / Eventhouse | **Data-plane** Kusto mgmt | database **user** (`aadapp=<clientId>;<tenant>`) | **database** (`LOOM_KUSTO_DEFAULT_DB`) | No |
| Event Hubs | ARM RBAC | Data Receiver `a638d3c7-…` + Data Sender `2b629674-…` | **namespace** day-one (per-workspace hubs don't exist at create; the eventstream provisioner tightens to **entity** scope when a workspace hub is born) | Yes (2/workspace when EH configured) |
| Key Vault | ARM RBAC | Key Vault Secrets User `4633458b-…` | **per-workspace vault only** — the shared platform vault is **deliberately never granted** (it holds platform secrets, e.g. the MSAL client secret). No per-workspace vault exists today → recorded `skipped`. | — |
| Azure Monitor (activator) | ARM RBAC | Monitoring Contributor `749f88d5-…` | **RG / alert rule**, granted only when the workspace first owns an activator rule — not at create → recorded `skipped`. | — |

Cloud note: every role GUID is **cloud-invariant** (Commercial / GCC-High /
IL5); ARM hosts resolve via `armBase()`. IL5: the executor already runs
in-boundary (Console UAMI, in-VNet) — no public ARM egress is added.

## Idempotency contract

- ARM RBAC + Cosmos rows use **deterministic `guid()`-style assignment names**
  (`roleAssignmentGuid(scope, principalId, role)`) — a re-run PUTs the same
  name; `409 RoleAssignmentExists` is recorded as `exists`, never an error.
- Synapse T-SQL is guarded (`IF NOT EXISTS` on `sys.database_principals`,
  `IS_ROLEMEMBER` before `ALTER ROLE … ADD MEMBER`).
- ADX `.add` is additive — re-adding an existing principal is a no-op.
- **Idempotency E2E:** re-run provisioning → zero new assignments, zero errors.

## Throttling

All ARM writes ride the serialized workspace-identity write queue
(`workspace-identity-client.ts`): UAMI create throttle (2 req/s/sub,
0.25 req/s/resource) **and** the general ARM write bucket (~200 tokens/sub/SP,
refill ~10/s). Spacing: `LOOM_WS_IDENTITY_ARM_SPACING_MS` (default 600 ms).

## Data-plane grant scripts (bulk path)

Executed **by the Console UAMI** (Synapse SQL admin / ADX cluster admin) — the
same statements the runtime path issues:

### Synapse dedicated pool (`LOOM_SYNAPSE_DEDICATED_POOL`)

```sql
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'uami-ws-<id>')
  CREATE USER [uami-ws-<id>] FROM EXTERNAL PROVIDER;
IF IS_ROLEMEMBER(N'db_datareader', N'uami-ws-<id>') = 0 ALTER ROLE db_datareader ADD MEMBER [uami-ws-<id>];
IF IS_ROLEMEMBER(N'db_datawriter', N'uami-ws-<id>') = 0 ALTER ROLE db_datawriter ADD MEMBER [uami-ws-<id>];
```

### ADX default database

```kusto
.add database ['<db>'] users ('aadapp=<uami-clientId>;<tenantId>') 'uami-ws-<id>'
```

## Verify (per backend present in the deployment)

```bash
# ARM RBAC rows (ADLS / Event Hubs):
az role assignment list --assignee <ws-principalId> --all -o json
# Cosmos data-plane:
az cosmosdb sql role assignment list -a <account> -g <rg> -o json
# Synapse:
#   SELECT name FROM sys.database_principals WHERE name = 'uami-ws-<id>';
# ADX:
#   .show database ['<db>'] principals
```

The runtime verifier is `evaluateWorkspaceGrant(ws, uami, backend)` — the I3
shadow path's "would it have had access?" resolver (live ARM/SQL/Kusto/Cosmos
probe, cached 5 min per workspace+backend).

## Scale ceilings (I8 summary)

- **4,000 ARM role assignments / subscription (fixed).** The matrix keeps the
  ARM-RBAC footprint at 1/workspace (lake) — 3/workspace when Event Hubs is
  configured. Data-plane grants (Cosmos / Synapse / ADX) are deliberately
  data-plane so they never touch the cap. Mitigations at scale: ABAC
  path-prefix conditions on a shared container role, group-based assignment,
  per-domain subscription sharding (see `workspace-identity.bicep` header:
  ≤200 `resourceAccessRules`/storage account → per-domain lakes).
- **Cost: ~$0** — UAMIs and role assignments are free; the marginal cost is
  the I3 shadow-write RU volume (sampled via `LOOM_WS_IDENTITY_SHADOW_SAMPLE`).
