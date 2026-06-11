# DLP tab (`/admin/security` → DLP)

Microsoft Graph-backed view of Purview DLP policies + recent alerts/violations + a sample-content policy simulator, plus an Azure-native **Restrict access** enforcement tab that needs no Graph, Purview, or Fabric dependency.

## Wired by default

`loomDlpEnabled` defaults to **`true`** in every bicep layer (`main.bicep`, `admin-plane/main.bicep`, `commercial.bicepparam`, `commercial-full.bicepparam`), so `LOOM_DLP_ENABLED=true` is injected into the Console Container App out of the box. The post-deploy bootstrap (`csa-loom-post-deploy-bootstrap.yml`) grants the DLP Graph AppRoles by default. Result: the DLP tab no longer shows "not wired in this deployment" on a default deploy. Alerts + violations + Restrict-access work immediately once admin consent is issued; the preview-gated policy segment + simulate surface an honest MessageBar where the tenant isn't enrolled.

## Reality check — Graph DLP preview status

DLP-via-Graph is split between v1.0 (alerts) and /beta (policies, rules, simulate). The `/beta` policies endpoint hangs off the **`informationProtection`** navigation property (backing cmdlet `Get-MgBetaInformationProtectionDataLossPreventionPolicy`) and is behind a **tenant-level preview opt-in** in many tenants — if your tenant isn't enrolled, the endpoint returns 404 / 400 "Resource not found for the segment" and the panel surfaces a precise remediation MessageBar rather than faking results. (The older `security/dataLossPreventionPolicies` path was never a real Graph route and always 400'd.)

| Surface | Endpoint | API version | Notes |
|---|---|---|---|
| Policies | `GET /informationProtection/dataLossPreventionPolicies` | beta | Tenant-preview-gated; not in Gov Graph roots |
| Rules | `GET /informationProtection/dataLossPreventionPolicies/{id}/policyRules` | beta | Tenant-preview-gated |
| Alerts | `GET /security/alerts_v2?$filter=detectionSource eq 'microsoftDataLossPrevention'` | v1.0 | GA in every cloud (incl. graph.microsoft.us / dod-graph.microsoft.us) |
| Violations | `GET /security/alerts_v2` (per-item evidence shaping) | v1.0 | GA in every cloud |
| Simulate | `POST /security/dataLossPrevention/evaluatePolicies` | beta | Tenant-preview-gated |
| Restrict access | `POST /api/governance/dlp/restrict` (ARM / TDS / ADX) | — | No Graph; works in every cloud, Fabric workspace unset |

## Sub-tabs

### Policies

- Lists policies. For each: name, mode (enforce/audit), status (Enabled/Disabled), locations, rule count, last modified.
- "Rules" button per row drills into `GET /informationProtection/dataLossPreventionPolicies/{id}/policyRules`.

### Violations / Alerts

- `GET /v1.0/security/alerts_v2` filtered to `detectionSource = 'microsoftDataLossPrevention'`, top 50, default 30-day window. Violations shape per-item evidence (item path/type, policy, user, action) best-effort. GA in every cloud.

### Restrict access (Azure-native, no Fabric)

The Azure-native equivalent of Purview DLP's "Restrict access" action. Pick a **scope type**, the target resource, and a **principal** (Entra people-picker), then revoke that principal's real data-plane access:

| Scope type | Backend revoke |
|---|---|
| ADLS container | Storage data-plane RBAC `DELETE` + ARM read-back confirmation |
| ADLS path | POSIX ACL removal (access + default) + ACL read-back |
| Warehouse | Inverse Synapse SQL grant replay (read/write/admin) |
| Warehouse schema | `DENY SELECT ON SCHEMA::[s]` (real TDS) |
| KQL database | ADX revoke command |

Every action is recorded in the Cosmos `dlp-meta:<tenant>` doc and listed under "Recent restrict-access actions". This path has **no Microsoft Graph, Purview, or Fabric dependency** — it works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. Backed by `app/api/governance/dlp/restrict/route.ts`.

### Simulate

- Operator pastes sample text → `POST /beta/security/dataLossPrevention/evaluatePolicies`.
- If the endpoint 404s, the BFF returns HTTP 501 with the preview-enrollment remediation.

## Honest-gate behaviour

If `LOOM_DLP_ENABLED` is somehow unset (it defaults true), every Graph sub-tab returns HTTP 503 with `code: dlp_not_configured`. The MessageBar names:

- missing env var (`LOOM_DLP_ENABLED`),
- required Graph AppRoles: `Policy.Read.All` (`246dd0d5-5bd0-4def-940b-0421030a5b68`), `SecurityAlert.Read.All` (`bf394140-e372-4bf9-a898-299cfc7564e5`),
- the bootstrap workflow job that grants them (`scripts/csa-loom/grant-graph-approles.sh`),
- the Tenant-Admin consent step.

In US Government / DoD clouds the policy segment is unavailable; the panel honest-gates to the Purview compliance portal while Alerts/Violations/Restrict-access continue to work.

## Source files

- Panel: `apps/fiab-console/lib/components/admin-security/dlp-panel.tsx`
- Client: `apps/fiab-console/lib/azure/dlp-graph-client.ts`
- Routes: `apps/fiab-console/app/api/admin/security/dlp/{policies,alerts,violations,simulate}/route.ts`
- Azure-native enforcement: `apps/fiab-console/app/api/governance/dlp/restrict/route.ts`
- Vitest: `apps/fiab-console/lib/azure/__tests__/dlp-graph-client.test.ts`
