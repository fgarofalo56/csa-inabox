/**
 * R30 fragment — the 'catalog-governance' domain slice of GATE_META (formerly part of the
 * lib/gates/registry.ts monolith; entries sit in the same domain as their
 * ENV_CHECKS spec in lib/admin/env-checks/catalog-governance.ts). ./index.ts merges every
 * fragment into the same exported GATE_META shape (public API unchanged).
 * Import ONLY from './types' here — never './index' (barrel-cycle rule).
 */
import { L, type GateMeta } from './types';

export const CATALOG_GOVERNANCE_GATE_META: Record<string, GateMeta> = {
  'svc-deploy-planner': {
    surfaces: [{ path: '/admin/deploy-planner', label: 'Deployment planner' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_COSMOS_ENDPOINT: L.cosmos },
  },
  'svc-org-visuals': {
    surfaces: [{ path: '/admin/org-visuals', label: 'Custom-visual uploads' }],
    fixit: { kind: 'env-picker' },
  },
  'svc-purview-uc': {
    surfaces: [{ path: '/governance/catalog', label: 'Unified catalog (Purview UC)' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_PURVIEW_UC_ENDPOINT: L.purview },
  },
};
