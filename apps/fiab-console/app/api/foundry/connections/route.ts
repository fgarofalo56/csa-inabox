/**
 * Foundry hub connections — full CRUD (AIF-9).
 *   GET    /api/foundry/connections            → list
 *   POST   /api/foundry/connections            → create (typed body)
 *   PATCH  /api/foundry/connections            → edit (create-or-update PUT; 404-guarded)
 *   DELETE /api/foundry/connections?name=<n>   → delete
 *
 * Create/edit/delete write against the workspace connections REST via the Console
 * UAMI. Secrets are never accepted raw — key-based connections must reference a
 * Key Vault secret identifier (buildConnectionBody rejects a raw secret).
 */
import { NextResponse } from 'next/server';
import { listConnections, FoundryError } from '@/lib/azure/foundry-client';
import { PagingDeadlineError, type PagingTruncation } from '@/lib/azure/paging-budget';
import { FetchTimeoutError } from '@/lib/azure/fetch-with-timeout';
import {
  createConnection,
  updateConnection,
  deleteConnection,
  RawSecretRejectedError,
  type ConnectionCategory,
  type ConnectionAuthMode,
} from '@/lib/azure/foundry-connections-client';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (req: Request) => {
  try {
    // The client memoizes this near-static ARM list for 5 min (#2557 — it sits
    // on the AOAI target-resolution hot path). Loom's own writes invalidate it;
    // `?refresh=1` is the escape hatch for a change made outside Loom.
    const force = new URL(req.url).searchParams.get('refresh') === '1';
    // Truncation is REPORTED, never hidden: "the walk ran out of wall clock" is
    // not the same as "the hub has fewer connections", and a caller that can't
    // tell them apart draws the wrong conclusion.
    const truncations: PagingTruncation[] = [];
    const connections = await listConnections({
      force,
      onTruncated: (t) => { truncations.push(t); },
    });
    return NextResponse.json({ ok: true, connections, truncated: truncations[0] });
  } catch (e: any) {
    if (e instanceof PagingDeadlineError || e instanceof FetchTimeoutError) {
      // A deadline is a deadline. 504, and the message says outright that
      // nothing is missing — do not let this read as "no connections exist".
      return NextResponse.json(
        { ok: false, code: 'paging_deadline', error: e.message },
        { status: 504 },
      );
    }
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
});

export const POST = withSession(async (req: Request) => {
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
});

export const PATCH = withSession(async (req: Request) => {
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
    const connection = await updateConnection({
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
});

export const DELETE = withSession(async (req: Request) => {
  const name = new URL(req.url).searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name query param is required' }, { status: 400 });
  try {
    await deleteConnection(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
});
