/**
 * GET /api/runtime-flags — the registered runtime kill-switch states for
 * CLIENT surfaces → { ok, flags: Record<flagId, boolean> }.
 *
 * FLAG0 read half for browser code (e.g. the /browse virtualization gate).
 * Session-gated read-only; no flag doc content beyond the boolean leaves the
 * server. Default-ON contract: an id with no doc — or a Cosmos hiccup — is
 * reported enabled, so a kill-switch outage can never gate a surface
 * (loom_default_on_opt_out). Reads ride the same short-TTL in-process cache
 * as the server-side `runtimeFlag()` hot path.
 */
import { getSession } from '@/lib/auth/session';
import { apiOk, apiUnauthorized } from '@/lib/api/respond';
import { RUNTIME_FLAGS, runtimeFlag } from '@/lib/admin/runtime-flags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const flags: Record<string, boolean> = {};
  // runtimeFlag() is individually fail-open (default-ON), so this loop can
  // never throw; each read is a cached single-partition point-read.
  for (const def of RUNTIME_FLAGS) {
    flags[def.id] = await runtimeFlag(def.id);
  }
  return apiOk({ flags });
}
