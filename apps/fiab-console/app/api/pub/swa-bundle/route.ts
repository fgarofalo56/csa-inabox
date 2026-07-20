/**
 * GET /api/pub/swa-bundle?type=<workshop-app|slate-app>&item=<id>&exp=<unix>&sig=<hmac>
 *
 * ANONYMOUS-but-SIGNED bundle download for the Static Web Apps zipdeploy
 * fetcher. The publish routes call the ARM `zipdeploy` action with this URL as
 * `appZipUrl`; the SWA service fetches it unauthenticated, so this route is
 * deliberately session-free and hardened instead:
 *   - HMAC-SHA256 signature over `${type}:${item}:${exp}` (key derived from
 *     SESSION_SECRET via HKDF 'loom-swa-bundle-v1'), timing-safe compare,
 *     short expiry — minted ONLY by an authenticated publish call.
 *   - The response is exclusively the item's REGENERATED app bundle (from its
 *     Cosmos state via the same codegen the publish route uses) — no other
 *     data is reachable, and a leaked URL goes stale at `exp`.
 *
 * Why regenerate instead of staging the zip: deterministic from item state,
 * replica-safe (no in-memory handoff), nothing to clean up. The estate storage
 * accounts are PE-locked, so a SAS blob would be unreachable from the SWA
 * fetcher — the console's public Front Door URL is the one host it CAN reach.
 */
import { NextRequest, NextResponse } from 'next/server';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { verifySwaBundleToken, signAppReadToken } from '@/lib/azure/swa-publish';
import { buildStoreZip } from '@/lib/azure/swa-zip';
import {
  generateWorkshopBundle, generateSlateBundle,
  type GeneratedFile, type SlateWidget,
} from '@/lib/editors/_palantir-codegen';
import type { WorkshopWidget, WorkshopVariable } from '@/lib/editors/workshop/_workshop-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TYPES = new Set(['workshop-app', 'slate-app']);

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const type = String(q.get('type') || '');
  const id = String(q.get('item') || '');
  const exp = Number(q.get('exp') || 0);
  const sig = String(q.get('sig') || '');

  if (!TYPES.has(type) || !id) return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  if (!verifySwaBundleToken(type, id, exp, sig)) {
    return NextResponse.json({ ok: false, error: 'invalid_or_expired_signature' }, { status: 403 });
  }

  const items = await itemsContainer();
  const { resources } = await items.items
    .query<{ id: string; itemType: string; displayName?: string; state?: Record<string, unknown> }>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [{ name: '@id', value: id }, { name: '@t', value: type }],
    })
    .fetchAll();
  const item = resources[0];
  if (!item) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  const state = (item.state || {}) as Record<string, unknown>;

  const publicBase = (process.env.LOOM_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '') || req.nextUrl.origin;

  let files: GeneratedFile[];
  if (type === 'workshop-app') {
    const widgetsRaw = Array.isArray(state.widgets) ? (state.widgets as WorkshopWidget[]) : [];
    const widgets = widgetsRaw.filter((w) => {
      if (!w || !w.kind || !w.id) return false;
      if (w.kind === 'text' || w.kind === 'button') return true;
      return !!w.entityType;
    });
    const variables = Array.isArray(state.variables) ? (state.variables as WorkshopVariable[]) : [];
    const runActionUrl = `${publicBase}/api/items/workshop-app/${encodeURIComponent(id)}/run-action`;
    const tokenVersion = Number(state.pubTokenVersion) || 1;
    const appReadToken = signAppReadToken(id, tokenVersion);
    files = generateWorkshopBundle({ displayName: item.displayName || 'Workshop app', runActionUrl, widgets, variables, appReadToken });
  } else {
    const widgetsRaw = Array.isArray(state.widgets) ? (state.widgets as Array<Record<string, unknown>>) : [];
    const queries = Array.isArray(state.queries) ? (state.queries as Array<Record<string, unknown>>) : [];
    const byId = new Map(queries.map((x) => [String(x.id || ''), x]));
    const widgets: SlateWidget[] = widgetsRaw.map((w) => {
      let query = '';
      if (w?.queryId) { const qq = byId.get(String(w.queryId)); if (qq?.type === 'rest-dab') query = String(qq.path || ''); }
      else if (w?.query) query = String(w.query);
      const kind: 'table' | 'chart' | 'metric' = w?.kind === 'chart' || w?.kind === 'metric' ? (w.kind as 'chart' | 'metric') : 'table';
      return { id: String(w?.id || w?.title || ''), title: String(w?.title || 'Widget'), kind, query };
    }).filter((w) => w.query);
    files = generateSlateBundle({ displayName: item.displayName || 'Slate app', apiBaseUrl: String(state.apiBaseUrl || '/api'), widgets });
  }

  const zip = buildStoreZip(Object.fromEntries(files.map((f) => [f.name, f.content])));
  return new NextResponse(new Uint8Array(zip), {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${type}-${id.slice(0, 8)}.zip"`,
      'cache-control': 'no-store',
    },
  });
}
