/**
 * R30 fragment — the 'security' domain slice of ENV_CHECKS (formerly part of the
 * lib/admin/env-checks.ts monolith). An env-adding item edits ONLY its own
 * domain fragment; ./index.ts merges every fragment into the same exported
 * ENV_CHECKS array (public API unchanged). Import ONLY from './core' here —
 * never './index' (barrel-cycle rule, WS-E1 gotcha).
 */
import type { EnvSpec } from './core';

export const SECURITY_ENV_CHECKS: EnvSpec[] = [
  {
    id: 'svc-pe-subnet', category: 'security', title: 'Managed private endpoints — PE subnet', severity: 'optional',
    required: ['LOOM_PE_SUBNET_ID'], warnOnMiss: true, derived: true,
    remediation: 'Auto-derived from the network module (snet-private-endpoints) on a push-button deploy. Set LOOM_PE_SUBNET_ID to the ARM id of the private-endpoints subnet so tenant admins can create self-service managed private endpoints (and workspace inbound-protection / outbound PE rules) from the admin Network page. The Console UAMI needs Network Contributor on the networking RG.',
    provisionedBy: 'modules/admin-plane/main.bicep (network.outputs.privateEndpointsSubnetId → apps[] env, auto-derived, line ~2353)',
    role: 'Network Contributor (Console UAMI) on the networking resource group (LOOM_NETWORKING_RG / LOOM_ADMIN_RG)',
  },
  {
    id: 'svc-onelake-acl', category: 'security', title: 'OneLake security roles — ADLS ACL enforcement', severity: 'optional',
    required: ['LOOM_ONELAKE_SECURITY_ACL'], warnOnMiss: true,
    remediation: 'Set LOOM_ONELAKE_SECURITY_ACL=true so lakehouse OneLake-security roles are ENFORCED as real ADLS Gen2 POSIX ACLs on the Delta folders (deploy admin-plane + synapse.bicep with loomOnelakeSecurityEnabled=true). Requires the Console UAMI to hold "Storage Blob Data Owner" on the DLZ storage account and the LOOM_{LANDING,BRONZE,SILVER,GOLD}_URL container URLs to be set. Role definitions still author + persist without it — only ACL enforcement is gated.',
    provisionedBy: 'modules/admin-plane/main.bicep (param loomOnelakeSecurityEnabled → LOOM_ONELAKE_SECURITY_ACL, ~3484) + modules/landing-zone/synapse.bicep (Storage Blob Data Owner grant)',
    role: 'Storage Blob Data Owner (Console UAMI) on the DLZ storage account',
  },
  {
    id: 'svc-audit-siem-stream', category: 'security', title: 'SIEM audit stream — LoomAudit_CL DCR (BR-SIEM)', severity: 'optional',
    required: ['LOOM_AUDIT_DCR_ENDPOINT', 'LOOM_AUDIT_DCR_ID'], warnOnMiss: true,
    // Default-ON / opt-out (loom_default_on_opt_out): audit logging is fully ON
    // via the built-in Cosmos audit trail (/admin/audit-logs) regardless of these
    // vars — emitAuditEvent() silently no-ops when the DCR is unset, losing ZERO
    // audit records. The DCR only ADDS an optional external mirror (streaming to
    // the LoomAudit_CL table for Microsoft Sentinel / any SIEM). So an unset DCR
    // is the fully-functional intended default, not a gap. Marked optionalDefault.
    optionalDefault: true,
    optionalDefaultDetail: 'every admin-plane mutation is recorded in the built-in Cosmos audit trail (/admin/audit-logs). Setting LOOM_AUDIT_DCR_ENDPOINT + LOOM_AUDIT_DCR_ID additionally MIRRORS each event to the LoomAudit_CL table for Microsoft Sentinel / any SIEM.',
    remediation: 'Set LOOM_AUDIT_DCR_ENDPOINT (the DCE logs-ingestion endpoint) + LOOM_AUDIT_DCR_ID (the DCR immutable id) so every admin-plane mutation streams to the LoomAudit_CL custom table via the Azure Monitor Logs Ingestion API, where Microsoft Sentinel / any SIEM can alert continuously (docs/fiab/operations/siem-audit-stream.md). The push-button deploy wires both from modules/admin-plane/audit-stream.bicep. Without them the emitter silently no-ops — the Cosmos audit trail on /admin/audit-logs is unaffected. The Console UAMI needs "Monitoring Metrics Publisher" on the DCR (granted by the module).',
    provisionedBy: 'modules/admin-plane/audit-stream.bicep (DCE + DCR + LoomAudit_CL table) → admin-plane/main.bicep apps[] env LOOM_AUDIT_DCR_ENDPOINT / LOOM_AUDIT_DCR_ID',
    role: 'Monitoring Metrics Publisher (Console UAMI) on the audit DCR',
  },
  // ── wave-3 coverage (G2 gate registry): every remaining bespoke
  //    *_not_configured gate promoted into the declarative registry. Each spec
  //    makes its vars editable on /admin/env-config (EDITABLE_ENV derives from
  //    THESE), audited here, and resolvable from /admin/gates + the Fix-it
  //    wizard. All optional/warnOnMiss — a fresh minimal deploy is all-gates,
  //    zero-fails. Canonical producers: the per-client *ConfigGate() helpers. ──
  {
    id: 'svc-mip', category: 'security', title: 'Microsoft Information Protection (sensitivity labels)', severity: 'optional',
    required: ['LOOM_MIP_ENABLED'], warnOnMiss: true,
    remediation: 'Set LOOM_MIP_ENABLED=true and grant the Console UAMI Graph InformationProtectionPolicy.Read.All so label pickers read the tenant\'s real MIP labels (mip_not_configured). Loom-native labels work without it.',
    provisionedBy: 'modules/admin-plane/main.bicep (apps[] env) + post-deploy Graph grant',
    role: 'Microsoft Graph InformationProtectionPolicy.Read.All (application) on the Console UAMI',
  },
  {
    id: 'svc-dlp', category: 'security', title: 'Data Loss Prevention (Purview DLP)', severity: 'optional',
    anyOf: [['LOOM_DLP_ENABLED', 'LOOM_DLP_ADMIN_ENABLED']], warnOnMiss: true,
    remediation: 'Set LOOM_DLP_ENABLED=true (+ LOOM_DLP_ADMIN_ENABLED=true for the admin DLP panes) and grant the Graph DLP application roles so DLP policy surfaces drive the real Purview DLP plane (dlp_not_configured / dlp_admin_not_configured). The Loom-native policy library works without it.',
    provisionedBy: 'modules/admin-plane/main.bicep (apps[] env) + post-deploy Graph grant',
    role: 'Purview DLP Graph application roles on the Console UAMI',
    // X-MATRIX (DLP-policy): the Graph DLP policy API
    // (/beta/security/dataLossPreventionPolicies) does NOT exist in GCC-High/IL5
    // (graphDlpPolicyApiAvailable() = false in Gov) → 'unavailable' there.
    availability: {
      commercial: 'ga', gccHigh: 'unavailable', il5: 'unavailable',
      fallbackNote: 'The Microsoft Graph DLP policy API is not available in Azure Government — manage DLP policies via the Purview compliance portal + Security & Compliance PowerShell. DLP alerts + restrict-access RBAC still work, and the Loom-native policy library is fully functional.',
    },
  },
  {
    id: 'svc-workspace-identity', category: 'security', title: 'Per-workspace managed identity (shadow → enforce)', severity: 'optional',
    required: ['LOOM_WORKSPACE_IDENTITY_MODE'],
    // I3: LOOM_WS_IDENTITY_SHADOW_SAMPLE is an optional tuning alias (code
    // default 1.0) grouped with the mode var so an unset sample never warns —
    // the svc-secret-expiry warn-days precedent. No new gate (folds here).
    anyOf: [['LOOM_WS_IDENTITY_SUB', 'LOOM_SUBSCRIPTION_ID'], ['LOOM_WS_IDENTITY_RG', 'LOOM_DLZ_RG'], ['LOOM_WS_IDENTITY_SHADOW_SAMPLE', 'LOOM_WORKSPACE_IDENTITY_MODE']],
    warnOnMiss: true,
    // I1 — the SOLE Phase-0 exception to default-ON (loom_default_on_opt_out):
    // identity ENFORCEMENT is a security-posture change an operator phases in
    // shadow → enforce (operator decision recorded in the loom-next-level PRP),
    // exactly like LOOM_PDP_ENFORCE. Unset mode = 'off' = the fully-functional
    // intended default: every call runs as the shared Console UAMI, unchanged.
    optionalDefault: true,
    optionalDefaultDetail: 'mode is off (the intended day-one default) — every data-plane call runs as the shared Console UAMI, bit-for-bit today\'s behavior. Setting LOOM_WORKSPACE_IDENTITY_MODE=shadow additionally provisions a scoped uami-ws-<id> per workspace on create (recorded on the workspace doc, zero behavior change); enforce is the phased I6 posture flip.',
    remediation: 'Set LOOM_WORKSPACE_IDENTITY_MODE=shadow (off | shadow | enforce; default off) to provision a per-workspace uami-ws-<id> + its scoped grant MATRIX on every workspace create (I2: ADLS container ARM-RBAC; Cosmos / Synapse / ADX as data-plane grants; Event Hubs namespace RBAC — docs/fiab/runbooks/workspace-identity-grants.md) — best-effort, never blocking, per-grant outcome recorded on the workspace doc (workspace delete cascades the UAMI + role assignments). The UAMIs land in LOOM_WS_IDENTITY_RG (falls back to LOOM_DLZ_RG) under LOOM_WS_IDENTITY_SUB (falls back to LOOM_SUBSCRIPTION_ID); the Console UAMI needs Managed Identity Contributor there (ws-identity-rbac.bicep).',
    provisionedBy: 'modules/admin-plane/ws-identity-rbac.bicep (Managed Identity Contributor → Console UAMI on the workspace-identity RG) + admin-plane/main.bicep workspaceIdentityConfig bag → apps[] env LOOM_WORKSPACE_IDENTITY_MODE / LOOM_WS_IDENTITY_SUB / LOOM_WS_IDENTITY_RG',
    role: 'Managed Identity Contributor (e40ec5ca-96e0-45a2-b4ff-59039f2c2b59, Console UAMI) on the workspace-identity RG; lake grants ride the constrained RBAC-Administrator from landing-zone/storage-rbac-admin.bicep',
    // X2 — Microsoft.ManagedIdentity + ARM role assignments are GA in every
    // sovereign boundary (Commercial / GCC-High / IL5); role GUIDs are
    // cloud-invariant and the ARM host resolves via armBase().
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'Managed identities + role assignments are GA in all clouds. IL5/air-gap: the workspace-identity RG and lake must live inside the air-gapped subscription — ARM calls stay in-boundary (armBase()), no cross-cloud identity federation.',
    },
  },
  {
    id: 'svc-keyvault', category: 'security', title: 'Key Vault (connection / shortcut / MCP secrets)', severity: 'recommended',
    anyOf: [['LOOM_KEY_VAULT_URI', 'LOOM_KEY_VAULT_URL', 'LOOM_KEY_VAULT_NAME', 'LOOM_SHORTCUT_KEYVAULT']], warnOnMiss: true,
    remediation: 'Set LOOM_KEY_VAULT_URI (or LOOM_KEY_VAULT_NAME) so shortcut external-source credentials, Git PATs, and MCP server secrets have a secret store. Grant the Console UAMI "Key Vault Secrets Officer" on the vault.',
    provisionedBy: 'modules/admin-plane/main.bicep (Key Vault + RBAC grant → apps[] env LOOM_KEY_VAULT_URI, auto-derived)',
    role: 'Key Vault Secrets Officer (Console UAMI) on the vault',
  },
  {
    id: 'svc-secret-expiry', category: 'security', title: 'Secret & credential expiry monitoring (S1)', severity: 'recommended',
    // The shared derived alert sink (O1 convention): monitoring-default-alerts.bicep's
    // loom-default-alerts action group, auto-wired as LOOM_ALERT_ACTION_GROUP_ID on a
    // push-button deploy. The warn-days threshold is an optional tuning alias (code
    // default 60) — grouped with the action-group id so an unset threshold never warns.
    required: ['LOOM_ALERT_ACTION_GROUP_ID'],
    anyOf: [['LOOM_SECRET_EXPIRY_WARN_DAYS', 'LOOM_ALERT_ACTION_GROUP_ID']],
    warnOnMiss: true, derived: true,
    remediation: 'Set LOOM_ALERT_ACTION_GROUP_ID to the loom-default-alerts action group ARM id (auto-derived from modules/admin-plane/monitoring-default-alerts.bicep on a push-button deploy) so the secret-expiry monitor job (loom-secret-expiry-monitor, an in-VNet scheduled Container App Job — azure-functions/secret-expiry-monitor) can fire the shared alert at the 60/30/7-day thresholds, and the /admin/health Secret-health section shows the same convention. Optionally tune LOOM_SECRET_EXPIRY_WARN_DAYS (default 60). The job runs as the CONSOLE UAMI, so the one-time Graph app-role Application.Read.All admin consent it needs is the one scripts/csa-loom/grant-identity-graph-approles.sh already performs for the Identity Picker (details in docs/fiab/runbooks/secret-rotation.md).',
    provisionedBy: 'modules/admin-plane/monitoring-default-alerts.bicep (defaultActionGroup → LOOM_ALERT_ACTION_GROUP_ID apps[] env) + modules/admin-plane/secret-expiry-monitor-job.bicep (functionAppsConfig.secretExpiryEnabled, default ON — B-FN migrated S1 off the Y1 Function onto the in-VNet ACA-job pattern)',
    role: 'Microsoft Graph Application.Read.All (application) + Key Vault Secrets User + Monitoring Contributor on the CONSOLE UAMI, which the job runs as (KV/Monitoring granted in the job module; the Graph app-role is the one-time admin consent grant-identity-graph-approles.sh performs)',
    // X2: Graph + Key Vault + Azure Monitor action groups are GA in every
    // boundary — only the endpoints differ (.us Graph/ARM, wired by bicep).
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'Fully supported in Azure Government — the monitor uses graph.microsoft.us / dod-graph.microsoft.us and the .us ARM endpoint (injected by bicep). In IL5 the GitHub dedup issue is disabled (token unset) so alerting stays in-boundary via the action group.',
    },
  },
  {
    id: 'svc-a2a-egress', category: 'security', title: 'A2A outbound egress profile (gov-safe allow-list)', severity: 'optional',
    required: ['LOOM_A2A_EGRESS_ALLOW'], warnOnMiss: true, optionalDefault: true,
    // WS-5.2. INBOUND A2A (an external agent delegating a task INTO Loom, and Loom
    // agents registering as A2A cards) is fully functional with ZERO config. This
    // var only governs OUTBOUND delegation (a Loom agent calling an EXTERNAL A2A
    // agent). UNSET = outbound A2A disabled = the sovereign / air-gapped default
    // (nothing leaves the boundary), which is the intended posture — so an unset
    // value is a fully-functional default, not a gap (optionalDefault).
    optionalDefaultDetail: 'inbound A2A task delegation + Loom agent cards work with no config. Setting LOOM_A2A_EGRESS_ALLOW (comma-separated external A2A host suffixes) is only needed to ENABLE Loom agents to delegate OUT to those specific external agents; left unset, outbound A2A stays disabled (the sovereign default).',
    remediation: 'Runtime-only knob (no Azure resource). To let Loom agents delegate tasks OUT to external A2A agents (WS-5.2 outbound), set LOOM_A2A_EGRESS_ALLOW to a comma-separated list of allowed external A2A host suffixes (e.g. "partner-agents.example.com"). ONLY those hosts become reachable; everything else (incl. the whole public internet) stays refused — the gov-safe egress profile. Leave it unset in sovereign / air-gapped deployments so nothing leaves the boundary. Inbound A2A (external agents delegating INTO Loom via /api/a2a) needs no config.',
    provisionedBy: 'runtime-only (admin-plane apps[] env LOOM_A2A_EGRESS_ALLOW; no bicep resource — an outbound-egress policy knob)',
    role: 'none (an egress allow-list; the outbound fetch uses the Console UAMI / the caller-supplied token)',
  },
  // ── LU-2 — Loom Unity (Unity-Catalog-compatible OSS server) authorization ──
  // The deployed catalog shipped with `server.authorization=disable`: anything
  // that could reach the Container Apps environment could read AND mutate catalog
  // metadata anonymously (and mint ADLS delegation SAS where vending was wired).
  // LU-2 makes Entra authorization the bicep default and makes the Console present
  // a credential on every call. This spec declares the Console half so the state is
  // (a) visible on /admin/gates with an inline Fix-it, and (b) resolvable through
  // the one shared env-apply write path.
  //
  // SCOPE NOTE (honest): ENV_CHECKS has no "applies only when X" predicate, so on a
  // Commercial estate that never deploys loom-unity this row reads as an unset
  // optional gate. The SHARP verdict lives in the live probe
  // `probe-loom-unity-authz` (health-probes.ts), which passes when LOOM_UNITY_URL
  // is absent and FAILS with real evidence — an unauthenticated HTTP 200 — when a
  // deployed catalog answers anonymous callers.
  {
    id: 'svc-loom-unity-authz', category: 'security',
    title: 'Loom Unity — catalog authorization (Entra bearer)', severity: 'recommended',
    anyOf: [['LOOM_UNITY_CLIENT_ID', 'LOOM_UNITY_AUDIENCE', 'LOOM_UNITY_AUTH_MODE']],
    warnOnMiss: true,
    remediation: 'Loom Unity (the Unity-Catalog-compatible OSS catalog Loom deploys for the sovereign path) must not be reachable anonymously. (1) Redeploy platform/fiab/bicep/modules/compute/loom-unity-app.bicep with authMode=entra (the default) and entraClientId=<the Entra app registration fronting Loom Unity — normally the same one as LOOM_MSAL_CLIENT_ID>, plus consoleAllowedCidrs=<the Container Apps infrastructure subnet> to pin ingress to the Console. (2) Set LOOM_UNITY_CLIENT_ID on the Console (or LOOM_UNITY_AUDIENCE for an explicit scope) so the BFF mints an Entra bearer from the Console managed identity on every catalog call — the BFF is the single audited choke point; nothing else talks to the catalog. A pre-shared server-minted token via LOOM_UNITY_TOKEN (Key Vault secretref) is the alternative. Leave unset ONLY where loom-unity is not deployed (Commercial estates on the Databricks Unity Catalog path). Threat model: docs/fiab/security/loom-unity-threat-model.md.',
    provisionedBy: 'modules/compute/loom-unity-app.bicep (authMode / entraClientId / entraClientSecretUri / consoleAllowedCidrs — standalone out-of-band entrypoint, admin-plane/main.bicep is at the 256-param ceiling) → LOOM_UNITY_CLIENT_ID on the Console app',
    role: 'Key Vault Secrets User (loom-unity UAMI) on the vault holding the Entra / ADLS-vending client secrets; no role is needed for the Console to mint its own bearer',
    docs: 'https://docs.unitycatalog.io/server/auth/',
    // X2: Microsoft Entra + Container Apps IP restrictions are GA in every
    // boundary; only the authority host differs (login.microsoftonline.us in Gov),
    // which the bicep derives from environment().authentication.loginEndpoint.
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'Fully supported in Azure Government — the issuer is pinned to https://login.microsoftonline.us/<tenant>/v2.0, derived from the cloud, never hard-coded.',
    },
  },
  // ── LU-9 — Loom Sharing (the open Delta Sharing endpoint) ──────────────────
  // Databricks Delta Sharing has no Azure Government endpoint and OSS Unity
  // Catalog 0.5 does not implement the sharing server, so on the sovereign path
  // the Marketplace "Data shares" surface has no backend at all until the
  // loom-sharing Container App is deployed. This spec declares the CONSOLE half
  // (the URL + the shared bearer) so the state is visible on /admin/gates with an
  // inline Fix-it and resolvable through the one shared env-apply write path.
  //
  // SCOPE NOTE (honest): ENV_CHECKS has no "applies only when X" predicate, so on
  // a Commercial estate that publishes shares through Databricks this row reads as
  // an unset optional gate — which is correct: nothing is broken there.
  {
    id: 'svc-loom-sharing', category: 'security',
    title: 'Loom Sharing — open Delta Sharing server (sovereign path)', severity: 'optional',
    required: ['LOOM_SHARING_URL'],
    // NOTE: the RECIPIENT credential pin (LOOM_SHARING_AUDIENCE /
    // LOOM_SHARING_SCOPE) is deliberately NOT declared here. It only means
    // anything once the recipient-facing endpoint exists, and that was split out
    // of this change — declaring it now would tell an operator to configure a
    // credential for an endpoint this build does not serve. It comes back with
    // the endpoint; see docs/fiab/security/loom-sharing-threat-model.md.
    warnOnMiss: true, optionalDefault: true,
    optionalDefaultDetail: 'unset → the Marketplace Data-shares surface uses the Databricks Delta Sharing backend wherever a workspace is bound. In Azure Government there is no Databricks Unity Catalog endpoint, so that surface stays gated until loom-sharing is deployed.',
    remediation: 'Deploy the OSS Delta Sharing reference server and point the Console at it. (1) SERVER: az deployment group create -f platform/fiab/bicep/modules/compute/loom-sharing-app.bicep with sharingBearerSecretUri=<Key Vault secret URI for the Console-to-server bearer>, adlsAccount/adlsTenantId/adlsClientId/adlsClientSecretUri for a READ-ONLY storage principal (hadoop-azure cannot use a Container Apps managed identity - it queries the classic IMDS endpoint, which ACA does not serve), and consoleAllowedCidrs=<Container Apps infrastructure subnet CIDR>. Ingress is INTERNAL in every configuration: the upstream server has ONE global bearer and cannot scope a caller to a subset of shares. (2) CONSOLE: set LOOM_SHARING_URL to the app FQDN and the LOOM_SHARING_BEARER secretref to the SAME Key Vault secret. That gives you the CONTROL plane - publish a share, register a recipient, grant/revoke, render the server manifest, audit. The RECIPIENT-facing protocol endpoint is not part of this build and no external party can reach the server: see docs/fiab/security/loom-sharing-threat-model.md for the follow-up that adds it. Threat model: docs/fiab/security/loom-sharing-threat-model.md.',
    provisionedBy: 'modules/compute/loom-sharing-app.bicep (standalone out-of-band entrypoint — admin-plane/main.bicep is at the 256-param ceiling) → LOOM_SHARING_URL + the LOOM_SHARING_BEARER secretref on the Console app',
    role: 'Key Vault Secrets User (loom-sharing UAMI) on the vault holding the server bearer + the storage OAuth secret; Storage Blob Data Reader (storage OAuth principal) on the shared container(s) only — this server never writes',
    docs: 'https://delta.io/sharing/',
    // Container Apps internal ingress, Key Vault secretrefs, and Entra token
    // validation are GA in every boundary; only the authority + storage endpoint
    // suffixes differ, and both are derived from environment() in the bicep.
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'Fully supported in Azure Government — this IS the Gov path, since Databricks Delta Sharing has no Gov endpoint. The storage endpoint suffix and the Entra authority are derived from environment(), never hard-coded.',
    },
  },
];
