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
 * SECURITY — the two halves of a probe (WHERE it connects and WHAT credential it
 * presents) must come from the SAME origin. This route used to take the secret
 * from a stored connection (`body.id` → its Key Vault `secretRef`) while taking
 * the destination from the request (`body.host`), so a caller could have the
 * Console resolve any connection it owned and present that password / connection
 * string to a TDS or HTTPS endpoint of its choosing. When the credential comes
 * from the store, EVERY probe coordinate now comes from the same stored record —
 * the request contributes nothing but the record id. A caller testing different
 * coordinates supplies its own secret, which is the pre-save case this route
 * exists for. See also POST /api/connections/[id]/test (always store-driven).
 *
 * Returns { ok:true, reachable, tableCount?, detail } or { ok:false, error, hint }.
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import {
  loadConnection, authNeedsSecret,
  type ConnectionType, type AuthMethod,
} from '@/lib/azure/connections-store';
import { getKeyVaultSecretValue } from '@/lib/azure/kv-secrets-client';
import { probeConnection } from '@/lib/azure/connection-probe';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TYPES: ConnectionType[] = ['azure-sql', 'synapse-dedicated', 'synapse-serverless', 'databricks-sql', 'postgres', 'storage-adls', 'cosmos', 'generic-sql', 'adx', 'event-hub', 'service-bus', 'key-vault'];
const METHODS: AuthMethod[] = ['entra-mi', 'sql-password', 'connection-string', 'account-key', 'service-principal'];

export const POST = withSession(async (req: NextRequest, { session }) => {

  const body = await req.json().catch(() => ({} as any));
  const type = body?.type as ConnectionType;
  const authMethod = body?.authMethod as AuthMethod;
  if (!TYPES.includes(type)) return apiError(`type must be one of: ${TYPES.join(', ')}`, 400);
  if (!METHODS.includes(authMethod)) return apiError(`authMethod must be one of: ${METHODS.join(', ')}`, 400);

  try {
    // The credential and the destination must share an origin (see the header
    // comment). Two mutually exclusive modes:
    //
    //   PRE-SAVE  — the caller supplied `secret`. Its own credential, its own
    //               coordinates: probe exactly what was typed.
    //   EDIT      — the secret field was left blank and `body.id` names a saved
    //               connection. The stored Key Vault secret is used, so every
    //               coordinate is read from that SAME stored record and the
    //               request's host/database/username/type are ignored.
    const typedSecret: string | undefined = body?.secret ? String(body.secret) : undefined;
    let probe: Parameters<typeof probeConnection>[0] = {
      type, authMethod,
      host: body?.host ? String(body.host) : undefined,
      database: body?.database ? String(body.database) : undefined,
      username: body?.username ? String(body.username) : undefined,
      secret: typedSecret,
    };
    let storedNote: string | undefined;

    if (!typedSecret && body?.id && authNeedsSecret(authMethod)) {
      const conn = await loadConnection(session.claims.oid, String(body.id));
      if (!conn) return apiError('connection not found', 404);
      if (conn.secretRef) {
        const secret = await getKeyVaultSecretValue(conn.secretRef, 'connection-secret');
        probe = {
          type: conn.type,
          authMethod: conn.authMethod,
          host: conn.host,
          database: conn.database,
          username: conn.username,
          secret,
        };
        const edited = (body?.host && String(body.host) !== (conn.host || ''))
          || (body?.database && String(body.database) !== (conn.database || ''))
          || (body?.username && String(body.username) !== (conn.username || ''))
          || (type !== conn.type) || (authMethod !== conn.authMethod);
        if (edited) {
          // Honest, not silent: say which coordinates were actually probed and
          // how to test the edited ones (no-vaporware.md).
          storedNote =
            `Tested the saved connection "${conn.name}" as stored (${conn.host || 'no host'}). The saved ` +
            'Key Vault credential is only ever presented to the coordinates it was saved with — re-enter ' +
            'the secret to test different ones.';
        }
      }
    }

    const result = await probeConnection(probe);

    if (!result.ok) return apiError(result.error, result.status, result.hint ? { hint: result.hint } : undefined);
    return apiOk({
      reachable: result.reachable,
      tableCount: result.tableCount,
      detail: result.detail,
      ...(storedNote ? { note: storedNote } : {}),
    });
  } catch (e) {
    return apiServerError(e);
  }
});
