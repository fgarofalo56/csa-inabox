/**
 * GET  /api/items/transformation-project  — list transformation-project items.
 * POST /api/items/transformation-project  — body { workspaceId, displayName,
 *                                            description?, state? } → create.
 *
 * `state` shape (lib/transform/transform-project-model.ts):
 *   {
 *     project: {
 *       backend: 'dbt' | 'sqlmesh',      // DEFAULT 'dbt' (continuity)
 *       projectName, profileName,
 *       sources: [...], models: [...],
 *       target: { engine: 'synapse'|'databricks'|'duckdb'|'fabric', … },
 *       environments: [...],             // SQLMesh virtual environments
 *       defaultEnvironment: string,
 *     },
 *     commands?: string[],               // dbt command list from the picker
 *     lastManifest?, lastCatalog?,       // dbt deployed-state for the next plan
 *   }
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { createOwnedItem, listOwnedItems } from '../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'transformation-project';

export const GET = withSession(async (_req, { session }) => {
  try {
    return apiOk({ items: await listOwnedItems(ITEM_TYPE, session.claims.oid) });
  } catch (e) {
    return apiServerError(e);
  }
});

export const POST = withSession(async (req: NextRequest, { session }) => {
  const body = await req.json().catch(() => ({}));
  try {
    const r = await createOwnedItem(session, ITEM_TYPE, body);
    if (!r.ok) return apiError(r.error, r.status);
    return apiOk({ item: r.item }, { status: 201 });
  } catch (e) {
    return apiServerError(e);
  }
});
