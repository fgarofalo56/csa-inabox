/**
 * POST /api/dab/create
 *   body { workspaceId, displayName, description?, config? }
 *   → create a new `data-api-builder` item under a tenant-owned workspace,
 *     seeding its state with the initial DabConfig. Returns the created item so
 *     the editor can route to /items/data-api-builder/<id>.
 *
 * Lives in the DAB route namespace (rather than app/api/items/data-api-builder)
 * so the whole feature is self-contained in one folder.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createOwnedItem, jerr } from '../../items/_lib/item-crud';
import { emptyDabConfig, emitDabConfigJson, type DabConfig } from '../_lib/dab-config-model';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-api-builder';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const body = await req.json().catch(() => ({}));
  const config: DabConfig = body?.config && typeof body.config === 'object' ? body.config : emptyDabConfig();
  try {
    const r = await createOwnedItem(session, ITEM_TYPE, {
      workspaceId: body.workspaceId,
      displayName: body.displayName,
      description: body.description,
      state: { dabConfig: config, dabConfigJson: emitDabConfigJson(config) },
    });
    if (!r.ok) return jerr(r.error, r.status);
    return NextResponse.json({ ok: true, item: r.item }, { status: 201 });
  } catch (e: any) {
    return apiServerError(e);
  }
}
