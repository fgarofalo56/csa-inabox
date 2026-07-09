/**
 * /api/items/semantic-model/[id]/dax-query — the standalone DAX query view
 * backend (FGC-21).
 *
 * A dedicated ad-hoc DAX pane, independent of the measure editor: run an
 * EVALUATE against the Azure-native tabular backend and (optionally) pin a
 * result as a model measure. Reuses the SAME proven evaluation path as the
 * measure test / RLS test-as-role probes (tabular-eval-client → Synapse
 * serverless SQL by default; AAS XMLA only when opted in). NO Power BI / Fabric
 * REST on the default path.
 *
 *   POST { op:'run', dax }                     → { columns, rows, backend, sql? }
 *   POST { op:'save-measure', name, expression → persist a measure to the
 *          , schema? }                            Loom-native model store
 *
 * AUTH: owner-scoped — the caller's oid is threaded into evalDax (listOwnedItems)
 * and readModelState/writeModelState, so a caller can only touch a model they own.
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { evalDax, resolveBackend, TabularError } from '@/lib/azure/tabular-eval-client';
import { looksLikeDaxQuery } from '@/lib/semantic-model/semantic-link';
import {
  readModelState, writeModelState, normalizeMeasure, upsertMeasure,
  type LoomModelState,
} from '../../../_lib/model-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'semantic-model';

interface DaxQueryBody {
  op?: string;
  dax?: string;
  database?: string;
  name?: string;
  expression?: string;
  schema?: string;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { id } = await ctx.params;
  const tenantId = session.claims.oid;
  const body = (await req.json().catch(() => ({}))) as DaxQueryBody;
  const op = String(body?.op || 'run').trim();

  if (op === 'run') {
    const dax = String(body?.dax || '').trim();
    if (!dax) return apiError('dax is required', 400);
    if (!looksLikeDaxQuery(dax)) {
      return apiError('A DAX query must start with EVALUATE (or DEFINE … EVALUATE).', 400);
    }
    try {
      const result = await evalDax(id, dax, tenantId, body?.database ? String(body.database) : undefined);
      return apiOk({ ...result });
    } catch (e) {
      if (e instanceof TabularError) {
        return apiError(e.message, e.status && e.status >= 400 && e.status < 600 ? e.status : 400, {
          backend: e.backend,
          ...(e.hint ? { hint: e.hint } : {}),
        });
      }
      return apiServerError(e, 'DAX evaluation failed.');
    }
  }

  if (op === 'save-measure') {
    const raw = { name: body?.name, expression: body?.expression, schema: body?.schema, kind: 'cosmos' };
    let measure;
    try {
      measure = normalizeMeasure(raw, 'cosmos');
    } catch (e: any) {
      return apiError(e?.message || 'invalid measure', 400);
    }
    try {
      const { state, itemFound } = await readModelState(id, ITEM_TYPE, tenantId);
      if (!itemFound) return apiError('Semantic model not found or not owned by you.', 404);
      const next: LoomModelState = upsertMeasure(state, measure);
      const wrote = await writeModelState(id, ITEM_TYPE, tenantId, next);
      if (!wrote) return apiServerError(new Error('writeModelState returned false'), 'Failed to save the measure.');
      return apiOk({
        measure,
        measures: next.measures,
        backend: 'loom-native',
        note: `Saved measure [${measure.name}] to this model — usable in queries immediately.`,
      });
    } catch (e) {
      return apiServerError(e, 'Failed to save the measure.');
    }
  }

  return apiError(`unknown op "${op}" — expected run | save-measure`, 400, { backend: resolveBackend() });
}
