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
    id: 'svc-workspace-identity', category: 'security', title: 'Workspace identity (per-workspace UAMI)', severity: 'optional',
    anyOf: [['LOOM_WS_IDENTITY_SUB', 'LOOM_SUBSCRIPTION_ID']], warnOnMiss: true,
    remediation: 'Set LOOM_WS_IDENTITY_SUB (falls back to LOOM_SUBSCRIPTION_ID) so workspace-identity creation provisions real per-workspace UAMIs (workspace_identity_not_configured).',
    provisionedBy: 'modules/admin-plane/main.bicep (apps[] env)',
    role: 'Managed Identity Contributor (Console UAMI) on the identity RG',
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
    remediation: 'Set LOOM_ALERT_ACTION_GROUP_ID to the loom-default-alerts action group ARM id (auto-derived from modules/admin-plane/monitoring-default-alerts.bicep on a push-button deploy) so the secret-expiry monitor timer Function (azure-functions/secret-expiry-monitor) can fire the shared alert at the 60/30/7-day thresholds, and the /admin/health Secret-health section shows the same convention. Optionally tune LOOM_SECRET_EXPIRY_WARN_DAYS (default 60). The one-time Graph app-role Application.Read.All admin consent for the Function identity is in docs/fiab/runbooks/secret-rotation.md.',
    provisionedBy: 'modules/admin-plane/monitoring-default-alerts.bicep (defaultActionGroup → LOOM_ALERT_ACTION_GROUP_ID apps[] env) + modules/admin-plane/secret-expiry-monitor-function.bicep (functionAppsConfig.secretExpiryEnabled, default ON)',
    role: 'Microsoft Graph Application.Read.All (application) + Key Vault Secrets User + Monitoring Contributor on the secret-expiry Function identity (KV/Monitoring granted in bicep; the Graph app-role is a one-time admin consent)',
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
];
