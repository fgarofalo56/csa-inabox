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
 * The designer topology is persisted to Cosmos here. The "Publish to
 * Fabric" action (sibling /publish route) pushes the topology to a real
 * Fabric Eventstream item via the Fabric definition REST API. Node-level
 * Activate/Deactivate remains a Fabric-portal toggle (not in the public
 * REST surface); the editor discloses that honestly.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadKustoItem, saveItemState, KustoError } from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface StreamConfig {
  source?: Record<string, any>;
  sink?: Record<string, any>;
  /** Multi-source / multi-sink topology (visual designer reads these). */
  sources?: Array<Record<string, any>>;
  sinks?: Array<Record<string, any>>;
  transforms?: Array<Record<string, any>>;
}

function sanitizeConfig(input: any): StreamConfig {
  const out: StreamConfig = {};
  if (input?.source && typeof input.source === 'object') out.source = input.source;
  if (input?.sink && typeof input.sink === 'object') out.sink = input.sink;
  if (Array.isArray(input?.sources)) out.sources = input.sources.slice(0, 50);
  if (Array.isArray(input?.sinks)) out.sinks = input.sinks.slice(0, 50);
  if (Array.isArray(input?.transforms)) out.transforms = input.transforms.slice(0, 50);
  return out;
}

// ─── Bundle EventstreamContent → visual-designer topology ────────────────
// App-install stamps a rich `EventstreamContent` ({ sources, destinations,
// transforms } of { id, type, config }) onto `state.content`. The visual
// designer reads `SourceNode`/`SinkNode`/`TransformNode` ({ kind, name, … }).
// Map the bundle node types onto the designer's recognized kinds so a
// bundle-installed Eventstream opens with its FULL topology rendered —
// before any live Fabric Eventstream item exists. Saving (PUT) persists the
// designer shape into state.{sources,sinks,transforms}, which wins here.
function mapSourceKind(t: string): string {
  const k = (t || '').toLowerCase();
  if (k.includes('iot')) return 'iothub';
  if (k.includes('kafka')) return 'kafka';
  if (k.includes('sample')) return 'sample';
  if (k.includes('cdc') || k.includes('mirror')) return 'cdc-mirror';
  return 'eventhub';
}
function mapSinkKind(t: string): string {
  const k = (t || '').toLowerCase();
  if (k.includes('kql') || k.includes('kusto') || k.includes('eventhouse') || k.includes('adx')) return 'kusto';
  if (k.includes('lakehouse')) return 'lakehouse';
  if (k.includes('reflex') || k.includes('activator')) return 'reflex';
  if (k.includes('derived') || k.includes('stream')) return 'derivedStream';
  return 'eventhub';
}
function mapTransformKind(t: string): string {
  const k = (t || '').toLowerCase();
  if (k.includes('filter')) return 'filter';
  if (k.includes('aggregate')) return 'aggregate';
  if (k.includes('group')) return 'group-by';
  if (k.includes('project') || k.includes('enrich')) return 'project';
  if (k.includes('union')) return 'union';
  if (k.includes('join')) return 'join';
  return 'filter';
}
function configFromContent(content: any): StreamConfig | null {
  if (!content || content.kind !== 'eventstream') return null;
  const sources = Array.isArray(content.sources)
    ? content.sources.map((n: any) => ({
        kind: mapSourceKind(n?.type),
        name: String(n?.id || n?.type || 'source'),
        ...(n?.config && typeof n.config === 'object' ? n.config : {}),
      }))
    : [];
  const sinks = Array.isArray(content.destinations)
    ? content.destinations.map((n: any) => ({
        kind: mapSinkKind(n?.type),
        name: String(n?.id || n?.type || 'destination'),
        ...(n?.config && typeof n.config === 'object' ? n.config : {}),
      }))
    : [];
  const transforms = Array.isArray(content.transforms)
    ? content.transforms.map((n: any) => ({
        kind: mapTransformKind(n?.type),
        name: String(n?.id || n?.type || 'transform'),
        ...(n?.config && typeof n.config === 'object' ? n.config : {}),
      }))
    : [];
  if (sources.length === 0 && sinks.length === 0 && transforms.length === 0) return null;
  return {
    source: sources[0],
    sink: sinks[0],
    ...(sources.length > 1 ? { sources } : {}),
    ...(sinks.length > 1 ? { sinks } : {}),
    transforms,
  };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const item = await loadKustoItem((await ctx.params).id, 'eventstream', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const hasSaved =
      !!item.state?.source || !!item.state?.sink ||
      (Array.isArray(item.state?.sources) && item.state!.sources.length > 0) ||
      (Array.isArray(item.state?.sinks) && item.state!.sinks.length > 0) ||
      (Array.isArray(item.state?.transforms) && item.state!.transforms.length > 0);
    // Fall back to the app-install starter topology stranded in state.content
    // so a bundle-installed Eventstream opens FULLY BUILT-OUT instead of empty.
    const fromContent = hasSaved ? null : configFromContent(item.state?.content);
    const config: StreamConfig = fromContent || {
      source: item.state?.source as Record<string, any> | undefined,
      sink: item.state?.sink as Record<string, any> | undefined,
      sources: Array.isArray(item.state?.sources) ? item.state!.sources : undefined,
      sinks: Array.isArray(item.state?.sinks) ? item.state!.sinks : undefined,
      transforms: Array.isArray(item.state?.transforms) ? item.state!.transforms : [],
    };
    const published = typeof item.state?.fabricEventstreamId === 'string';
    return NextResponse.json({
      ok: true,
      displayName: item.displayName,
      runtimeStatus: published ? 'published' : 'draft',
      runtimeNote: published
        ? 'Topology published to a Fabric Eventstream item. Activate nodes in the Fabric portal to start streaming.'
        : 'Draft — design the topology and Publish to Fabric to create the live Eventstream item.',
      fabricEventstreamId: item.state?.fabricEventstreamId ?? null,
      fabricWorkspaceId: item.state?.fabricWorkspaceId ?? null,
      lastPublishedAt: item.state?.lastPublishedAt ?? null,
      asaJobName: item.state?.asaJobName ?? null,
      config,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const config = sanitizeConfig(body?.config ?? body);
  try {
    const item = await loadKustoItem((await ctx.params).id, 'eventstream', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const saved = await saveItemState(item, {
      source: config.source ?? null,
      sink: config.sink ?? null,
      // Persist the full multi-source / multi-sink arrays so the visual
      // designer round-trips every node — and so the asa-sync route can map
      // EVERY destination to an ASA output (not just the first sink).
      sources: config.sources ?? null,
      sinks: config.sinks ?? null,
      transforms: config.transforms ?? [],
    });
    return NextResponse.json({ ok: true, config: {
      source: saved.state?.source,
      sink: saved.state?.sink,
      sources: saved.state?.sources ?? undefined,
      sinks: saved.state?.sinks ?? undefined,
      transforms: saved.state?.transforms || [],
    } });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
