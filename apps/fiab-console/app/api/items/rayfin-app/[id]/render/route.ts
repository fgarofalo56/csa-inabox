/**
 * POST /api/items/rayfin-app/<id>/render — the visual app builder's RUNTIME.
 *
 * Given a Loom visual app definition (pages → components → model bindings), this
 * executes every data component's read view against the bound semantic model
 * over XMLA and returns the real rows each component would render — the live
 * runtime for the audit-T145 low-code builder. No mock data (no-vaporware.md);
 * the Azure-native default backend is Azure Analysis Services (no Fabric / Power
 * BI workspace required, per no-fabric-dependency.md).
 *
 * Body: { app?: RayfinAppDefinition } — when omitted, the saved app definition
 * on the item (state.spec.app) is rendered instead, so the deployed app config
 * round-trips. Each data component is executed independently: a failure on one
 * component returns { ok:false, error } for that component without failing the
 * whole render.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { AasError } from '@/lib/azure/aas-client';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { modelBindingGate, buildReadViewDax, previewReadView } from '@/lib/azure/rayfin-model-binding';
import {
  gbParse, isDataComponent,
  type RayfinAppDefinition, type RayfinComponent,
} from '@/lib/editors/rayfin-app-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'rayfin-app';

interface RenderedComponent {
  id: string;
  kind: string;
  title: string;
  ok: boolean;
  dax?: string;
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  executionMs?: number;
  truncated?: boolean;
  entity?: string;
  text?: string;
  error?: string;
}

async function renderComponent(model: string, c: RayfinComponent): Promise<RenderedComponent> {
  const base = { id: c.id, kind: c.kind, title: c.title };
  if (!isDataComponent(c.kind)) {
    // Non-data components carry their own static structure (the deployed Rayfin
    // app renders forms/text); echo it so the runtime preview mirrors the app.
    return { ...base, ok: true, entity: c.entity, text: c.text };
  }
  const b = c.binding;
  if (!b || (b.measures.length === 0 && b.groupBy.length === 0)) {
    return { ...base, ok: false, error: 'No measures or group-by selected for this component.' };
  }
  try {
    const dax = buildReadViewDax({
      groupBy: (b.groupBy || []).map((k) => gbParse(k)),
      measures: b.measures || [],
      topN: b.topN,
    });
    const res = await previewReadView(model, dax);
    return {
      ...base, ok: true, dax,
      columns: res.columns, rows: res.rows, rowCount: res.rowCount,
      executionMs: res.executionMs, truncated: res.truncated,
    };
  } catch (e: any) {
    return { ...base, ok: false, error: e?.message || String(e) };
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;

  const body = (await req.json().catch(() => ({}))) as { app?: RayfinAppDefinition };
  let app = body.app;

  // Fall back to the persisted definition when the client didn't supply one.
  if (!app && id && id !== 'new') {
    try {
      const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
      app = (item?.state as any)?.spec?.app as RayfinAppDefinition | undefined;
    } catch { /* fall through to empty */ }
  }

  if (!app || !Array.isArray(app.pages) || app.pages.length === 0) {
    return NextResponse.json({ ok: false, error: 'No app definition to render — add pages and components in the App builder.' }, { status: 400 });
  }
  const model = (app.model || '').trim();
  if (!model) {
    return NextResponse.json({ ok: false, error: 'The app is not bound to a semantic model. Bind one in the Model binding tab.' }, { status: 400 });
  }

  const gate = modelBindingGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, backend: 'analysis-services', error: `Azure Analysis Services not configured: ${gate.missing} — ${gate.detail}`, gate },
      { status: 503 },
    );
  }

  try {
    const pages = [];
    for (const p of app.pages) {
      const components: RenderedComponent[] = [];
      for (const c of p.components || []) {
        components.push(await renderComponent(model, c));
      }
      pages.push({ id: p.id, name: p.name, components });
    }
    const componentCount = pages.reduce((n, p) => n + p.components.length, 0);
    const out = { ok: true as const, backend: 'analysis-services' as const, model, pages };
    try { console.info(`[rayfin-app/render.POST] receipt: model=${model} pages=${pages.length} components=${componentCount}`); } catch { /* noop */ }
    return NextResponse.json(out);
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
