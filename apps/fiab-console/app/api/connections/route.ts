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
import { getSession } from '@/lib/auth/session';
import {
  listConnections, createConnection, deleteConnection, authNeedsSecret,
  type ConnectionType, type AuthMethod,
} from '@/lib/azure/connections-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TYPES: ConnectionType[] = ['azure-sql', 'synapse-dedicated', 'synapse-serverless', 'databricks-sql', 'postgres', 'storage-adls', 'cosmos', 'generic-sql', 'bigquery', 'oracle'];
const METHODS: AuthMethod[] = ['entra-mi', 'sql-password', 'connection-string', 'account-key', 'service-principal', 'service-account-key'];

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, connections: await listConnections(session) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
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
      projectId: body?.projectId, serviceAccountEmail: body?.serviceAccountEmail, gateway: body?.gateway,
      description: body?.description, secret: body?.secret,
    });
    return NextResponse.json({ ok: true, connection: conn }, { status: 201 });
  } catch (e: any) {
    const status = e?.status || 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e), missing: e?.missing }, { status });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  try {
    await deleteConnection(session, id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
