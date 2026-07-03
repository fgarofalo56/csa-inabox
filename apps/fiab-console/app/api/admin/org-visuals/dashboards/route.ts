/**
 * Loom-native dashboards BFF (the Organizational Visuals "New visual" builder).
 *
 * GET    /api/admin/org-visuals/dashboards                 → { ok, dashboards, orgVisualsConfigured }
 * POST   /api/admin/org-visuals/dashboards  { spec }       → { ok, dashboard, blobGate? }   (create)
 * POST   ...  { action:'publish'|'unpublish', id }         → { ok, dashboard }
 * PUT    /api/admin/org-visuals/dashboards?id=<id>  { spec } → { ok, dashboard, blobGate? }  (update)
 * DELETE /api/admin/org-visuals/dashboards?id=<id>         → { ok }
 *
 * A Loom-native dashboard renders from its spec over the customer's OWN Azure
 * estate (Cost Management / Azure Resource Graph / Defender / Log Analytics) —
 * NO Microsoft Fabric / Power BI workspace required. Metadata always persists to
 * Cosmos; the spec JSON also copies to the org-visuals Blob container when
 * LOOM_ORG_VISUALS_URL is configured (else an honest gate names it). Session-gated.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import {
  listDashboards, createDashboard, updateDashboard, deleteDashboard, setDashboardPublished,
} from '@/lib/coe-library/builder/dashboard-store';
import { isConfigured } from '@/lib/clients/embed-codes-client';
import { validateSpec, type DashboardSpec, type DashboardTile, type TileVisual } from '@/lib/coe-library/builder/dashboard-model';
import { getBuilderSource } from '@/lib/coe-library/report-render/live-bindings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



const BLOB_GATE = {
  missingEnvVar: 'LOOM_ORG_VISUALS_URL',
  bicepModule: 'platform/fiab/bicep/modules/landing-zone/org-visuals-rbac.bicep',
  bicepStatus: 'grants the Console UAMI Storage Blob Data Contributor (container) + Storage Blob Delegator (account)',
  followUp: 'The dashboard is saved to your library now; set LOOM_ORG_VISUALS_URL to also persist the spec JSON in Blob storage.',
};

const VALID_VISUALS = new Set<TileVisual>(['kpi', 'bar', 'line', 'donut', 'table']);

/** Validate + normalize an untrusted spec body into a DashboardSpec. */
function parseSpec(body: any): DashboardSpec | string {
  const raw = body?.spec;
  if (!raw || typeof raw !== 'object') return 'spec is required';
  const name = String(raw.name || '').trim();
  const category = String(raw.category || '').trim() || 'FinOps';
  const accent = String(raw.accent || 'brand').trim();
  const description = raw.description ? String(raw.description).trim() : undefined;
  const tilesIn = Array.isArray(raw.tiles) ? raw.tiles : [];
  const tiles: DashboardTile[] = [];
  for (const t of tilesIn) {
    const visual = String(t?.visual || '') as TileVisual;
    if (!VALID_VISUALS.has(visual)) return `invalid tile visual: ${t?.visual}`;
    const sourceId = String(t?.sourceId || '').trim();
    if (!getBuilderSource(sourceId)) return `unknown data source: ${sourceId}`;
    tiles.push({
      id: String(t?.id || `tile-${Math.random().toString(36).slice(2, 9)}`),
      title: String(t?.title || '').trim() || 'Tile',
      visual,
      sourceId,
      category: t?.category ? String(t.category).trim() : undefined,
      value: String(t?.value || '').trim(),
    });
  }
  const spec: DashboardSpec = {
    schemaVersion: 1,
    name,
    ...(description ? { description } : {}),
    category,
    accent: (['brand', 'finops', 'security', 'inventory', 'identity', 'data', 'ops'].includes(accent) ? accent : 'brand') as DashboardSpec['accent'],
    tiles,
  };
  const invalid = validateSpec(spec);
  if (invalid) return invalid;
  return spec;
}

async function audit(tenantId: string, who: string, kind: string, fields: Record<string, unknown>) {
  try {
    const c = await auditLogContainer();
    await c.items.create({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      itemId: `loom-dashboard:${fields.id ?? ''}`,
      tenantId, who, at: new Date().toISOString(), kind, ...fields,
    }).catch(() => {});
  } catch { /* best-effort */ }
}

export async function GET() {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const tenantId = s.claims.oid;
  try {
    const dashboards = await listDashboards(tenantId);
    return NextResponse.json({ ok: true, dashboards, orgVisualsConfigured: isConfigured() });
  } catch (e: any) {
    return NextResponse.json({ ok: true, dashboards: [], orgVisualsConfigured: isConfigured(), warning: e?.message || String(e) });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || '').trim();

  if (action === 'publish' || action === 'unpublish') {
    const id = String(body.id || '').trim();
    if (!id) return apiError('id is required', 400);
    const publish = action === 'publish';
    try {
      const dashboard = await setDashboardPublished(tenantId, who, id, publish);
      await audit(tenantId, who, `loom-dashboard.${action}`, { id });
      return NextResponse.json({ ok: true, dashboard });
    } catch (e: any) {
      const msg = e?.message || String(e);
      return apiError(msg, /not found/i.test(msg) ? 404 : 500);
    }
  }

  const spec = parseSpec(body);
  if (typeof spec === 'string') return apiError(spec, 400);
  try {
    const dashboard = await createDashboard(tenantId, who, spec);
    await audit(tenantId, who, 'loom-dashboard.create', { id: dashboard.id, name: dashboard.name, tileCount: dashboard.tileCount, blobCopied: dashboard.blobCopied });
    return NextResponse.json({ ok: true, dashboard, ...(dashboard.blobCopied ? {} : { blobGate: BLOB_GATE }) });
  } catch (e: any) {
    return apiError(e?.message || String(e), 500);
  }
}

export async function PUT(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return apiError('id required', 400);
  const body = await req.json().catch(() => ({}));
  const spec = parseSpec(body);
  if (typeof spec === 'string') return apiError(spec, 400);
  try {
    const dashboard = await updateDashboard(tenantId, who, id, spec);
    await audit(tenantId, who, 'loom-dashboard.update', { id, tileCount: dashboard.tileCount });
    return NextResponse.json({ ok: true, dashboard, ...(dashboard.blobCopied ? {} : { blobGate: BLOB_GATE }) });
  } catch (e: any) {
    const msg = e?.message || String(e);
    return apiError(msg, /not found/i.test(msg) ? 404 : 500);
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return apiError('id required', 400);
  try {
    await deleteDashboard(tenantId, id);
    await audit(tenantId, who, 'loom-dashboard.delete', { id });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return apiError(e?.message || String(e), 500);
  }
}
