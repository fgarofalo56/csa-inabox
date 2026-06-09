/**
 * BI backend selector for the semantic-model BFF routes.
 *
 * Per no-fabric-dependency.md the Azure-native backend (Azure Analysis
 * Services) is the DEFAULT; Power BI / Fabric is strictly opt-in. The split:
 *
 *   LOOM_BI_BACKEND=powerbi  → Power BI REST (opt-in)
 *   LOOM_BI_BACKEND=aas      → Azure Analysis Services (explicit)
 *   unset:
 *     - AAS when LOOM_AAS_SERVER_NAME is configured (Azure-native default)
 *     - otherwise Power BI (legacy behaviour for deployments without an AAS
 *       server, so this change never regresses an existing console)
 *
 * This keeps powerbi-client behind LOOM_BI_BACKEND=powerbi (or the no-AAS
 * legacy fallback) while making AAS the default everywhere an AAS server is
 * deployed — with an honest MessageBar gate when AAS is selected but
 * LOOM_AAS_SERVER_NAME is unset.
 */
export type BiBackend = 'aas' | 'powerbi';

export function biBackend(): BiBackend {
  const v = (process.env.LOOM_BI_BACKEND || '').toLowerCase();
  if (v === 'powerbi') return 'powerbi';
  if (v === 'aas') return 'aas';
  return process.env.LOOM_AAS_SERVER_NAME ? 'aas' : 'powerbi';
}

export function usingAas(): boolean {
  return biBackend() === 'aas';
}
