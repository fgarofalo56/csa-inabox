# Information Protection tab (`/admin/security` → Information Protection)

Microsoft Graph-backed view + management of tenant sensitivity labels and label policies. The Console UAMI authenticates with the `https://graph.microsoft.com/.default` scope via ChainedTokenCredential.

## Sub-tabs

### Sensitivity labels

- **Source** — `GET https://graph.microsoft.com/beta/security/informationProtection/sensitivityLabels`
- **Permission** — `InformationProtectionPolicy.Read.All` (AppRole `19da66cb-0fb0-4390-b071-ebc76a349482`).
- **Renders** — Label name (with color swatch), sensitivity rank, parent label, applicable-to (file / email / site / group), active flag, tooltip / description.

### Label policies

- **Source** — `GET https://graph.microsoft.com/beta/security/informationProtection/policy/labels`
- **Permission** — `InformationProtectionPolicy.Read.All`.
- **Renders** — Policy name, scopes (file / email / site / group), mandatory-labeling flag, default label (resolved to the label name via the cached labels list), description.

### Apply label

Lets an operator evaluate which label MIP would apply to a piece of content:

- **Endpoint** — `POST https://graph.microsoft.com/beta/me/informationProtection/policy/labels/evaluateApplication`
- **Permission** — `SensitivityLabel.Evaluate` (AppRole `57f0b71b-a759-45a0-9a0f-cc099fbd9a44`).
- **Body** — `{ contentInfo: { format, identifier, metadata }, contentToProcess: { contentEntries: [{ id, content }] } }`. Content is capped at 64 KB.
- **Audit** — The BFF auto-injects `{ Loom.Item.Id, Loom.User.Upn }` into `metadata[]` so the upstream MIP policy engine logs include the Loom context.

## Not-configured behaviour

If `LOOM_MIP_ENABLED` is unset (or not `"true"`), every Graph call returns HTTP 503 with `code: mip_not_configured`. The MessageBar names:

- the missing env var,
- both Graph AppRoles required + their AppRole IDs,
- the bootstrap workflow step that grants them (`Grant MIP+DLP Graph AppRoles` in `csa-loom-post-deploy-bootstrap.yml`),
- the Tenant-Admin consent step that follows (Entra → Enterprise applications → Console UAMI → Permissions → Grant admin consent).

If `LOOM_MIP_ENABLED=true` but consent hasn't been granted, Graph returns 403 — the panel surfaces a targeted error MessageBar with the AppRole name to consent.

## Source files

- Panel: `apps/fiab-console/lib/components/admin-security/mip-panel.tsx`
- Client: `apps/fiab-console/lib/azure/mip-graph-client.ts`
- Routes: `apps/fiab-console/app/api/admin/security/mip/{labels,policies,evaluate}/route.ts`
- Vitest: `apps/fiab-console/lib/azure/__tests__/mip-graph-client.test.ts`
