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
  // L2 — Spark OpenLineage column-lineage feed. The Fix-it is a WIZARD (not a
  // bare env write): mint the per-pool credential (Entra app / per-workspace
  // token), run openlineage-pool-setup.sh (uploads the listener jar as a
  // workspace library — required on DEP workspaces — and stamps the Spark
  // conf), then register the credential→workspace binding on the console.
  'svc-openlineage': {
    surfaces: [{ path: '/items/lakehouse', label: 'Lakehouse lineage tab' },
               { path: '/catalog', label: 'Unified Catalog → Lineage' }],
    fixit: {
      kind: 'wizard',   // wizard: mint token + run the pool-setup script
      grantNote: 'One-time pool config: scripts/csa-loom/openlineage-pool-setup.sh mints the per-pool credential, uploads the openlineage-spark jar as a Synapse workspace library, and sets spark.extraListeners + the http transport on the pool. Rotation = re-run the script (docs/fiab/runbooks/openlineage-spark-lineage.md).',
    },
    legacyCodes: ['openlineage_not_configured'],
  },
};
