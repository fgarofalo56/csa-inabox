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
    surfaces: [{ path: '/admin/*', label: 'Admin portal (first-admin bootstrap)' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['admin_only'],
  },
};
