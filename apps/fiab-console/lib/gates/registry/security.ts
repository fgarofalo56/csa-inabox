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
    // Application.Read.All consent script for the Function identity.
    fixit: { kind: 'wizard', grantNote: 'One-time admin consent: grant the secret-expiry Function identity the Microsoft Graph app role Application.Read.All (script in docs/fiab/runbooks/secret-rotation.md). KV + Monitoring roles are granted by secret-expiry-monitor-function.bicep.' },
    autoResolveNote: 'Auto-derived on a push-button deploy: monitoring-default-alerts.bicep creates the loom-default-alerts action group and admin-plane/main.bicep wires LOOM_ALERT_ACTION_GROUP_ID; the secret-expiry monitor Function deploys default-ON via functionAppsConfig.secretExpiryEnabled.',
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
      { path: '/api/workspaces/*', label: 'Workspace create/delete (identity provision + cascade)' },
    ],
    // Fix-it wizard: sets LOOM_WORKSPACE_IDENTITY_MODE (+ the sub/RG fallbacks)
    // through the shared env-apply write path; the pre-filled fixScript/
    // portalSteps from the self-audit check carry the exact values. The fuller
    // "Enable per-workspace identity" wizard UI lands with I6.
    fixit: {
      kind: 'wizard',
      grantNote: 'Flip LOOM_WORKSPACE_IDENTITY_MODE to shadow first (provision + record only — zero behavior change), review the recorded workspaceIdentity status blocks, then phase enforce per I6/I9. The Console UAMI needs Managed Identity Contributor on the workspace-identity RG (ws-identity-rbac.bicep, deployed by the push-button bicep).',
    },
    autoResolveNote: 'Unset → mode off (the intended day-one default): every call runs as the shared Console UAMI, unchanged. Phased shadow → enforce is the sole Phase-0 exception to default-ON, per the operator decision recorded in the loom-next-level PRP.',
    legacyCodes: ['workspace_identity_not_configured'],
  },
};
