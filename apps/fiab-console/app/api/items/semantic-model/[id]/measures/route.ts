/**
 * POST /api/items/semantic-model/[id]/measures?workspaceId=...
 *
 * Validates a candidate DAX measure expression by evaluating it server-side
 * against the dataset via the Power BI `executeQueries` REST endpoint. The
 * route compiles the expression with `DEFINE MEASURE` and probes a single
 * row so syntax + semantic errors surface as a real REST error from PBI.
 *
 * Persistence (writing the new measure into the model) requires the XMLA
 * endpoint (Premium/Fabric capacity feature) or Power BI Desktop / Tabular
 * Editor. The editor surfaces this honestly via MessageBar — see
 * `.claude/rules/no-vaporware.md` (no fake "Saved!" toasts when the engine
 * can't persist).
 *
 * Body: { measureName: string; tableName: string; daxExpression: string;
 *         probeExpression?: string }
 *
 * 200 OK → { ok: true, validated: true, probe?: { columns, rows } }
 * 4xx/5xx → { ok: false, error, status }
 *
 * AUTHORIZATION (GHSA-hf73-rp4q-66pf) — this handler ran a caller-authored DAX
 * query against a caller-named dataset with no item-level check. The probe is
 * `DEFINE MEASURE … EVALUATE ROW("value", …)`, so the expression can read any
 * table in the model: this was arbitrary DAX read access to another tenant's
 * semantic model, not merely a syntax check. It was excused by
 * check-route-guards' SHARED_BACKEND_ITEM_ROUTES on "no per-tenant Cosmos
 * ownership to scope"; eight sibling routes under `semantic-model/[id]/**`
 * resolve the SAME `[id]` as an owned Loom item.
 *
 * `authorizeItemWorkspace`, not `withWorkspaceOwner`: `[id]` is legitimately a
 * RAW Power BI dataset GUID on the opt-in path and `loadOwnedItem` renders
 * "no item" as 404. The `?workspaceId=` is a Power BI group id, so the scope is
 * resolved from the item. `allowReadRoles` — the route validates only and
 * persists nothing (persistence needs XMLA, see above), so it is a read.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { executeDatasetQueries, PowerBiError } from '@/lib/azure/powerbi-client';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface MeasureRequest {
  measureName?: string;
  tableName?: string;
  daxExpression?: string;
  probeExpression?: string;
}

function safeBracket(s: string): string {
  // strip any closing ] and wrap in [...] for DAX identifiers
  return `[${(s || '').replace(/]/g, '')}]`;
}

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const modelId = params.id;
  const denied = await authorizeItemWorkspace(session, {
    workspaceId: null,
    itemId: modelId,
    itemType: 'semantic-model',
    allowReadRoles: true,
    notFound: 'semantic model not found',
  });
  if (denied) return denied;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as MeasureRequest;
  const { measureName, tableName, daxExpression } = body;
  if (!measureName || !tableName || !daxExpression) {
    return NextResponse.json(
      { ok: false, error: 'measureName, tableName, and daxExpression are required' },
      { status: 400 },
    );
  }

  // Build a DAX validation query. DEFINE MEASURE registers the candidate
  // measure scoped to this query only (no persistence), then EVALUATE
  // returns a one-row table that references it. Power BI returns a syntax
  // or semantic error if the expression is invalid.
  const tableBracket = safeBracket(tableName);
  const measureBracket = safeBracket(measureName);
  const probe = body.probeExpression?.trim() || `${tableBracket}${measureBracket}`;
  const query = `DEFINE MEASURE ${tableBracket}${measureBracket} = ${daxExpression}\nEVALUATE ROW("value", ${probe})`;

  try {
    const j = await executeDatasetQueries(workspaceId, modelId, query);
    const rows = j?.results?.[0]?.tables?.[0]?.rows || [];
    return NextResponse.json({
      ok: true,
      validated: true,
      probe: { rows },
      persistence: 'XMLA',
      note: 'DAX expression validated server-side. Persistence requires the XMLA endpoint (Premium/Fabric capacity) or Power BI Desktop / Tabular Editor.',
    });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }
});
