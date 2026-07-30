/**
 * POST /api/connections/[id]/test
 *
 * Credential-aware reachability probe for a SAVED Loom Connection. Loads the
 * stored connection, resolves its Key Vault secret when the auth method needs
 * one, then delegates to the shared {@link probeConnection} — the same REAL
 * per-type Azure round-trip used by the pre-save POST /api/connections/test
 * (TDS / Kusto / ADLS / HTTPS reachability; no fabricated success).
 *
 * Returns { ok, reachable, tableCount?, detail } or { ok:false, error, hint }.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { loadConnection, authNeedsSecret } from '@/lib/azure/connections-store';
import { getKeyVaultSecretValue } from '@/lib/azure/kv-secrets-client';
import { probeConnection } from '@/lib/azure/connection-probe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  try {
    const conn = await loadConnection(session.claims.oid, params.id);
    if (!conn) return apiError('connection not found', 404);

    // Resolve the stored KV secret only when the auth method requires one.
    let secret: string | undefined;
    if (authNeedsSecret(conn.authMethod) && conn.secretRef) {
      secret = await getKeyVaultSecretValue(conn.secretRef);
    }

    const result = await probeConnection({
      type: conn.type,
      authMethod: conn.authMethod,
      host: conn.host,
      database: conn.database,
      username: conn.username,
      secret,
    });

    if (!result.ok) return apiError(result.error, result.status, result.hint ? { hint: result.hint } : undefined);
    return apiOk({ reachable: result.reachable, tableCount: result.tableCount, detail: result.detail });
  } catch (e) {
    return apiServerError(e);
  }
}
