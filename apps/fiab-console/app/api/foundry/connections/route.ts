/**
 * Foundry hub connections — full CRUD (AIF-9).
 *   GET    /api/foundry/connections            → list
 *   POST   /api/foundry/connections            → create (typed body)
 *   DELETE /api/foundry/connections?name=<n>   → delete
 *
 * Create/delete write against the workspace connections REST via the Console
 * UAMI. Secrets are never accepted raw — key-based connections must reference a
 * Key Vault secret identifier (buildConnectionBody rejects a raw secret).
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listConnections, FoundryError } from '@/lib/azure/foundry-client';
import {
  createConnection,
  deleteConnection,
  RawSecretRejectedError,
  type ConnectionCategory,
  type ConnectionAuthMode,
} from '@/lib/azure/foundry-connections-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const connections = await listConnections();
    return NextResponse.json({ ok: true, connections });
  } catch (e: any) {
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}

export async function POST(req: Request) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }
  const name = String(payload?.name || '').trim();
  const category = payload?.category as ConnectionCategory;
  const target = String(payload?.target || '').trim();
  const authMode = (payload?.authMode as ConnectionAuthMode) || 'AAD';
  if (!name || !category || !target) {
    return NextResponse.json(
      { ok: false, error: 'name, category, and target are required' },
      { status: 400 },
    );
  }
  try {
    const connection = await createConnection({
      name,
      category,
      target,
      authMode,
      keyVaultSecretUri: payload?.keyVaultSecretUri,
      customKeyVaultRefs: payload?.customKeyVaultRefs,
      isSharedToAll: payload?.isSharedToAll,
      metadata: payload?.metadata,
    });
    return NextResponse.json({ ok: true, connection });
  } catch (e: any) {
    if (e instanceof RawSecretRejectedError) {
      return NextResponse.json({ ok: false, error: e.message, code: e.code }, { status: 400 });
    }
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}

export async function DELETE(req: Request) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const name = new URL(req.url).searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name query param is required' }, { status: 400 });
  try {
    await deleteConnection(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
