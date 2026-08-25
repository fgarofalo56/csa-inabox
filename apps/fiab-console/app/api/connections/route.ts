/**
 * GET    /api/connections            → list the caller's connections (no secrets)
 * POST   /api/connections            → create (secret → Key Vault, metadata → Cosmos)
 * DELETE /api/connections?id=<id>    → delete (+ best-effort KV secret delete)
 *
 * Loom Connections are reusable, Key Vault-backed data-source connections used
 * by mirroring, ADF/Synapse linked services, and datasets — so creds are entered
 * once and never stored in plaintext. Real KV write or an honest gate naming the
 * vault + role to grant (no-vaporware.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  listConnections, createConnection, deleteConnection, authNeedsSecret,
  type ConnectionType, type AuthMethod,
} from '@/lib/azure/connections-store';
// Derived from the exhaustive label Records — never a hand-listed duplicate,
// which is how Snowflake stayed un-creatable after it reached the union.
import { CONNECTION_TYPES, AUTH_METHODS } from '@/lib/azure/connectable-types';
import { apiError, apiServerError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TYPES: ConnectionType[] = CONNECTION_TYPES;
const METHODS: AuthMethod[] = AUTH_METHODS;


export const GET = withSession(async (_req, { session }) => {
  try {
    return NextResponse.json({ ok: true, connections: await listConnections(session) });
  } catch (e: any) {
    return apiServerError(e);
  }
});

export const POST = withSession(async (req: NextRequest, { session }) => {
  const body = await req.json().catch(() => ({} as any));
  const name = String(body?.name || '').trim();
  const type = body?.type as ConnectionType;
  const authMethod = body?.authMethod as AuthMethod;
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  if (!TYPES.includes(type)) return NextResponse.json({ ok: false, error: `type must be one of: ${TYPES.join(', ')}` }, { status: 400 });
  if (!METHODS.includes(authMethod)) return NextResponse.json({ ok: false, error: `authMethod must be one of: ${METHODS.join(', ')}` }, { status: 400 });
  if (authNeedsSecret(authMethod) && !body?.secret) {
    return NextResponse.json({ ok: false, error: `the "${authMethod}" auth method requires a secret` }, { status: 400 });
  }
  try {
    const conn = await createConnection(session, {
      name, type, authMethod,
      host: body?.host, database: body?.database, username: body?.username,
      spnTenantId: body?.spnTenantId, spnClientId: body?.spnClientId,
      // Snowflake (warehouse/role/schema), BigQuery (projectId) and Oracle
      // (serviceName/gateway) coordinates — all NON-SECRET, all persisted so the
      // ADF linked service can be built from the connection alone.
      warehouse: body?.warehouse, role: body?.role, schema: body?.schema,
      projectId: body?.projectId, serviceName: body?.serviceName, gateway: body?.gateway,
      description: body?.description, secret: body?.secret,

      armResourceId: body?.armResourceId, subscriptionId: body?.subscriptionId,
      resourceGroup: body?.resourceGroup, location: body?.location,
      origin: body?.origin === 'existing' ? 'existing' : undefined,
    });
    return NextResponse.json({ ok: true, connection: conn }, { status: 201 });
  } catch (e: any) {
    const status = e?.status || 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e), missing: e?.missing }, { status });
  }
});

export const DELETE = withSession(async (req: NextRequest, { session }) => {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  try {
    await deleteConnection(session, id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    // Referential-integrity gate: item(s) still bind this connection (409).
    if (e?.status === 409) return apiError(e.message, 409, { dependents: e.dependents });
    return apiServerError(e);
  }
});
