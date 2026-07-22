/**
 * R30 fragment — the 'security' domain slice of GATE_META (formerly part of the
 * lib/gates/registry.ts monolith; entries sit in the same domain as their
 * ENV_CHECKS spec in lib/admin/env-checks/security.ts). ./index.ts merges every
 * fragment into the same exported GATE_META shape (public API unchanged).
 * Import ONLY from './types' here — never './index' (barrel-cycle rule).
 */
import { L, type GateMeta } from './types';

export const SECURITY_GATE_META: Record<string, GateMeta> = {
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
    surfaces: [{ path: '/workspaces', label: 'Workspace identity creation' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['workspace_identity_not_configured'],
  },
};
