/**
 * GET /api/items/eventstream/[id]  — read pipeline config from Cosmos state
 * PUT /api/items/eventstream/[id]  — save pipeline config
 *
 * state shape: {
 *   source: { kind: string, ...config },
 *   sink:   { kind: string, ...config },
 *   transforms: [ { kind: string, ...config } ]
 * }
 *
 * v2.1 note: only metadata is persisted. The Event Hubs -> Kusto
 * ingestion pipeline itself is not yet wired (deferred to v3); the
 * editor surfaces this clearly via a MessageBar.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadKustoItem, saveItemState, KustoError } from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface StreamConfig {
  source?: Record<string, any>;
  sink?: Record<string, any>;
  transforms?: Array<Record<string, any>>;
}

function sanitizeConfig(input: any): StreamConfig {
  const out: StreamConfig = {};
  if (input?.source && typeof input.source === 'object') out.source = input.source;
  if (input?.sink && typeof input.sink === 'object') out.sink = input.sink;
  if (Array.isArray(input?.transforms)) out.transforms = input.transforms.slice(0, 50);
  return out;
}

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const item = await loadKustoItem(ctx.params.id, 'eventstream', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const config: StreamConfig = {
      source: item.state?.source as Record<string, any> | undefined,
      sink: item.state?.sink as Record<string, any> | undefined,
      transforms: Array.isArray(item.state?.transforms) ? item.state!.transforms : [],
    };
    return NextResponse.json({
      ok: true,
      displayName: item.displayName,
      runtimeStatus: 'config-only',
      runtimeNote: 'v2.1: pipeline configuration is persisted but the Event Hubs -> Kusto ingestion runtime is wired in v3.',
      config,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function PUT(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const config = sanitizeConfig(body?.config ?? body);
  try {
    const item = await loadKustoItem(ctx.params.id, 'eventstream', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const saved = await saveItemState(item, {
      source: config.source ?? null,
      sink: config.sink ?? null,
      transforms: config.transforms ?? [],
    });
    return NextResponse.json({ ok: true, config: {
      source: saved.state?.source,
      sink: saved.state?.sink,
      transforms: saved.state?.transforms || [],
    } });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
