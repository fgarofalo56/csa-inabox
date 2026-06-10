/**
 * POST /api/items/rayfin-app/preview
 *   body: { model: string, groupBy?: {table,column}[], measures?: string[], topN?: number }
 *
 * Previews the data a model-bound Rayfin app's read view would render. Builds a
 * real DAX SUMMARIZECOLUMNS / ROW() query from the selected measures + group-by
 * fields and executes it against the bound semantic model over XMLA (the
 * Azure-native default — Azure Analysis Services). Returns the real columns +
 * rows the deployed app would show — no mock data (no-vaporware.md).
 *
 * Also returns the generated DAX so the builder can show it and emit it into the
 * app's data-connector code. Per no-fabric-dependency.md no Fabric / Power BI
 * workspace is required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { AasError } from '@/lib/azure/aas-client';
import {
  modelBindingGate,
  buildReadViewDax,
  previewReadView,
  type FieldRef,
} from '@/lib/azure/rayfin-model-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PreviewBody {
  model?: string;
  groupBy?: FieldRef[];
  measures?: string[];
  topN?: number;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as PreviewBody;
  const model = body.model?.trim();
  if (!model) return NextResponse.json({ ok: false, error: 'model is required' }, { status: 400 });

  const gate = modelBindingGate();
  if (gate) {
    return NextResponse.json(
      {
        ok: false,
        backend: 'analysis-services',
        error: `Azure Analysis Services not configured: ${gate.missing} — ${gate.detail}`,
        gate,
      },
      { status: 503 },
    );
  }

  let dax: string;
  try {
    dax = buildReadViewDax({
      groupBy: Array.isArray(body.groupBy) ? body.groupBy : [],
      measures: Array.isArray(body.measures) ? body.measures : [],
      topN: body.topN,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 400 });
  }

  try {
    const result = await previewReadView(model, dax);
    const out = {
      ok: true as const,
      backend: 'analysis-services' as const,
      model,
      dax,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      executionMs: result.executionMs,
      truncated: result.truncated,
    };
    try { console.info(`[rayfin-app/preview.POST] receipt: model=${model} rows=${result.rowCount} ms=${result.executionMs}`); } catch { /* noop */ }
    return NextResponse.json(out);
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), dax }, { status });
  }
}
