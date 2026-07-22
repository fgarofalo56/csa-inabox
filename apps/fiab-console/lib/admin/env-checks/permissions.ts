/**
 * R30 fragment — the 'permissions' domain slice of ENV_CHECKS (formerly part of the
 * lib/admin/env-checks.ts monolith). An env-adding item edits ONLY its own
 * domain fragment; ./index.ts merges every fragment into the same exported
 * ENV_CHECKS array (public API unchanged). Import ONLY from './core' here —
 * never './index' (barrel-cycle rule, WS-E1 gotcha).
 */
import type { EnvSpec } from './core';

export const PERMISSIONS_ENV_CHECKS: EnvSpec[] = [
  {
    id: 'domain-routing', category: 'permissions', title: 'Domain-aware item-create routing (multi-sub)', severity: 'recommended',
    // LOOM_SUBSCRIPTION_ID is the admin (DMLZ) sub + single-sub default; domain
    // DLZ subscriptions live in the Cosmos governance-domain registry
    // (domain.subscriptionIds), NOT in env — so this check verifies only the
    // single-sub default is wired. In multi-sub mode the Console UAMI also needs
    // Contributor on each domain DLZ RG (rg-csa-loom-dlz-{domain}-{location});
    // that grant is wired by the dlzItemCreateRbac loop and surfaced as an honest
    // gate by topology.ts when missing.
    required: ['LOOM_SUBSCRIPTION_ID'],
    warnOnMiss: true,
    remediation: 'Domain-scoped item-creates (lakehouse/warehouse/eventhouse/notebook/mirroring) route to the owning domain\'s DLZ subscription (governance-domain registry → domain.subscriptionIds[0]) via lib/azure/topology.ts → resolveDeployTarget; shared/tenant items (catalog/marketplace/governance) stay in the admin plane. For multi-sub, set each domain\'s subscriptionIds in the Domains admin UI and ensure the Console UAMI has Contributor on rg-csa-loom-dlz-{domain}-{location} in that sub (deployed by modules/admin-plane/dlz-attach-itemcreate-rbac.bicep). Single-sub deployments need no extra config — routing falls back to LOOM_SUBSCRIPTION_ID + LOOM_DLZ_RG.',
    provisionedBy: 'modules/admin-plane/dlz-attach-itemcreate-rbac.bicep (dlzItemCreateRbac loop in main.bicep, multi-sub mode)',
    role: 'Contributor (b24988ac-…) on each domain DLZ resource group (Console UAMI)',
  },
  // ── permissions ──
  {
    id: 'bootstrap-admin', category: 'permissions', title: 'Bootstrap tenant admin', severity: 'critical',
    anyOf: [['LOOM_TENANT_ADMIN_OID', 'LOOM_TENANT_ADMIN_GROUP_ID']],
    remediation: 'Set LOOM_TENANT_ADMIN_OID to your Entra user OID (or LOOM_TENANT_ADMIN_GROUP_ID to a group you are in) — deploy params loomTenantAdminOid / loomTenantAdminGroupId. Members bypass the feature-permission gate with full Admin; this is how the first admin gets in before any grants exist and fixes the "Access denied (403)" on /admin/permissions.',
    docs: '/admin/permissions',
    provisionedBy: 'main.bicep (params loomTenantAdminOid / loomTenantAdminGroupId) → admin-plane apps[] env',
  },
];
