/**
 * POST /api/thread/analyze-with-dax — Loom Thread (Weave) edge.
 *
 * From a Loom-native `semantic-model` item (including a warehouse-backed model),
 * synthesize a structured DAX EVALUATE over one of the model's tables and
 * EXECUTE it against the Azure-native tabular layer, returning the real result
 * rows. Reuses the SAME executor path as the semantic-model's DAX query view and
 * the report designer — `evalDax` (lib/azure/tabular-eval-client): Synapse
 * serverless SQL by default (DAX→SQL translate), AAS XMLA only when opted in. NO
 * Power BI / Fabric REST on the default path (no-fabric-dependency.md).
 *
 * The DAX is synthesized server-side from the wizard's dropdowns
 * (`daxQueryTemplate`) — the user never types DAX (loom-no-freeform-config.md;
 * the DAX editor itself is the one sanctioned query surface, and this edge only
 * feeds it a generated query). Every branch runs a REAL evaluation or returns an
 * honest error (no-vaporware.md).
 *
 * Body: { from:{id,type,name}, values:{ table, queryKind } }
 * Returns: { ok, message, dax, receipt:{columns,rows,rowCount,backend}, link, linkLabel }
 *          | { ok:false, error }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../items/_lib/item-crud';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import { evalDax, TabularError } from '@/lib/azure/tabular-eval-client';
import { daxQueryTemplate, type DaxTemplateKind } from '@/lib/semantic-model/semantic-link';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Table-scoped query kinds this edge offers (a column is never required). */
const KINDS: ReadonlySet<DaxTemplateKind> = new Set(['table-preview', 'top-n', 'row-count']);

function bad(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

/** Rows returned in the receipt (the full result is available in the DAX view). */
const RECEIPT_ROWS = 50;

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return bad('unauthenticated', 401);
  const oid = session.claims.oid;

  const body = await req.json().catch(() => ({} as any));
  const from = body?.from || {};
  const values = body?.values || {};
  const table = String(values.table || '').trim();
  const queryKind = String(values.queryKind || 'table-preview').trim() as DaxTemplateKind;

  if (from.type !== 'semantic-model' || !from.id) {
    return bad('this edge is for semantic-model items', 400);
  }
  if (!table) return bad('pick a table', 400);
  if (!KINDS.has(queryKind)) return bad(`unsupported query kind "${queryKind}"`, 400);

  // Owner-scope the model (also resolves fromName / confirms tenant ownership).
  const model = await loadOwnedItem(from.id, from.type, oid, { allowReadRoles: true });
  if (!model) return bad('The semantic model was not found in your tenant.', 404);
  const fromName = String(from.name || model.displayName || 'semantic model');

  // Synthesize the DAX from the structured picks (never freeform).
  const dax = daxQueryTemplate(queryKind, table);

  // Execute against the Azure-native tabular backend — the exact evalDax path
  // the model's DAX query view uses. TabularError carries a real HTTP status +
  // honest hint (missing backing table, unsupported DAX, serverless failure).
  let result;
  try {
    result = await evalDax(from.id, dax, oid);
  } catch (e: any) {
    if (e instanceof TabularError) {
      const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 400;
      return NextResponse.json(
        { ok: false, error: e.message, backend: e.backend, ...(e.hint ? { hint: e.hint } : {}) },
        { status },
      );
    }
    return bad(`DAX evaluation failed: ${e?.message || String(e)}`, 502);
  }

  const rowCount = result.rows.length;
  // Record the analysis as a lineage edge (model → the DAX analysis it produced).
  // The target is a deterministic pseudo-node deep-linked back to the model's
  // DAX query view — an ad-hoc DAX read has no second Loom item, so this keeps
  // the lineage graph truthful (one endpoint per real thing) without a self-loop.
  const analysisId = `dax:${from.id}:${queryKind}:${table}`.replace(/[^A-Za-z0-9_:.-]/g, '_');
  const link = `/items/semantic-model/${from.id}?daxView=1`;
  await recordThreadEdge(session, {
    fromItemId: from.id,
    fromType: from.type,
    fromName,
    toItemId: analysisId,
    toType: 'dax-query',
    toName: `${table} · ${queryKind}`,
    toExternal: true,
    toLink: link,
    action: 'analyze-with-dax',
  });

  return NextResponse.json({
    ok: true,
    dax,
    receipt: {
      columns: result.columns,
      rows: result.rows.slice(0, RECEIPT_ROWS),
      rowCount,
      backend: result.backend,
      ...(result.sql ? { sql: result.sql } : {}),
    },
    message:
      `Ran DAX over "${table}" against the Azure-native tabular layer (${result.backend}) — ` +
      `${rowCount} row(s). Open the DAX query view to explore further.`,
    link,
    linkLabel: 'Open the DAX query view',
  });
}
