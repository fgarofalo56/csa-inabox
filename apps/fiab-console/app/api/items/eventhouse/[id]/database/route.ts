/**
 * POST   /api/items/eventhouse/[id]/database
 *   Body: { name: string, hotCacheDays?: number, softDeleteDays?: number }
 *   Creates a new KQL database on the shared Loom Kusto cluster via ARM, and
 *   BINDS it to this eventhouse item.
 *
 * DELETE /api/items/eventhouse/[id]/database?name=<db>
 *   Deletes a KQL database via ARM (Microsoft.Kusto/clusters/databases) and
 *   unbinds it from this eventhouse item.
 *
 * SECURITY — GHSA-v2g8-gp3r-rg4r (same class, adjacent route). This route also
 * ran `getSession()` alone and never read `[id]`, so any signed-in user could
 * CREATE a database on the shared cluster, or DELETE one by naming it. The
 * caller is now authorized against the eventhouse item, WRITE-scoped on both
 * verbs, via the same `_lib/adx-item-scope.ts` guard the purge route uses.
 *
 * AUTO-BIND (.claude/rules/auto-bind-by-default.md). Creating a database here
 * used to record NOTHING in Loom — the database existed on the cluster with no
 * Loom item claiming it, which is precisely why the sibling `[id]/purge` route
 * had no item-derived scope to check a caller-supplied database against. The
 * created name is now written to the eventhouse item's `state.databases`, so the
 * database this item created is inside the scope `workspaceAdxScope` computes,
 * with no user binding step. Deleting it removes the binding again. The ARM call
 * is the source of truth: the state write is best-effort and never converts a
 * successful create/delete into a failure.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createDatabase, saveItemState, KustoError } from '@/lib/azure/kusto-client';
import {
  deleteKustoDatabase,
  KustoArmError,
  KustoNotConfiguredError,
} from '@/lib/azure/kusto-arm-client';
import { guardAdxItemRequest } from '../../../_lib/adx-item-scope';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DB_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_\-]{0,62}$/;
const EVENTHOUSE_NOT_FOUND = 'eventhouse not found';

/** The database names this eventhouse item already claims. */
function boundDatabases(item: WorkspaceItem): string[] {
  const raw = (item.state as Record<string, unknown> | undefined)?.databases;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => (typeof e === 'string' ? e : (e && typeof e === 'object' ? (e as any).name : '')))
    .filter((n: unknown): n is string => typeof n === 'string' && !!n.trim())
    .map((n) => n.trim());
}

/** Best-effort bind/unbind of a database name on the eventhouse item. */
async function rebind(item: WorkspaceItem, next: string[]): Promise<void> {
  try {
    await saveItemState(item as any, { databases: [...new Set(next)].sort() });
  } catch {
    /* the ARM operation already succeeded — a state-write blip is not a failure
       of the create/delete the caller asked for. The next open re-reads state. */
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await guardAdxItemRequest({
    itemId: id,
    itemType: 'eventhouse',
    notFound: EVENTHOUSE_NOT_FOUND,
  });
  if (guard.res) return guard.res;
  const { item } = guard.ctx;

  const body = await req.json().catch(() => ({}));
  const name = (body?.name || '').toString().trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  if (!DB_NAME_RE.test(name)) {
    return NextResponse.json({ ok: false, error: 'invalid database name' }, { status: 400 });
  }

  try {
    const result = await createDatabase(name, {
      hotCacheDays: Number(body?.hotCacheDays) || undefined,
      softDeleteDays: Number(body?.softDeleteDays) || undefined,
    });
    await rebind(item, [...boundDatabases(item), name]);
    return NextResponse.json({ ok: true, database: name, ...result });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await guardAdxItemRequest({
    itemId: id,
    itemType: 'eventhouse',
    notFound: EVENTHOUSE_NOT_FOUND,
  });
  if (guard.res) return guard.res;
  const { item } = guard.ctx;

  // DELETE bodies are non-standard; take the database name from the query string.
  const name = (new URL(req.url).searchParams.get('name') || '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name query param required' }, { status: 400 });
  if (!DB_NAME_RE.test(name)) {
    return NextResponse.json({ ok: false, error: 'invalid database name' }, { status: 400 });
  }

  try {
    const result = await deleteKustoDatabase(name);
    await rebind(item, boundDatabases(item).filter((n) => n !== name));
    return NextResponse.json({ ok: true, database: name, ...result });
  } catch (e: any) {
    if (e instanceof KustoNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, missing: e.missing }, { status: 503 });
    }
    const status = e instanceof KustoArmError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
