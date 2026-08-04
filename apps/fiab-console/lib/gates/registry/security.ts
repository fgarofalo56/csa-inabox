/**
 * R30 fragment — the 'security' domain slice of GATE_META (formerly part of the
 * lib/gates/registry.ts monolith; entries sit in the same domain as their
 * ENV_CHECKS spec in lib/admin/env-checks/security.ts). ./index.ts merges every
 * fragment into the same exported GATE_META shape (public API unchanged).
 * Import ONLY from './types' here — never './index' (barrel-cycle rule).
 */
import { L, type GateMeta } from './types';

export const SECURITY_GATE_META: Record<string, GateMeta> = {
  'svc-secret-expiry': {
    surfaces: [
      { path: '/admin/health', label: 'Health & Reliability — Secret & credential health section' },
      { path: '/api/admin/secret-health', label: 'Secret-health inventory route' },
    ],
    // Fix-it wizard: the alert sink is bicep-derived (monitoring-default-alerts);
    // the wizard writes LOOM_ALERT_ACTION_GROUP_ID / LOOM_SECRET_EXPIRY_WARN_DAYS
    // through the shared env-apply path and shows the one-time Graph
    // Application.Read.All consent script for the CONSOLE UAMI (the identity
    // the migrated ACA job runs as).
    fixit: { kind: 'wizard', grantNote: 'One-time admin consent: grant the CONSOLE UAMI the Microsoft Graph app role Application.Read.All — the same grant scripts/csa-loom/grant-identity-graph-approles.sh performs for the Identity Picker (details in docs/fiab/runbooks/secret-rotation.md). Key Vault Secrets User + Monitoring Contributor are granted by secret-expiry-monitor-job.bicep. B-FN (2026-07-27) moved S1 off the Y1 Function onto the in-VNet loom-secret-expiry-monitor Container App Job, so there is no separate Function identity to consent any more.' },
    autoResolveNote: 'Auto-derived on a push-button deploy: monitoring-default-alerts.bicep creates the loom-default-alerts action group and admin-plane/main.bicep wires LOOM_ALERT_ACTION_GROUP_ID; the loom-secret-expiry-monitor Container App Job deploys default-ON via functionAppsConfig.secretExpiryEnabled.',
    legacyCodes: [],
  },
  'svc-a2a-egress': {
    surfaces: [
      { path: '/admin/copilot', label: 'Copilot & Agents — outbound A2A delegation' },
      { path: '/api/a2a/delegate/*', label: 'Outbound A2A delegate route (egress allow-list)' },
    ],
    // Fix-it: set LOOM_A2A_EGRESS_ALLOW (comma-separated external A2A host suffixes)
    // through the shared env-apply write path. INBOUND A2A + Loom agent cards work
    // with zero config; this only ENABLES outbound delegation to those hosts.
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Unset → outbound A2A is disabled (the sovereign / air-gapped default): inbound task delegation and Loom agent A2A cards remain fully functional, nothing leaves the boundary. Set a comma-separated allow-list of external A2A host suffixes here only to let Loom agents delegate OUT to those specific partner agents.',
    legacyCodes: [],
  },
  'svc-pe-subnet': {
    surfaces: [{ path: '/admin/network', label: 'Network — managed private endpoints' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Auto-derived from the network module (snet-private-endpoints) on a push-button deploy.',
  },
  'svc-onelake-acl': {
    surfaces: [{ path: '/items/lakehouse', label: 'OneLake security — ACL enforcement' }],
    fixit: { kind: 'role-grant', grantNote: 'Also requires Storage Blob Data Owner (Console UAMI) on the DLZ storage account.' },
  },
  'svc-audit-siem-stream': {
    surfaces: [{ path: '/admin/audit-logs', label: 'SIEM audit stream (Sentinel mirror)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'The built-in Cosmos audit trail records every event regardless — the DCR only adds an external SIEM mirror.',
  },
  'svc-mip': {
    surfaces: [
      { path: '/admin/sensitivity-labels', label: 'Sensitivity labels (MIP)' },
      { path: '/admin/batch-labeling', label: 'Batch labeling' },
    ],
    fixit: { kind: 'role-grant', grantNote: 'Also grant the Console UAMI Graph InformationProtectionPolicy.Read.All (application).' },
    legacyCodes: ['mip_not_configured', 'mip_admin_not_configured'],
  },
  'svc-dlp': {
    surfaces: [{ path: '/admin/security', label: 'DLP policies' }],
    fixit: { kind: 'role-grant', grantNote: 'Also grant the Purview DLP Graph application roles to the Console UAMI.' },
    legacyCodes: ['dlp_not_configured', 'dlp_admin_not_configured', 'dlp_simulate_not_available'],
  },
  'svc-keyvault': {
    surfaces: [
      { path: '/items/lakehouse-shortcut', label: 'Shortcut credentials' },
      { path: '/admin/security', label: 'CMK pane' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_KEY_VAULT_URI: L.keyvault, LOOM_SHORTCUT_KEYVAULT: L.keyvault },
    legacyCodes: ['kv_not_configured', 'key_vault_not_configured', 'shortcut_keyvault_not_configured', 'cert_vault_not_configured', 'cmk_not_configured'],
  },
  'svc-workspace-identity': {
    surfaces: [
      { path: '/workspaces', label: 'Workspace create — per-workspace UAMI provisioning (I1)' },
      { path: '/workspaces?settings=identity', label: 'Workspace Settings → Identity panel — per-workspace enforcement (I6)' },
      { path: '/api/admin/workspaces/*/identity', label: 'Per-workspace identity enforcement toggle (I6 GET/POST)' },
      { path: '/api/workspaces/*', label: 'Workspace create/delete (identity provision + cascade)' },
    ],
    // Fix-it wizard: the workspace Settings → Identity panel (I6) IS this gate's
    // Fix-it surface (ux-standards G2). It sets LOOM_WORKSPACE_IDENTITY_MODE to
    // shadow first (provision + record only — zero behavior change), then, once
    // the I7 grant-check preflight is ready, the 14-day shadow divergence is
    // zero, AND the I9 AppSec review is signed off, exposes the per-workspace
    // Enable-enforcement toggle (data on the doc, no env change).
    fixit: {
      kind: 'wizard',
      grantNote: 'Flip LOOM_WORKSPACE_IDENTITY_MODE to shadow first (provision + record only — zero behavior change), review the per-workspace divergence rollup in Workspace Settings → Identity, then enable enforcement per workspace once the I7 preflight is green + the I9 review is signed off. The Console UAMI needs Managed Identity Contributor on the workspace-identity RG (ws-identity-rbac.bicep, deployed by the push-button bicep).',
    },
    autoResolveNote: 'Unset → mode off (the intended day-one default): every call runs as the shared Console UAMI, unchanged. Phased shadow → enforce is the sole Phase-0 exception to default-ON, per the operator decision recorded in the loom-next-level PRP.',
    legacyCodes: ['workspace_identity_not_configured'],
  },
  // LU-2 — Loom Unity catalog authorization. Fix-it is a WIZARD, not a bare env
  // write: the value only takes effect once the loom-unity Container App is
  // redeployed with authMode=entra + a matching entraClientId (and, ideally,
  // consoleAllowedCidrs pinning ingress to the Console subnet). The wizard states
  // both halves so an operator cannot set the Console var and believe the catalog
  // is secured when the server still answers anonymous callers — the live
  // probe-loom-unity-authz check is the proof either way.
  'svc-loom-unity-authz': {
    surfaces: [
      { path: '/catalog/unity', label: 'Loom Unity — Explore / Grants / Storage' },
      { path: '/api/catalog/unity/capabilities', label: 'Loom Unity capability + authorization posture' },
      { path: '/api/databricks/unity-catalog/*', label: 'Unity Catalog BFF (the single audited choke point)' },
      { path: '/admin/health', label: 'Health — probe-loom-unity-authz' },
    ],
    fixit: {
      kind: 'wizard',
      grantNote: 'Two halves, both required, and this gate applies ONLY where the catalog is actually deployed (LOOM_UNITY_URL set — Commercial estates run Databricks Unity Catalog and never stand loom-unity up). (1) SERVER: redeploy modules/compute/loom-unity-app.bicep with authMode=entra (default) + entraClientId=<Entra app registration fronting Loom Unity, normally the same as LOOM_MSAL_CLIENT_ID>, consoleAllowedCidrs=<Container Apps infrastructure subnet CIDR> to pin ingress, and entraClientSecretUri/adlsClientSecretUri as Key Vault secret URIs (never inline). The loom-unity UAMI needs "Key Vault Secrets User" on that vault. authMode=entra with no pinnable audience now deploys SEALED (up, sentinel .invalid audience nothing can mint, scaled to zero, every caller rejected) instead of silently downgrading to an anonymous catalog. (2) CONSOLE: set LOOM_UNITY_CLIENT_ID (or LOOM_UNITY_AUDIENCE). The Console mints an Entra bearer and exchanges it at POST /api/1.0/unity-control/auth/tokens for the server-minted internal token the catalog accepts — that exchange client has LANDED (lib/azure/uc-token-exchange.ts, #2679); this note previously called it a follow-up and prescribed LOOM_UNITY_TOKEN instead, which no bicep module emits and no Key Vault secret backs. Upstream still rejects a raw Entra bearer 403 by design (docs/fiab/security/loom-unity-authz-proof.md), and the exchange additionally requires the Console principal to be an ENABLED Unity Catalog user. LOOM_UNITY_AUTH_MODE=anonymous does NOT close this gate — it is the finding it exists to detect (issue #2643). Verify with the live probe-loom-unity-authz health check: it must report that an unauthenticated read is rejected.',
    },
    legacyCodes: ['unity_authz_not_configured'],
  },
  // LU-9 — the open Delta Sharing endpoint. Fix-it is a WIZARD because the value
  // only takes effect once the loom-sharing Container App is deployed WITH a Key
  // Vault bearer the Console also holds: setting LOOM_SHARING_URL alone would
  // point the BFF at nothing, and deploying the server without the shared bearer
  // would leave the Console unable to authenticate to it. Both halves, one
  // secret. Until wired, the Marketplace Data-shares surface keeps its existing
  // Databricks backend (or its honest 501 where there is no Databricks).
  'svc-loom-sharing': {
    surfaces: [
      { path: '/marketplace', label: 'Marketplace — Data shares (publish + grant)' },
      { path: '/api/marketplace/sharing/*', label: 'Sharing BFF (shares / recipients / manifest)' },
      { path: '/api/delta-sharing/*', label: 'Recipient-facing Delta Sharing protocol endpoint' },
    ],
    fixit: {
      kind: 'wizard',
      grantNote: 'Two halves, ONE Key Vault secret. (1) SERVER: deploy modules/compute/loom-sharing-app.bicep with sharingBearerSecretUri=<KV secret URI>, adlsAccount/adlsClientId/adlsClientSecretUri for the read-only storage principal (hadoop-azure cannot use a Container Apps managed identity — it asks the classic IMDS endpoint ACA does not serve), and consoleAllowedCidrs=<Container Apps infrastructure subnet CIDR>. Ingress is INTERNAL in every configuration by design. (2) CONSOLE: set LOOM_SHARING_URL to the app FQDN and the LOOM_SHARING_BEARER secretref to the SAME Key Vault secret. (3) PIN THE RECIPIENT CREDENTIAL (required — /api/delta-sharing/* returns 503 until one is set): LOOM_SHARING_AUDIENCE = a DEDICATED Entra app registration (App ID URI) for recipients, OR LOOM_SHARING_SCOPE = a scope/app role exposed on the Console registration and consented only to recipient apps. The fallback audience api://<LOOM_MSAL_CLIENT_ID> is the CONSOLE OWN API, so an unpinned endpoint would accept any Console access token as a data-export credential; restating api://<clientId> in LOOM_SHARING_AUDIENCE does not satisfy the pin. See docs/fiab/security/loom-sharing-threat-model.md.',
    },
    autoResolveNote: 'Unset → the Marketplace Data-shares surface uses the Databricks Delta Sharing backend where a workspace is bound. In Azure Government (no Databricks UC endpoint) that surface has no backend at all until loom-sharing is deployed, which is exactly the gap LU-9 closes.',
    legacyCodes: [],
  },
};
