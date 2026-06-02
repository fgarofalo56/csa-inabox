/**
 * A single ADF Mapping Data Flow on the deployment-default Data Factory.
 *
 * Backs the Mapping Data Flow designer in the ADF editor — the list/create/
 * delete sibling route (../route.ts) gives the navigator counts + ＋ New; this
 * route reads and writes the full structured definition so the graph designer
 * can round-trip sources / transformations / sinks / scriptLines.
 *
 *   GET /api/adf/dataflows/{name}  → { ok, dataflow: { name, properties } }
 *   PUT /api/adf/dataflows/{name}  body { properties }  → upsert (real ARM PUT)
 *
 * A MappingDataFlow's `properties.typeProperties` carries:
 *   sources[]         — { name, dataset?|linkedService?, schemaLinkedService? }
 *   sinks[]           — { name, dataset?|linkedService? }
 *   transformations[] — { name, description? }   (select / filter / join / …)
 *   scriptLines[]     — the Data Flow Script (DFS) lines that actually wire the
 *                       graph and carry per-transform expressions.
 * Ref: https://learn.microsoft.com/azure/data-factory/concepts-data-flow-overview
 *      https://learn.microsoft.com/azure/data-factory/data-flow-script
 *      https://learn.microsoft.com/rest/api/datafactory/data-flows/create-or-update
 *
 * Factory is the env-pinned default; honest 503 gate when LOOM_SUBSCRIPTION_ID /
 * LOOM_DLZ_RG / LOOM_ADF_NAME aren't set. Real ARM REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  adfConfigGate, getDataFlow, upsertDataFlow, deleteDataFlow,
  type AdfDataFlow,
} from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NAME_RE = /^[A-Za-z0-9_]{1,260}$/;

function gate() {
  const g = adfConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Data Factory not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const { name } = await ctx.params;
  if (!name || !NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'invalid data flow name' }, { status: 400 });
  try {
    const dataflow = await getDataFlow(name);
    return NextResponse.json({ ok: true, dataflow });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const { name } = await ctx.params;
  if (!name || !NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'invalid data flow name' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const properties = (body?.properties as AdfDataFlow['properties']) || undefined;
  if (!properties || typeof properties !== 'object') {
    return NextResponse.json({ ok: false, error: 'properties is required' }, { status: 400 });
  }
  // Force a valid data-flow type. The designer always emits MappingDataFlow.
  if (typeof properties.type !== 'string') properties.type = 'MappingDataFlow';
  // Guarantee the four typeProperties arrays exist so ADF accepts the PUT even
  // for a freshly-scaffolded (empty) flow.
  const tp = (properties.typeProperties || {}) as Record<string, unknown>;
  if (!Array.isArray(tp.sources)) tp.sources = [];
  if (!Array.isArray(tp.sinks)) tp.sinks = [];
  if (!Array.isArray(tp.transformations)) tp.transformations = [];
  if (!Array.isArray(tp.scriptLines)) tp.scriptLines = [];
  properties.typeProperties = tp;
  try {
    const saved = await upsertDataFlow(name, { name, properties });
    return NextResponse.json({ ok: true, dataflow: saved });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const { name } = await ctx.params;
  if (!name || !NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'invalid data flow name' }, { status: 400 });
  try {
    await deleteDataFlow(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
