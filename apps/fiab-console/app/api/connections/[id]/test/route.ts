/**
 * POST /api/connections/[id]/test
 *
 * Credential-aware reachability probe for a saved Loom Connection.
 *
 * SQL-family types (azure-sql, synapse-dedicated, synapse-serverless,
 * databricks-sql, generic-sql, postgres): resolve the stored KV secret and
 * do a REAL probe via listTablesWithAuth against the connection's host+database.
 * Returns { ok, reachable, tableCount?, detail }.
 *
 * Non-SQL types (storage-adls, event-hub, service-bus, key-vault, cosmos):
 * validated only at first use (no universal pre-flight TDS ping possible);
 * returns an honest { ok:true, reachable:false, detail:"validated on first use…" }.
 *
 * Auth/login failures return { ok:false, error, hint }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadConnection } from '@/lib/azure/connections-store';
import { getKeyVaultSecretValue } from '@/lib/azure/kv-secrets-client';
import { listTablesWithAuth } from '@/lib/azure/sql-objects-client';
import type { SqlExplicitAuth } from '@/lib/azure/azure-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Connection types that support a pre-flight TDS reachability test. */
const SQL_TESTABLE = new Set([
  'azure-sql', 'synapse-dedicated', 'synapse-serverless',
  'databricks-sql', 'generic-sql', 'postgres',
]);

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    const conn = await loadConnection(session.claims.oid, params.id);
    if (!conn) return NextResponse.json({ ok: false, error: 'connection not found' }, { status: 404 });

    // Non-SQL types: honest "validated on first use" gate (no fake success).
    if (!SQL_TESTABLE.has(conn.type)) {
      return NextResponse.json({
        ok: true,
        reachable: false,
        detail: `${conn.type} connections are validated on first use — credentials are stored in Key Vault and checked when the connection is bound to an item.`,
      });
    }

    // SQL-family types: must have a host.
    if (!conn.host) {
      return NextResponse.json({
        ok: false,
        error: 'connection has no host/server configured',
        hint: 'Edit the connection and add the server FQDN.',
      }, { status: 400 });
    }

    // Resolve auth for the probe.
    let auth: SqlExplicitAuth | undefined;

    if (conn.authMethod === 'sql-password') {
      // Resolve the stored password from Key Vault.
      if (!conn.secretRef) {
        return NextResponse.json({
          ok: false,
          error: 'connection is configured for SQL password auth but has no stored secret',
          hint: 'Edit the connection and supply the password to store it in Key Vault.',
        }, { status: 400 });
      }
      const password = await getKeyVaultSecretValue(conn.secretRef);
      if (!conn.username) {
        return NextResponse.json({
          ok: false,
          error: 'connection is configured for SQL password auth but has no username',
          hint: 'Edit the connection and add the username.',
        }, { status: 400 });
      }
      auth = { user: conn.username, password };
    } else if (conn.authMethod === 'connection-string') {
      if (!conn.secretRef) {
        return NextResponse.json({
          ok: false,
          error: 'connection has no stored connection string',
          hint: 'Edit the connection and supply the connection string to store it in Key Vault.',
        }, { status: 400 });
      }
      const connectionString = await getKeyVaultSecretValue(conn.secretRef);
      auth = { connectionString };
    } else if (conn.authMethod === 'entra-mi') {
      // No auth object — will use the UAMI AAD-token path.
      auth = undefined;
    } else {
      // service-principal / account-key: not directly usable as TDS auth.
      return NextResponse.json({
        ok: true,
        reachable: false,
        detail: `The "${conn.authMethod}" auth method is validated at item-bind time, not via a standalone TDS probe.`,
      });
    }

    // Run the real TDS probe via listTablesWithAuth (catalog SELECT — read-only).
    const tables = await listTablesWithAuth(conn.host, conn.database || 'master', auth);
    return NextResponse.json({
      ok: true,
      reachable: true,
      tableCount: tables.length,
      detail: `Connected successfully. ${tables.length} table${tables.length !== 1 ? 's' : ''} visible in ${conn.database || 'master'}.`,
    });
  } catch (e: any) {
    const msg: string = e?.message || String(e);
    // Classify common TDS auth failures for actionable hints.
    let hint: string | undefined;
    if (/login failed|cannot open.*database|token-identified principal/i.test(msg)) {
      hint = 'Verify the username, password, and that the principal has been granted database access on the target server.';
    } else if (/connection.*refused|could not connect|timeout/i.test(msg)) {
      hint = 'The server may be behind a firewall. Ensure the Console UAMI\'s outbound IP is in the server\'s firewall allowlist.';
    } else if (/ssl|certificate/i.test(msg)) {
      hint = 'TLS handshake failed. Check that the server\'s certificate is valid and the server accepts encrypted connections.';
    }
    return NextResponse.json({ ok: false, error: msg, ...(hint ? { hint } : {}) }, { status: 502 });
  }
}
