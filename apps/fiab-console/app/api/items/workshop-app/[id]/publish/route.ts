/**
 * POST /api/items/workshop-app/[id]/publish
 *   body: { name?, location? }
 *   → { ok, url, hostname, staticSiteName, version, tokenRetrieved, widgetCount, files }
 *
 * Real Publish → Azure Static Web Apps for the Workshop (Atelier) app builder.
 * Shares the slate-app publish path (lib/azure/swa-publish.ts): creates
 * (idempotent PUT) a Microsoft.Web/staticSites resource via ARM, waits for its
 * default hostname, and retrieves the SWA deployment token via the ARM
 * `listSecrets` action — the exact credential the SWA CLI / GitHub Action uses
 * to push the generated bundle. The bundle is generated from the app's
 * persisted canvas widgets + typed variables (Cosmos state) by
 * `generateWorkshopBundle` (_palantir-codegen): index.html + app.js + a SWA
 * config. Data widgets in the published app read REAL rows through this
 * console's /run-action route (parameterised T-SQL on the ontology's Synapse
 * warehouse); filter widgets write object-set-filter variables; buttons apply
 * their set/clear-variable events; forms run real create/update/delete
 * write-backs. A version record (url + hostname + timestamp) is appended to the
 * item's Cosmos `state.versions[]`; the raw deployment token is never persisted
 * or returned to the browser.
 *
 * 100% Azure-native (ARM staticSites + Synapse behind the ontology) — no
 * Microsoft Fabric. Honest infra-gate (503) naming LOOM_SWA_SUBSCRIPTION_ID /
 * LOOM_SWA_RESOURCE_GROUP when unset.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import { slug, swaConfig, swaNotConfiguredError, mapSwaPublishError, publishStaticSite } from '@/lib/azure/swa-publish';
import { generateWorkshopBundle } from '@/lib/editors/_palantir-codegen';
import type { WorkshopWidget, WorkshopVariable } from '@/lib/editors/workshop/_workshop-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'workshop-app';

function err(error: string, status: number, code?: string, gate?: { reason: string; remediation: string }) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}), ...(gate ? { gate } : {}) }, { status });
}

interface WorkshopVersionRecord {
  version: string; url: string; hostname: string; staticSiteName: string;
  createdAt: string; createdBy?: string; widgetCount: number;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the app first (no id yet)', 400, 'no_id');

  const app = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!app) return err('workshop-app not found', 404, 'not_found');
  const state = (app.state || {}) as Record<string, unknown>;

  const cfg = swaConfig();
  if ('missing' in cfg) {
    const gate = swaNotConfiguredError(cfg.missing);
    return err(gate.error, gate.status, gate.code, gate.gate);
  }

  // Build the deployable bundle from the persisted canvas widgets + variables.
  const body = (await req.json().catch(() => ({}))) as { name?: string; location?: string };
  const widgetsRaw = Array.isArray(state.widgets) ? (state.widgets as WorkshopWidget[]) : [];
  const variables = Array.isArray(state.variables) ? (state.variables as WorkshopVariable[]) : [];
  // Embed every widget that has enough config to function in the bundle.
  const widgets = widgetsRaw.filter((w) => {
    if (!w || !w.kind || !w.id) return false;
    if (w.kind === 'text' || w.kind === 'button') return true;
    return !!w.entityType; // table / chart / metric / filter / form need a bound object type
  });
  if (widgets.length === 0) {
    return err('Nothing to publish — add at least one configured widget to the canvas (data widgets need a bound object type).', 400, 'empty_app');
  }

  // The published app reads through THIS console's run-action route (real
  // parameterised T-SQL over the ontology's Synapse warehouse).
  const publicBase = (process.env.LOOM_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '') || req.nextUrl.origin;
  const runActionUrl = `${publicBase}/api/items/workshop-app/${encodeURIComponent(id)}/run-action`;
  const files = generateWorkshopBundle({ displayName: app.displayName, runActionUrl, widgets, variables });

  const location = (body?.location || cfg.location).trim();
  // Stable per-item resource name so re-publishing updates the same SWA.
  const persistedName = typeof state.staticSiteName === 'string' ? state.staticSiteName : '';
  const staticSiteName = persistedName || `swa-loom-${slug(body?.name || app.displayName || id, 'workshop')}-${id.slice(0, 6).replace(/[^a-z0-9]/gi, '').toLowerCase()}`.slice(0, 60);

  try {
    // ARM create + hostname poll + deployment-token retrieval (shared path).
    const { url, hostname, tokenRetrieved } = await publishStaticSite({ sub: cfg.sub, rg: cfg.rg, name: staticSiteName, location });

    // Append a version record to Cosmos.
    const prior: WorkshopVersionRecord[] = Array.isArray(state.versions) ? (state.versions as WorkshopVersionRecord[]) : [];
    const version = `v${prior.length + 1}`;
    const record: WorkshopVersionRecord = {
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
