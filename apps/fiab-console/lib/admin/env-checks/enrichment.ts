/**
 * R30 fragment — the 'enrichment' domain slice of ENV_CHECKS (formerly part of the
 * lib/admin/env-checks.ts monolith). An env-adding item edits ONLY its own
 * domain fragment; ./index.ts merges every fragment into the same exported
 * ENV_CHECKS array (public API unchanged). Import ONLY from './core' here —
 * never './index' (barrel-cycle rule, WS-E1 gotcha).
 */
import type { EnvSpec } from './core';

export const ENRICHMENT_ENV_CHECKS: EnvSpec[] = [
  // ── enrichment ──
  {
    id: 'graph-users', category: 'enrichment', title: 'Microsoft Graph user enrichment', severity: 'optional',
    required: ['LOOM_GRAPH_USERS_ENABLED'], warnOnMiss: true,
    remediation: 'Set LOOM_GRAPH_USERS_ENABLED=true and grant the Console UAMI Directory.Read.All in Microsoft Graph to enrich the Users page with display name + department. Without it the page still shows UPN + activity + roles from Cosmos.',
    docs: 'https://learn.microsoft.com/graph/permissions-reference#directoryreadall',
    provisionedBy: 'modules/admin-plane/main.bicep (apps[] env) + post-deploy Graph grant',
    role: 'Microsoft Graph Directory.Read.All (application) granted to the Console UAMI',
  },
  {
    id: 'graph-group-sync', category: 'enrichment', title: 'Entra group sync (access-package group targets)', severity: 'optional',
    required: ['LOOM_GRAPH_GROUP_SYNC_ENABLED'], warnOnMiss: true, optionalDefault: true,
    remediation: 'Set LOOM_GRAPH_GROUP_SYNC_ENABLED=true and grant the Console UAMI Microsoft Graph Group.Read.All + GroupMember.Read.All (application, admin-consented) via scripts/csa-loom/grant-identity-graph-approles.sh to auto-reconcile Entra group-targeted access packages (member joins→grant, leaves→revoke). This is READ-ONLY on Entra — Loom never mutates tenant group membership. Without it, group-targeted packages still install and are requestable directly; only the automatic membership reconcile is gated. Everything else in access-governance is day-one-ON.',
    docs: 'https://learn.microsoft.com/entra/id-governance/entitlement-management-scenarios',
    provisionedBy: 'platform/fiab/bicep/modules/admin-plane/identity-graph-rbac.bicep (loomIdentityPickerEnabled) → apps[] env + post-deploy Graph grant',
    role: 'Microsoft Graph Group.Read.All + GroupMember.Read.All (application) granted to the Console UAMI',
  },
  {
    id: 'svc-m365-link', category: 'enrichment', title: 'Workspace ↔ Microsoft 365 group link', severity: 'optional',
    required: ['LOOM_WORKSPACE_M365_LINK'], warnOnMiss: true,
    remediation: 'Set LOOM_WORKSPACE_M365_LINK=true and grant the Console UAMI Graph Group.ReadWrite.All so workspaces can bind to an M365 group for membership sync. Loom-native workspace roles work without it.',
    provisionedBy: 'modules/admin-plane/main.bicep (apps[] env) + post-deploy Graph grant',
    role: 'Microsoft Graph Group.ReadWrite.All (application) on the Console UAMI',
  },
  {
    id: 'svc-sharepoint-shortcuts', category: 'enrichment', title: 'OneDrive / SharePoint shortcuts', severity: 'optional',
    required: ['LOOM_SHAREPOINT_SHORTCUTS_ENABLED'], warnOnMiss: true,
    remediation: 'Set LOOM_SHAREPOINT_SHORTCUTS_ENABLED=true and grant the Console UAMI the Graph Files.Read.All app role so lakehouse shortcuts can browse OneDrive/SharePoint drives (graph_drive_not_configured). ADLS/S3 shortcuts work without it.',
    provisionedBy: 'modules/admin-plane/main.bicep (apps[] env) + post-deploy Graph grant',
    role: 'Microsoft Graph Files.Read.All (application) on the Console UAMI',
  },
];
