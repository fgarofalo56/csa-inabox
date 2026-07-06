/**
 * POST /api/connections/test
 *
 * Pre-save connection test for the ConnectionBuilder dialog: probe the values
 * the user is entering BEFORE they are persisted (Azure/Fabric "Test connection"
 * UX). Reuses the shared, credential-aware {@link probeConnection} — a REAL
 * per-type Azure round-trip (TDS / Kusto / ADLS / HTTPS reachability), never a
 * fabricated success (no-vaporware.md).
 *
 * Body: { type, authMethod, host?, database?, username?, secret?, id? }
 *   • secret is the plaintext just typed (create OR rotate) — used for the probe,
 *     never persisted here.
 *   • id (optional, edit mode): when the secret field is left blank the stored
 *     Key Vault secret is resolved for the probe, so "Test" works on an existing
 *     connection without re-typing the secret.
 *
 * Returns { ok:true, reachable, tableCount?, detail } or { ok:false, error, hint }.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import {
  loadConnection, authNeedsSecret,
  type ConnectionType, type AuthMethod,
} from '@/lib/azure/connections-store';
import { getKeyVaultSecretValue } from '@/lib/azure/kv-secrets-client';
import { probeConnection } from '@/lib/azure/connection-probe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TYPES: ConnectionType[] = ['azure-sql', 'synapse-dedicated', 'synapse-serverless', 'databricks-sql', 'postgres', 'storage-adls', 'cosmos', 'generic-sql', 'adx', 'event-hub', 'service-bus', 'key-vault'];
const METHODS: AuthMethod[] = ['entra-mi', 'sql-password', 'connection-string', 'account-key', 'service-principal'];

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const body = await req.json().catch(() => ({} as any));
  const type = body?.type as ConnectionType;
  const authMethod = body?.authMethod as AuthMethod;
  if (!TYPES.includes(type)) return apiError(`type must be one of: ${TYPES.join(', ')}`, 400);
  if (!METHODS.includes(authMethod)) return apiError(`authMethod must be one of: ${METHODS.join(', ')}`, 400);

  try {
    // Resolve the secret to probe with: prefer the one just typed; otherwise, in
    // edit mode (id present) fall back to the stored Key Vault secret so "Test"
    // works without re-entering it.
    let secret: string | undefined = body?.secret ? String(body.secret) : undefined;
    if (!secret && body?.id && authNeedsSecret(authMethod)) {
      const conn = await loadConnection(session.claims.oid, String(body.id));
      if (conn?.secretRef) secret = await getKeyVaultSecretValue(conn.secretRef);
    }

    const result = await probeConnection({
      type, authMethod,
      host: body?.host ? String(body.host) : undefined,
      database: body?.database ? String(body.database) : undefined,
      username: body?.username ? String(body.username) : undefined,
      secret,
    });

    if (!result.ok) return apiError(result.error, result.status, result.hint ? { hint: result.hint } : undefined);
    return apiOk({ reachable: result.reachable, tableCount: result.tableCount, detail: result.detail });
  } catch (e) {
    return apiServerError(e);
  }
}
