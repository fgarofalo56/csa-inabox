/**
 * R30 fragment — the 'enrichment' domain slice of GATE_META (formerly part of the
 * lib/gates/registry.ts monolith; entries sit in the same domain as their
 * ENV_CHECKS spec in lib/admin/env-checks/enrichment.ts). ./index.ts merges every
 * fragment into the same exported GATE_META shape (public API unchanged).
 * Import ONLY from './types' here — never './index' (barrel-cycle rule).
 */
import type { GateMeta } from './types';

export const ENRICHMENT_GATE_META: Record<string, GateMeta> = {
  'graph-users': {
    surfaces: [{ path: '/admin/users', label: 'Users & licenses (Graph enrichment)' }],
    fixit: { kind: 'role-grant', grantNote: 'Grant the Console UAMI Microsoft Graph Directory.Read.All (application) — a tenant-admin Graph consent, not an env write.' },
  },
  'graph-group-sync': {
    surfaces: [
      { path: '/admin/access-reviews', label: 'Access reviews — group-targeted packages' },
      { path: '/admin/access-packages', label: 'Access packages — Entra group targets' },
      { path: '/api/access-governance/group-sync', label: 'Group-sync reconcile' },
    ],
    fixit: { kind: 'role-grant', grantNote: 'Set LOOM_GRAPH_GROUP_SYNC_ENABLED=true and grant the Console UAMI Microsoft Graph Group.Read.All + GroupMember.Read.All (application, admin-consented). Read-only on Entra — Loom never mutates tenant groups.' },
    legacyCodes: ['graph_group_sync_not_configured'],
    autoResolveNote: 'Opt-in: unset → group-targeted packages are still requestable directly; only the automatic membership→grant reconcile is gated. Everything else in access-governance is day-one-ON.',
  },
  'svc-m365-link': {
    surfaces: [{ path: '/workspaces', label: 'Workspace ↔ M365 group link' }],
    fixit: { kind: 'role-grant', grantNote: 'Also grant the Console UAMI Graph Group.ReadWrite.All (application).' },
  },
  'svc-sharepoint-shortcuts': {
    surfaces: [{ path: '/items/lakehouse-shortcut', label: 'OneDrive / SharePoint shortcuts' }],
    fixit: { kind: 'role-grant', grantNote: 'Also grant the Console UAMI Graph Files.Read.All (application).' },
    legacyCodes: ['graph_drive_not_configured'],
  },
};
