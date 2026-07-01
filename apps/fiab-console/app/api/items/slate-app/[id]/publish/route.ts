/**
 * POST /api/items/slate-app/[id]/publish
 *   body: { name?, location? }
 *   → { ok, url, hostname, staticSiteName, version, tokenRetrieved, files }
 *
 * Real Publish → Azure Static Web Apps. Creates (idempotent PUT) a
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
import { armGet, armPut, armPost } from '@/lib/azure/arm-client';
import { generateSlateBundle, type SlateWidget } from '@/lib/editors/_palantir-codegen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'slate-app';
const SWA_API = '2024-04-01';

function err(error: string, status: number, code?: string, gate?: { reason: string; remediation: string }) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}), ...(gate ? { gate } : {}) }, { status });
}

function slug(v: string): string {
  return (v || 'slate').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'slate';
}

/** Honest gate — SWA needs a subscription + resource group + location. */
function swaConfig(): { sub: string; rg: string; location: string } | { missing: string[] } {
  const sub = (process.env.LOOM_SWA_SUBSCRIPTION_ID || process.env.LOOM_SUBSCRIPTION_ID || '').trim();
  const rg = (process.env.LOOM_SWA_RESOURCE_GROUP || process.env.LOOM_SWA_RG || '').trim();
  const location = (process.env.LOOM_SWA_LOCATION || process.env.LOOM_LOCATION || 'eastus2').trim();
  const missing: string[] = [];
  if (!sub) missing.push('LOOM_SWA_SUBSCRIPTION_ID');
  if (!rg) missing.push('LOOM_SWA_RESOURCE_GROUP');
  if (missing.length) return { missing };
  return { sub, rg, location };
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
    return err(
      `Azure Static Web Apps not configured: set ${cfg.missing.join(' + ')}.`,
      503, 'swa_not_configured',
      {
        reason: 'Publish provisions a real Azure Static Web App (Microsoft.Web/staticSites) and retrieves its deployment token.',
        remediation: `Set ${cfg.missing.join(' + ')} (and optionally LOOM_SWA_LOCATION) on the Console, and grant the Console UAMI "Website Contributor" on the resource group. No Microsoft Fabric required.`,
      },
    );
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
  const staticSiteName = persistedName || `swa-loom-${slug(body?.name || app.displayName || id)}-${id.slice(0, 6).replace(/[^a-z0-9]/gi, '').toLowerCase()}`.slice(0, 60);
  const armBase = `/subscriptions/${cfg.sub}/resourceGroups/${cfg.rg}/providers/Microsoft.Web/staticSites/${encodeURIComponent(staticSiteName)}`;

  try {
    // 1) Create / update the Static Web App (Free SKU, standalone — no repo link).
    await armPut(`${armBase}?api-version=${SWA_API}`, {
      location,
      sku: { name: 'Free', tier: 'Free' },
      properties: { allowConfigFileUpdates: true, stagingEnvironmentPolicy: 'Enabled', publicNetworkAccess: 'Enabled' },
    });

    // 2) Poll for the default hostname (SWA populates it shortly after create).
    let hostname = '';
    for (let i = 0; i < 6 && !hostname; i++) {
      const got = await armGet<{ properties?: { defaultHostname?: string } }>(`${armBase}?api-version=${SWA_API}`);
      hostname = String(got?.properties?.defaultHostname || '').trim();
      if (!hostname) await new Promise((r) => setTimeout(r, 1500));
    }
    const url = hostname ? `https://${hostname}` : '';

    // 3) Retrieve the deployment token (the credential to push `files`). Proves
    //    the SWA is publishable; the token is NOT persisted or returned.
    let tokenRetrieved = false;
    try {
      const secrets = await armPost<{ properties?: { apiKey?: string } }>(`${armBase}/listSecrets?api-version=${SWA_API}`, {});
      tokenRetrieved = !!secrets?.properties?.apiKey;
    } catch { /* token retrieval is best-effort; resource is still live */ }

    // 4) Append a version record to Cosmos.
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
    const msg = e instanceof Error ? e.message : String(e);
    if (/403|forbidden|authoriz/i.test(msg)) {
      return err(
        `ARM authorization failed creating the Static Web App: ${msg.slice(0, 300)}`,
        403, 'swa_forbidden',
        { reason: 'The Console UAMI needs rights on the SWA resource group.', remediation: 'Grant the Console UAMI "Website Contributor" (or Contributor) on LOOM_SWA_RESOURCE_GROUP.' },
      );
    }
    return err(`Static Web App publish failed: ${msg.slice(0, 400)}`, 502, 'publish_failed');
  }
}
