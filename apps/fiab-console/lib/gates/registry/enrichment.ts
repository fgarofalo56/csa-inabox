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
      { path: '/admin/access-governance?tab=reviews', label: 'Access reviews — group-targeted packages' },
      { path: '/admin/access-governance?tab=packages', label: 'Access packages — Entra group targets' },
      { path: '/api/access-governance/group-sync', label: 'Group-sync reconcile' },
      { path: '/catalog/unity', label: 'Unity Catalog grants — "Effective for principal" group expansion (LU-4)' },
    ],
    fixit: { kind: 'role-grant', grantNote: 'Set LOOM_GRAPH_GROUP_SYNC_ENABLED=true and grant the Console UAMI Microsoft Graph Group.Read.All + GroupMember.Read.All (application, admin-consented). Read-only on Entra — Loom never mutates tenant groups.' },
    legacyCodes: ['graph_group_sync_not_configured'],
    autoResolveNote: 'Opt-in: unset → group-targeted packages are still requestable directly; only the automatic membership→grant reconcile is gated. Everything else in access-governance is day-one-ON.',
  },
  'identity-picker': {
    // Every surface that adopted the shared <IdentityPicker>. Listed in full
    // because the point of the registry is that an operator can see WHAT is
    // degraded, not merely that something is.
    surfaces: [
      { path: '/admin/policy-code', label: 'Policy statement — principal' },
      { path: '/admin/access-governance?tab=report', label: 'Access report — by principal' },
      { path: '/admin/access-governance?tab=reviews', label: 'Access reviews — campaign scope + leaver revoke-all' },
      { path: '/items/lakehouse', label: 'Lakehouse — Share + container RBAC grant' },
      { path: '/items/lakehouse?tab=security', label: 'OneLake security — data-access role members' },
      { path: '/items/semantic-model?tab=security', label: 'Semantic model — AAS role members' },
      { path: '/workspaces', label: 'Power BI workspace ACL — add principal' },
      { path: '/setup', label: 'Setup wizard — admin group + app registration' },
    ],
    fixit: {
      kind: 'role-grant',
      grantNote:
        'Set LOOM_IDENTITY_PICKER_ENABLED=true AND grant the Console UAMI Microsoft Graph User.Read.All + Group.Read.All + Application.Read.All (application) via scripts/csa-loom/grant-identity-graph-approles.sh, then have a Tenant Administrator grant admin consent. Both halves are required — the env alone leaves every Graph call returning 403.',
    },
    legacyCodes: ['not_configured'],
    autoResolveNote:
      'Degraded, never blocked: with this unset every adopting surface still works through the picker\'s validated manual object-id entry, which appears automatically once a search fails. Wiring the gate replaces typing an id with searching for a name.',
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
