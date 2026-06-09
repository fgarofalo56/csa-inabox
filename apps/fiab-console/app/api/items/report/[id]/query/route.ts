/**
 * POST /api/items/report/[id]/query
 *
 * Executes a DAX query against the Azure Analysis Services model bound to this
 * report item and returns the result rows. Used by the Loom-native report
 * renderer in ReportEditor (LOOM_BI_BACKEND unset) to populate each visual —
 * no Power BI / Fabric workspace required (no-fabric-dependency.md).
 *
 * Body: { query: string }                  — a DAX EVALUATE expression, OR
 *       { visual: { type, field } }         — a visual to synthesize DAX from
 * Returns: { ok, rows: [...], daxQuery }
 *
 * Auth: Console UAMI must be a server admin on the AAS instance.
 *
 * No mocks. AAS errors (401/403 — UAMI not server admin; 404 — model not
 * found) surface verbatim via AasError. When the item has no AAS binding the
 * route returns 412 with the exact remediation env vars.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  executeAasQuery,
  buildDaxFromVisual,
  flattenAasRows,
  resolveAasBinding,
  AasError,
} from '@/lib/azure/aas-client';
import { loadModelItem } from '@/lib/azure/model-binding';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function stateBinding(item: WorkspaceItem): { server?: string; database?: string } {
  const state = (item.state || {}) as Record<string, unknown>;
  return {
    server: typeof state.aasServer === 'string' ? state.aasServer : undefined,
    database: typeof state.aasDatabase === 'string' ? state.aasDatabase : undefined,
  };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;
  const body = await req.json().catch(() => ({} as any));
  const rawQuery: string = (body?.query || '').toString().trim();

  // Resolve the item + its AAS binding (content-backed loom: id or plain id).
  let item: WorkspaceItem | null;
  if (isLoomContentId(id)) {
    item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'report', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'report template not found' }, { status: 404 });
  } else {
    item = await loadModelItem(id, 'report', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'report item not found' }, { status: 404 });
  }

  const { server, database } = stateBinding(item);
  const binding = resolveAasBinding(server, database);
  if (!binding) {
    return NextResponse.json(
      {
        ok: false,
        code: 'unbound',
        error:
          'This report item has no Azure Analysis Services binding. Set state.aasServer ' +
          '(XMLA URI, e.g. asazure://eastus2.asazure.windows.net/my-server) + state.aasDatabase ' +
          'on the item, or configure LOOM_AAS_SERVER + LOOM_AAS_DATABASE environment variables.',
      },
      { status: 412 },
    );
  }

  // Build DAX: explicit query wins, else synthesize from the visual definition.
  let daxQuery = rawQuery;
  if (!daxQuery && body?.visual) {
    daxQuery = buildDaxFromVisual(body.visual) ?? '';
  }
  if (!daxQuery) {
    return NextResponse.json({ ok: false, error: 'query or visual.field required' }, { status: 400 });
  }

  try {
    const result = await executeAasQuery(binding.region, binding.serverName, binding.database, daxQuery);
    const rows = flattenAasRows(result);
    return NextResponse.json({ ok: true, rows, daxQuery });
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
