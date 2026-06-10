/**
 * GET /api/items/rayfin-app/model-objects?model=<db>
 *
 * Introspects a bound semantic model and returns its tables, columns, and
 * measures — the objects a model-bound Rayfin app can read (Fabric Apps Build
 * 2026 #28). The metadata is live engine-truth from the Azure-native default
 * backend (Azure Analysis Services) via real DAX INFO.* queries over XMLA — no
 * mock data (no-vaporware.md).
 *
 * Per no-fabric-dependency.md no Fabric / Power BI workspace is required. AAS
 * misconfiguration returns { ok:false, gate } with 503 for an honest gate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { AasError } from '@/lib/azure/aas-client';
import { modelBindingGate, introspectModel } from '@/lib/azure/rayfin-model-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const model = req.nextUrl.searchParams.get('model')?.trim();
  if (!model) return NextResponse.json({ ok: false, error: 'model query param required' }, { status: 400 });

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

  try {
    const meta = await introspectModel(model);
    const out = { ok: true as const, backend: 'analysis-services' as const, ...meta };
    try {
      console.info(
        `[rayfin-app/model-objects.GET] receipt: model=${model} tables=${meta.tables.length} measures=${meta.measures.length} columns=${meta.columns.length}`,
      );
    } catch { /* noop */ }
    return NextResponse.json(out);
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
