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
               { path: '/catalog', label: 'Unified Catalog → Lineage' },
               // #2625 — the two run surfaces that receive a LU-8 harvest
               // receipt and now RENDER it (LineageHarvestBar). The Spark one
               // carries the inline Fix-it that declares the job's datasets;
               // the pipeline one is informational (a pipeline's lineage comes
               // from its Copy activities' datasets, edited on the canvas).
               { path: '/items/spark-job-definition', label: 'Spark job definition → Runs (lineage receipt + Fix it)' },
               { path: '/items/data-pipeline', label: 'Data pipeline → Output (lineage receipt)' }],
    fixit: {
      kind: 'wizard',   // wizard: mint token + run the pool-setup script
      grantNote: 'One-time pool config: scripts/csa-loom/openlineage-pool-setup.sh mints the per-pool credential, uploads the openlineage-spark jar as a Synapse workspace library, and sets spark.extraListeners + the http transport on the pool. Rotation = re-run the script (docs/fiab/runbooks/openlineage-spark-lineage.md). Dataset-level (not column-level) Spark lineage needs NO listener: declare the job\'s inputs/outputs from the Runs tab\'s "Fix it" wizard.',
    },
    // `spark_lineage_not_declared` is the HarvestReceipt.code the Spark run
    // route returns when a succeeded batch declared no dataset pair — the one
    // harvest outcome an operator can actually resolve, so Copilot resolves it
    // through this gate. See lib/lineage/synapse-lineage-harvest.ts.
    legacyCodes: ['openlineage_not_configured', 'spark_lineage_not_declared'],
  },
};
