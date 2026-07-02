/**
 * POST /api/items/slate-app/[id]/publish
 *   body: { name?, location? }
 *   → { ok, url, hostname, staticSiteName, version, tokenRetrieved, files }
 *
 * Real Publish → Azure Static Web Apps via the shared publish path
 * (lib/azure/swa-publish.ts): creates (idempotent PUT) a
 * Microsoft.Web/staticSites resource via ARM, waits for its default hostname,
 * and retrieves the SWA deployment token via the ARM `listSecrets` action — the
 * exact credential the SWA CLI / GitHub Action uses to push the generated
 * bundle (index.html / app.js / staticwebapp.config.json from _palantir-codegen).
 * A version record (url + hostname + timestamp) is appended to the item's
 * Cosmos `state.versions[]`; the raw deployment token is never persisted or
 * returned to the browser.
 *
 * 100% Azure-native (ARM staticSites) — no Microsoft Fabric. Honest infra-gate
 * (503) naming LOOM_SWA_SUBSCRIPTION_ID / LOOM_SWA_RESOURCE_GROUP when unset.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import { slug, swaConfig, swaNotConfiguredError, mapSwaPublishError, publishStaticSite } from '@/lib/azure/swa-publish';
import { generateSlateBundle, type SlateWidget } from '@/lib/editors/_palantir-codegen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'slate-app';

function err(error: string, status: number, code?: string, gate?: { reason: string; remediation: string }) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}), ...(gate ? { gate } : {}) }, { status });
}

interface SlateVersionRecord {
  version: string; url: string; hostname: string; staticSiteName: string;
  createdAt: string; createdBy?: string; widgetCount: number;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the app first (no id yet)', 400, 'no_id');

  const app = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!app) return err('slate-app not found', 404, 'not_found');
  const state = (app.state || {}) as Record<string, unknown>;

  const cfg = swaConfig();
  if ('missing' in cfg) {
    const gate = swaNotConfiguredError(cfg.missing);
    return err(gate.error, gate.status, gate.code, gate.gate);
  }

  // Build the deployable bundle from the persisted widgets (REST-bound only).
  const body = (await req.json().catch(() => ({}))) as { name?: string; location?: string };
  const widgetsRaw = Array.isArray(state.widgets) ? (state.widgets as any[]) : [];
  const queries = Array.isArray(state.queries) ? (state.queries as any[]) : [];
  const byId = new Map(queries.map((q) => [q.id, q]));
  const widgets: SlateWidget[] = widgetsRaw.map((w: any) => {
    let query = '';
    if (w?.queryId) { const q = byId.get(w.queryId); if (q?.type === 'rest-dab') query = String(q.path || ''); }
    else if (w?.query) query = String(w.query);
    const kind: 'table' | 'chart' | 'metric' = w?.kind === 'chart' || w?.kind === 'metric' ? w.kind : 'table';
    return { id: String(w?.id || w?.title || ''), title: String(w?.title || 'Widget'), kind, query };
  }).filter((w) => w.query);
  const files = generateSlateBundle({ displayName: app.displayName, apiBaseUrl: String(state.apiBaseUrl || '/api'), widgets });

  const location = (body?.location || cfg.location).trim();
  // Stable per-item resource name so re-publishing updates the same SWA.
  const persistedName = typeof state.staticSiteName === 'string' ? state.staticSiteName : '';
  const staticSiteName = persistedName || `swa-loom-${slug(body?.name || app.displayName || id, 'slate')}-${id.slice(0, 6).replace(/[^a-z0-9]/gi, '').toLowerCase()}`.slice(0, 60);

  try {
    // ARM create + hostname poll + deployment-token retrieval (shared path).
    const { url, hostname, tokenRetrieved } = await publishStaticSite({ sub: cfg.sub, rg: cfg.rg, name: staticSiteName, location });

    // Append a version record to Cosmos.
    const prior: SlateVersionRecord[] = Array.isArray(state.versions) ? (state.versions as SlateVersionRecord[]) : [];
    const version = `v${prior.length + 1}`;
    const record: SlateVersionRecord = {
      version, url, hostname, staticSiteName,
      createdAt: new Date().toISOString(), createdBy: session.claims.oid, widgetCount: widgets.length,
    };
    await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, {
      state: { ...state, staticSiteName, swaLocation: location, versions: [record, ...prior].slice(0, 50), lastPublishedAt: record.createdAt, lastPublishedUrl: url },
    });

    return NextResponse.json({ ok: true, url, hostname, staticSiteName, version, tokenRetrieved, widgetCount: widgets.length, files });
  } catch (e: unknown) {
    const mapped = mapSwaPublishError(e);
    return err(mapped.error, mapped.status, mapped.code, mapped.gate);
  }
}
