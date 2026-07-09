/**
 * /api/items/semantic-model/[id]/semantic-link — the internal REST surface the
 * notebook Semantic Link helper (lib/notebook/loom-semantic-link.py,
 * `LoomDataFrame`) calls. FGC-17.
 *
 * Semantic Link (SemPy) parity WITHOUT a Power BI / Fabric dependency: the
 * notebook reads a Loom semantic model's tables + measures + relationships and
 * pulls DAX-evaluated values through the Azure-native tabular backend
 * (tabular-eval-client → Synapse serverless SQL by default; AAS XMLA only when
 * LOOM_SEMANTIC_BACKEND=analysis-services is opted in). api.powerbi.com /
 * api.fabric.microsoft.com are NEVER reached on the default path.
 *
 *   GET                                   → { tables, measures, relationships, backend }
 *   POST { op:'evaluate-dax', dax }       → { columns, rows, backend, sql? }
 *   POST { op:'add-measure', measure,     → evaluate a model measure (ungrouped
 *          groupby? }                        scalar, or grouped SUMMARIZECOLUMNS
 *                                            on the AAS backend)
 *   POST { op:'validate-relationships' }  → { ok, issues, findings }
 *
 * AUTH: the notebook carries the caller's minted session (managed-identity /
 * session token) — the same cookie every BFF call uses. The handler threads
 * `session.claims.oid` into every owner-scoped read (listTables / listMeasures /
 * readModelState), so a caller can only ever read a model they own.
 *
 * NO-VAPORWARE: every path calls the real tabular-eval-client + Cosmos model
 * store. No mock arrays, no return []. An unsupported DAX pattern on the
 * loom-native backend returns an HONEST 400 pointing at the AAS backend.
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import {
  listTables, listMeasures, evalDax, resolveBackend, TabularError,
  type TableMeta, type MeasureMeta,
} from '@/lib/azure/tabular-eval-client';
import { readModelState } from '../../../_lib/model-store';
import { buildMeasureEvalDax, validateRelationshipsReport } from '@/lib/semantic-model/semantic-link';
import type { HealthTable, HealthRelationship } from '@/lib/semantic-model/model-health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'semantic-model';

/** Map tabular TableMeta → the health/analyzer table shape. */
function toHealthTables(tables: TableMeta[]): HealthTable[] {
  return tables.map((t) => ({
    name: t.name,
    columns: (t.columns || []).map((c) => ({ name: c.name, dataType: c.dataType })),
  }));
}

/** Translate a thrown error into the right HTTP envelope (honest gate vs 500). */
function tabularErrorResponse(e: unknown) {
  if (e instanceof TabularError) {
    // TabularError carries a user-actionable message (unsupported pattern,
    // missing config, backing-table hint) — surface it honestly with its status.
    return apiError(e.message, e.status && e.status >= 400 && e.status < 600 ? e.status : 400, {
      backend: e.backend,
      ...(e.hint ? { hint: e.hint } : {}),
    });
  }
  return apiServerError(e, 'Semantic Link request failed.');
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { id } = await ctx.params;
  const tenantId = session.claims.oid;
  try {
    const [tables, measures, model] = await Promise.all([
      listTables(id, tenantId),
      listMeasures(id, tenantId),
      readModelState(id, ITEM_TYPE, tenantId),
    ]);
    if (!model.itemFound && tables.length === 0) {
      return apiError('Semantic model not found or not owned by you.', 404);
    }
    return apiOk({
      backend: resolveBackend(),
      tables,
      measures,
      relationships: model.state.relationships,
    });
  } catch (e) {
    return tabularErrorResponse(e);
  }
}

interface SlBody {
  op?: string;
  dax?: string;
  measure?: string;
  groupby?: unknown;
  database?: string;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { id } = await ctx.params;
  const tenantId = session.claims.oid;
  const body = (await req.json().catch(() => ({}))) as SlBody;
  const op = String(body?.op || '').trim();

  try {
    if (op === 'evaluate-dax') {
      const dax = String(body?.dax || '').trim();
      if (!dax) return apiError('dax is required', 400);
      const result = await evalDax(id, dax, tenantId, body?.database ? String(body.database) : undefined);
      return apiOk({ ...result });
    }

    if (op === 'add-measure') {
      const measureName = String(body?.measure || '').trim();
      if (!measureName) return apiError('measure is required', 400);
      const measures = await listMeasures(id, tenantId);
      const m = measures.find((x: MeasureMeta) => x.name.toLowerCase() === measureName.toLowerCase());
      if (!m) {
        return apiError(`Measure '${measureName}' is not defined in this model. Call GET to list measures.`, 404, {
          available: measures.map((x) => x.name),
        });
      }
      const groupby = Array.isArray(body?.groupby) ? (body.groupby as unknown[]).map((g) => String(g)).filter(Boolean) : [];
      const dax = buildMeasureEvalDax(m.name, m.expression, groupby);
      const result = await evalDax(id, dax, tenantId, body?.database ? String(body.database) : undefined);
      return apiOk({ ...result, dax, measure: m.name, grouped: groupby.length > 0 });
    }

    if (op === 'validate-relationships') {
      const [tables, model] = await Promise.all([
        listTables(id, tenantId),
        readModelState(id, ITEM_TYPE, tenantId),
      ]);
      if (!model.itemFound && tables.length === 0) {
        return apiError('Semantic model not found or not owned by you.', 404);
      }
      const report = validateRelationshipsReport(
        toHealthTables(tables),
        model.state.relationships as unknown as HealthRelationship[],
      );
      return apiOk({ ...report, backend: resolveBackend() });
    }

    return apiError(`unknown op "${op}" — expected evaluate-dax | add-measure | validate-relationships`, 400);
  } catch (e) {
    return tabularErrorResponse(e);
  }
}
