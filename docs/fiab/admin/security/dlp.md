# DLP tab (`/admin/security` → DLP)

Microsoft Graph-backed view of Purview DLP policies + recent alerts + a sample-content policy simulator.

## Reality check — Graph DLP preview status

DLP-via-Graph is split between v1.0 (alerts) and /beta (policies, rules, simulate). The `/beta` policies endpoint is also behind a **tenant-level preview opt-in** in many tenants — if your tenant isn't enrolled, the endpoint returns 404 and the panel surfaces a precise remediation MessageBar rather than faking results.

| Surface | Endpoint | API version | Notes |
|---|---|---|---|
| Policies | `GET /security/dataLossPreventionPolicies` | beta | Tenant-preview-gated |
| Rules | `GET /security/dataLossPreventionPolicies/{id}/rules` | beta | Tenant-preview-gated |
| Alerts | `GET /security/alerts_v2?$filter=detectionSource eq 'microsoftDataLossPrevention'` | v1.0 | Generally available |
| Simulate | `POST /security/dataLossPrevention/evaluatePolicies` | beta | Tenant-preview-gated |

## Sub-tabs

### Policies

- Lists policies. For each: name, mode (enforce/audit), status (Enabled/Disabled), locations (SharePoint / OneDrive / Teams / Exchange / Devices), rule count, last modified.
- "Rules" button per row drills into `GET /security/dataLossPreventionPolicies/{id}/rules`. Renders rule name, priority, enabled flag, description.

### Alerts

- `GET /v1.0/security/alerts_v2` filtered to `detectionSource = 'microsoftDataLossPrevention'`, top 50, default 30-day window.
- Renders created date, title, severity, status, detection source.

### Simulate

- Operator pastes sample text → `POST /beta/security/dataLossPrevention/evaluatePolicies`.
- Result: which rules / sensitive info types would have fired. Renders as the raw Graph evaluation JSON.
- If the endpoint 404s, the BFF returns HTTP 501 with `code: dlp_simulate_preview_not_enabled` and the remediation: "Open a Microsoft support ticket referencing `/beta/security/dataLossPrevention/evaluatePolicies` to request preview enrollment."

## Not-configured behaviour

If `LOOM_DLP_ENABLED` is unset, every sub-tab returns HTTP 503 with `code: dlp_not_configured`. The MessageBar names:

- missing env var (`LOOM_DLP_ENABLED`),
- required Graph AppRoles: `Policy.Read.All` (`572fea84-0151-49b2-9301-11cb16974376`), `SecurityAlert.Read.All` (`bf394140-e372-4bf9-a898-299cfc7564e5`),
- the bootstrap workflow job that grants them,
- the Tenant-Admin consent step.

## Source files

- Panel: `apps/fiab-console/lib/components/admin-security/dlp-panel.tsx`
- Client: `apps/fiab-console/lib/azure/dlp-graph-client.ts`
- Routes: `apps/fiab-console/app/api/admin/security/dlp/{policies,alerts,simulate}/route.ts`
- Vitest: `apps/fiab-console/lib/azure/__tests__/dlp-graph-client.test.ts`
