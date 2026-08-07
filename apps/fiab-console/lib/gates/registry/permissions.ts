/**
 * R30 fragment — the 'permissions' domain slice of GATE_META (formerly part of the
 * lib/gates/registry.ts monolith; entries sit in the same domain as their
 * ENV_CHECKS spec in lib/admin/env-checks/permissions.ts). ./index.ts merges every
 * fragment into the same exported GATE_META shape (public API unchanged).
 * Import ONLY from './types' here — never './index' (barrel-cycle rule).
 */
import type { GateMeta } from './types';

export const PERMISSIONS_GATE_META: Record<string, GateMeta> = {
  'domain-routing': {
    surfaces: [{ path: '/admin/domains', label: 'Domain-scoped item-create routing' }],
    fixit: { kind: 'role-grant', grantNote: 'Multi-sub only: set each domain\'s subscriptionIds in Admin → Domains and grant the Console UAMI Contributor on each domain DLZ RG.' },
  },
  'bootstrap-admin': {
    surfaces: [
      { path: '/admin/*', label: 'Admin portal (first-admin bootstrap)' },
      { path: '/admin/access-requests', label: 'Sign-in onboarding queue' },
    ],
    // env-picker, but with an HONEST caveat recorded here because the Fix-it is
    // NOT self-serve for the person who normally sees this gate: applying it
    // goes through POST /api/admin/gates/[id]/resolve, which itself enforces
    // admin.env-config at Admin. A locked-out tenant therefore cannot unlock
    // itself in-product, and that is precisely why auto-bind-by-default.md §5
    // requires the DEPLOY to produce this binding. The deploy lanes now pass
    // loomTenantAdminGroupId unconditionally (asserted by
    // scripts/ci/check-tenant-admin-binding.mjs), so a correctly-deployed
    // estate never reaches this gate; the Fix-it remains for an ALREADY-admin
    // operator repointing the estate at a different group.
    fixit: { kind: 'env-picker' },
    legacyCodes: ['admin_only'],
  },
};
