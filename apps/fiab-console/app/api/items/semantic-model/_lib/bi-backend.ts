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
import { resolveBiBackendMode } from '@/lib/admin/platform-settings';

export type BiBackend = 'aas' | 'powerbi';

/**
 * SYNC, env-only resolution (no Cosmos read). Retained for back-compat and for
 * any caller that cannot await. Prefer {@link biBackendAsync} on request paths
 * so the in-console RUNTIME toggle is honored.
 */
export function biBackend(): BiBackend {
  const v = (process.env.LOOM_BI_BACKEND || '').toLowerCase();
  if (v === 'powerbi') return 'powerbi';
  if (v === 'aas') return 'aas';
  return process.env.LOOM_AAS_SERVER_NAME ? 'aas' : 'powerbi';
}

export function usingAas(): boolean {
  return biBackend() === 'aas';
}

/**
 * ASYNC resolution honoring the RUNTIME admin toggle (Admin → Runtime config →
 * Power BI backend) with precedence: runtime setting > server env LOOM_BI_BACKEND
 * > default. When the effective mode is 'powerbi' the Power BI REST path is used;
 * otherwise the Azure-native semantic backend (Azure Analysis Services) is used
 * — the AAS config gate still names LOOM_AAS_SERVER_NAME if it is unset. This is
 * what lets an admin flip the BI backend with no rebuild / no env var.
 */
export async function biBackendAsync(): Promise<BiBackend> {
  const mode = await resolveBiBackendMode();
  return mode === 'powerbi' ? 'powerbi' : 'aas';
}

/** Async companion of {@link usingAas} that honors the runtime toggle. */
export async function usingAasAsync(): Promise<boolean> {
  return (await biBackendAsync()) === 'aas';
}
