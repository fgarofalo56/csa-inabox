/**
 * R30 fragment — the 'data-plane' domain slice of GATE_META (formerly part of the
 * lib/gates/registry.ts monolith; entries sit in the same domain as their
 * ENV_CHECKS spec in lib/admin/env-checks/data-plane.ts). ./index.ts merges every
 * fragment into the same exported GATE_META shape (public API unchanged).
 * Import ONLY from './types' here — never './index' (barrel-cycle rule).
 */
import { L, type GateMeta } from './types';

export const DATA_PLANE_GATE_META: Record<string, GateMeta> = {
  'cosmos-config': {
    surfaces: [{ path: '*', label: 'The Loom store (workspaces, items, grants, config)' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_COSMOS_ENDPOINT: L.cosmos },
  },
  subscription: {
    surfaces: [
      { path: '/admin/capacity', label: 'ARM discovery + capacity' },
      { path: '/admin/scaling', label: 'Scale by SKU' },
      { path: '/api/azure/*', label: 'Azure navigators' },
    ],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['LOOM_SUBSCRIPTION_ID not configured', 'LOOM_SUBSCRIPTION_ID not set'],
  },
  // ── Hyperscale band (optional substrates; unset = fully-functional default) ──
  'svc-loom-onelake': {
    surfaces: [{ path: '/onelake', label: 'OneLake namespace service (scale-out)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Unset → the per-item library path (adls-client / lakehouse-shortcuts) serves everything with no loss of function.',
  },
  'svc-loom-directlake': {
    surfaces: [{ path: '/items/semantic-model', label: 'Direct Lake columnar cache (scale-out)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Unset → the AAS fast-path or Synapse-Serverless cold path serves DAX-class queries unchanged.',
  },
  'perf-spark-warm-pool-store': {
    surfaces: [{ path: '/items/notebook', label: 'Warm Spark pool — cross-replica leases' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Unset → the warm pool runs per-replica (still fully functional, just not shared).',
  },
  'svc-cosmos-control': {
    surfaces: [
      { path: '/admin/scaling', label: 'Cosmos account scaling' },
      { path: '/items/*', label: 'Item version restore' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_COSMOS_ACCOUNT: L.cosmosAccountName },
    legacyCodes: ['cosmos_not_configured'],
  },
  'svc-medallion-layers': {
    surfaces: [
      { path: '/onelake', label: 'OneLake paths (silver/gold)' },
      { path: '/items/semantic-model', label: 'Direct Lake (gold layer)' },
    ],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['gold_url_not_configured', 'mirror_not_configured'],
  },
  'svc-redis-result-cache': {
    surfaces: [{ path: '/items/kql-database', label: 'Query result cache (scale-out)' }],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Unset → the built-in per-replica in-memory result cache serves everything with zero loss of function.',
  },
};
