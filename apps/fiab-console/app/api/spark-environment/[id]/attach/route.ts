/**
 * Attach / detach a spark-environment to notebooks and Spark job definitions.
 *
 *   GET  /api/spark-environment/[id]/attach
 *        → lists candidate items (notebooks + spark-job-definitions) owned by
 *          the tenant, each flagged with whether it's attached to THIS env.
 *
 *   POST /api/spark-environment/[id]/attach   body { targetType, targetId, attach }
 *        → when attach=true: stamps state.environmentId + state.environmentPool
 *          (the env's published pool) onto the target so it defaults to the
 *          published runtime; when attach=false: clears them. Keeps the env's
 *          state.attachedItemIds in sync.
 *
 * Real Cosmos writes on both sides — no Microsoft Fabric dependency.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, listOwnedItems, updateOwnedItem, jerr } from '@/app/api/items/_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'spark-environment';
const ATTACHABLE = ['notebook', 'spark-job-definition'] as const;
type Attachable = (typeof ATTACHABLE)[number];

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const id = (await ctx.params).id;
  try {
    const env = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!env) return jerr('not found', 404);
    const out: Array<{ id: string; itemType: string; displayName: string; attached: boolean }> = [];
    for (const t of ATTACHABLE) {
      const items = await listOwnedItems(t, session.claims.oid);
      for (const it of items) {
        out.push({
          id: it.id,
          itemType: t,
          displayName: it.displayName,
          attached: (it.state as any)?.environmentId === id,
        });
      }
    }
    return NextResponse.json({
      ok: true,
      publishedToPool: (env.state as any)?.publishedToPool || null,
      candidates: out,
    });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const id = (await ctx.params).id;
  const body = await req.json().catch(() => ({}));
  const targetType = (body?.targetType || '').toString() as Attachable;
  const targetId = (body?.targetId || '').toString();
  const attach = body?.attach !== false; // default true
  if (!ATTACHABLE.includes(targetType)) return jerr(`targetType must be one of ${ATTACHABLE.join(', ')}`, 400);
  if (!targetId) return jerr('targetId is required', 400);

  try {
    const env = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!env) return jerr('not found', 404);
    const envState: any = env.state || {};

    const target = await loadOwnedItem(targetId, targetType, session.claims.oid);
    if (!target) return jerr('target item not found', 404);
    const tState: any = target.state || {};

    if (attach) {
      const pool = envState.publishedToPool || undefined;
      const next = { ...tState, environmentId: id, environmentName: env.displayName };
      if (pool) {
        next.environmentPool = pool;
        // Stamp the notebook's preferred compute so it defaults to the
        // published pool (the one with the env's libraries baked in).
        if (targetType === 'notebook') next.preferredPool = pool;
      }
      await updateOwnedItem(targetId, targetType, session.claims.oid, { state: next });
    } else {
      const next = { ...tState };
      delete next.environmentId;
      delete next.environmentName;
      delete next.environmentPool;
      if (targetType === 'notebook' && next.preferredPool === envState.publishedToPool) delete next.preferredPool;
      await updateOwnedItem(targetId, targetType, session.claims.oid, { state: next });
    }

    const set = new Set<string>(Array.isArray(envState.attachedItemIds) ? envState.attachedItemIds : []);
    if (attach) set.add(targetId); else set.delete(targetId);
    const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, {
      state: { ...envState, attachedItemIds: Array.from(set) },
    });

    return NextResponse.json({ ok: true, attached: attach, attachedItemIds: (updated?.state as any)?.attachedItemIds || [] });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
