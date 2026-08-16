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
 * SECURITY — GHSA-v2g8-gp3r-rg4r (same class, adjacent route). This route ran
 * `getSession()` alone and never read `[id]`, so any signed-in user could CREATE
 * a database on the shared cluster, or DELETE one by naming it.
 *
 * BOTH LAYERS, on BOTH verbs. Layer 1 alone was the first attempt at this fix
 * and it was NOT enough: creating an eventhouse item is self-service, so an
 * authorized-for-their-own-item caller could still name any database on the
 * shared cluster. DELETE is the most destructive verb in this advisory's whole
 * surface — strictly worse than the `.purge` the sibling route binds — so it
 * gets the same `scopeAdxDatabase` binding purge does.
 *
 * AUTO-BIND, AND WHY IT IS NOT A SCOPE-INJECTION PRIMITIVE
 * (.claude/rules/auto-bind-by-default.md). Creating a database here used to
 * record NOTHING in Loom, which is precisely why `[id]/purge` had no
 * item-derived scope to check a caller-supplied database against. The created
 * name is now written to the eventhouse item's `state.databases`, so
 * `workspaceAdxScope` admits it with no user binding step.
 *
 * That binding is the dangerous half if it is naive, and the first version of it
 * WAS. `createDatabase` is an ARM **PUT — Create *Or Update***: naming an
 * existing database succeeds (silently rewriting its retention and hot-cache
 * windows) instead of conflicting. Binding unconditionally therefore let a
 * caller POST `{name: "<victim-db>"}`, land it in their own item's
 * `state.databases`, and thereby widen `workspaceAdxScope` for that item AND
 * every ADX-backed sibling in the workspace — which re-admits the exact
 * `.purge` and cross-database `.set-or-append` this advisory closes.
 *
 * Two independent stops, both required:
 *   1. PRE-FLIGHT — a name that ALREADY EXISTS on the cluster and is NOT already
 *      in this item's scope is refused 409 BEFORE the ARM PUT, so the
 *      retention/hot-cache overwrite never happens either. Fails closed when the
 *      database list cannot be read: an unverifiable name is not a creatable one.
 *   2. BIND ONLY ON A REAL CREATE — ARM 201, not 200. This is the backstop for
 *      the race between the pre-flight list and the PUT; a 200 means it already
 *      existed, so nothing is bound and the response says so.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createDatabase, listDatabases, saveItemState, KustoError } from '@/lib/azure/kusto-client';
import {
  deleteKustoDatabase,
  KustoArmError,
  KustoNotConfiguredError,
} from '@/lib/azure/kusto-arm-client';
import { guardAdxItemRequest, scopeAdxDatabase, workspaceAdxScope } from '../../../_lib/adx-item-scope';
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

  // STOP 1 — refuse a name that already exists and is not already ours, BEFORE
  // the ARM PUT, so the Create-Or-Update never rewrites another workspace's
  // retention. Fails closed if the cluster's database list cannot be read.
  const scope = await workspaceAdxScope(item);
  if (!scope.has(name)) {
    let existing: string[];
    try {
      existing = (await listDatabases()).map((d) => d.name);
    } catch (e: any) {
      const status = e instanceof KustoError ? e.status : 502;
      return NextResponse.json({
        ok: false,
        error:
          `Could not verify whether "${name}" already exists on the cluster, so the create was not attempted: ` +
          `${e?.message || String(e)}`,
      }, { status });
    }
    if (existing.includes(name)) {
      return NextResponse.json({
        ok: false,
        error:
          `A KQL database named "${name}" already exists on this cluster and is not bound to this workspace. ` +
          'Creating it would overwrite its retention and hot-cache settings. Choose a different name, or bind ' +
          'the existing database as a kql-database item in the workspace that owns it.',
      }, { status: 409 });
    }
  }

  try {
    const result = await createDatabase(name, {
      hotCacheDays: Number(body?.hotCacheDays) || undefined,
      softDeleteDays: Number(body?.softDeleteDays) || undefined,
    });
    // STOP 2 — bind ONLY what ARM reports it CREATED (201). A 200 means the PUT
    // updated something that already existed, which STOP 1 should have caught;
    // binding it anyway would be the scope-injection path.
    if (result.created) {
      await rebind(item, [...boundDatabases(item), name]);
    }
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
  const requested = (new URL(req.url).searchParams.get('name') || '').trim();
  if (!requested) return NextResponse.json({ ok: false, error: 'name query param required' }, { status: 400 });
  if (!DB_NAME_RE.test(requested)) {
    return NextResponse.json({ ok: false, error: 'invalid database name' }, { status: 400 });
  }

  // LAYER 2 — dropping a KQL database is the most destructive operation on this
  // cluster. Bind it to the item's own workspace scope before the ARM call, the
  // same way `[id]/purge` binds the far less destructive `.purge`.
  const scoped = await scopeAdxDatabase(item, requested);
  if (!scoped.ok) return NextResponse.json({ ok: false, error: scoped.error }, { status: scoped.status });
  const name = scoped.database;

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
