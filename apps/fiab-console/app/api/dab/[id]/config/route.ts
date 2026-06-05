/**
 * GET /api/dab/[id]/config   → load the persisted DabConfig for a data-api item.
 * PUT /api/dab/[id]/config   → validate + persist the DabConfig to Cosmos
 *                              (item-crud `state.dabConfig`). Secrets are never
 *                              stored; the emitted JSON references @env(...).
 *
 * For id === 'new' the GET returns an empty config (the editor creates the item
 * on first save via POST /api/items/data-api-builder).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { jerr, loadOwnedItem, updateOwnedItem } from '../../../items/_lib/item-crud';
import {
  emptyDabConfig,
  emitDabConfigJson,
  validateDabConfig,
  type DabConfig,
} from '../../_lib/dab-config-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-api-builder';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const { id } = await ctx.params;
  if (id === 'new') {
    return NextResponse.json({ ok: true, config: emptyDabConfig(), isNew: true });
  }
  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('item not found', 404);
    const config = (item.state?.dabConfig as DabConfig | undefined) ?? emptyDabConfig();
    return NextResponse.json({ ok: true, config, displayName: item.displayName });
  } catch (e: any) {
    return jerr(e?.message || String(e), 500);
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const { id } = await ctx.params;
  if (id === 'new') return jerr('create the item first via POST /api/items/data-api-builder', 400);

  const body = await req.json().catch(() => ({}));
  const config = body?.config as DabConfig | undefined;
  if (!config || typeof config !== 'object') return jerr('config is required', 400);

  const issues = validateDabConfig(config);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    // Persist regardless (drafts can be invalid) but report so the UI can flag.
    // Hard errors only block publish/deploy, not save.
  }

  try {
    const json = emitDabConfigJson(config);
    const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, {
      ...(body.displayName ? { displayName: String(body.displayName) } : {}),
      state: { dabConfig: config, dabConfigJson: json },
    });
    if (!updated) return jerr('item not found', 404);
    return NextResponse.json({ ok: true, issues, json });
  } catch (e: any) {
    return jerr(e?.message || String(e), 500);
  }
}
