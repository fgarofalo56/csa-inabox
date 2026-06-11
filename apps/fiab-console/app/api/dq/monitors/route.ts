/**
 * /api/dq/monitors — always-on DQ enforcement + observability on the workspace
 * Databricks SQL Warehouse (Azure-native, no Fabric).
 *
 * GET    ?table=<full|name>&catalog=&schema=
 *          → { monitor (Lakehouse Monitoring), refreshes, constraints (Delta) }
 * POST   { action, table, catalog?, schema?, ... }
 *          action=apply-constraint { ruleId }   → compile a DQ rule → ALTER TABLE constraint
 *          action=drop-constraint   { name }     → DROP CONSTRAINT
 *          action=create-monitor    { outputSchema, assetsDir, profileType, timestampCol?, granularities? }
 *          action=refresh-monitor                → trigger a metric refresh
 * DELETE  ?table=... → delete the monitor
 *
 * Honest 503 with the missing env var when Databricks isn't wired.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import type { DqRule } from '@/lib/azure/data-quality-client';
import {
  dqMonitorConfigGate, listDeltaConstraints, applyDeltaConstraint, dropDeltaConstraint,
  getMonitor, createMonitor, refreshMonitor, listRefreshes, deleteMonitor,
  type MonitorProfileType,
} from '@/lib/azure/dq-monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function loadRule(tenantId: string, ruleId: string): Promise<DqRule | null> {
  const c = await tenantSettingsContainer();
  try {
    const { resource } = await c.item(`dq-rules:${tenantId}`, tenantId).read<{ items: DqRule[] }>();
    return (resource?.items || []).find((r) => r.id === ruleId) || null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

function gate() { return dqMonitorConfigGate(); }
function gated() {
  const g = gate();
  return g
    ? NextResponse.json({ ok: false, code: 'not_configured', missing: g.missing,
        error: `Databricks not configured — set ${g.missing}.` }, { status: 503 })
    : null;
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const blocked = gated(); if (blocked) return blocked;

  const table = (req.nextUrl.searchParams.get('table') || '').trim();
  const catalog = req.nextUrl.searchParams.get('catalog') || undefined;
  const schema = req.nextUrl.searchParams.get('schema') || undefined;
  if (!table) return NextResponse.json({ ok: false, error: 'table query param required' }, { status: 400 });

  const fullName = table.includes('.') ? table : [catalog, schema, table].filter(Boolean).join('.');
  try {
    const [constraints, monitor] = await Promise.all([
      listDeltaConstraints(table, catalog, schema).catch((e) => ({ error: e?.message || String(e) }) as any),
      getMonitor(fullName).catch((e) => ({ error: e?.message || String(e) }) as any),
    ]);
    let refreshes: unknown[] = [];
    if (monitor && !(monitor as any).error) {
      refreshes = await listRefreshes(fullName).catch(() => []);
    }
    return NextResponse.json({ ok: true, fullName, constraints, monitor, refreshes });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const blocked = gated(); if (blocked) return blocked;

  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || '');
  const table = String(body?.table || '').trim();
  const catalog = body?.catalog ? String(body.catalog) : undefined;
  const schema = body?.schema ? String(body.schema) : undefined;
  if (!table) return NextResponse.json({ ok: false, error: 'table is required' }, { status: 400 });
  const fullName = table.includes('.') ? table : [catalog, schema, table].filter(Boolean).join('.');

  try {
    switch (action) {
      case 'apply-constraint': {
        const ruleId = String(body?.ruleId || '');
        const rule = await loadRule(s.claims.oid, ruleId);
        if (!rule) return NextResponse.json({ ok: false, error: 'rule not found' }, { status: 404 });
        const result = await applyDeltaConstraint(rule, catalog, schema);
        return NextResponse.json({ ok: result.applied, result });
      }
      case 'drop-constraint': {
        const name = String(body?.name || '');
        if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
        await dropDeltaConstraint(table, name, catalog, schema);
        return NextResponse.json({ ok: true });
      }
      case 'create-monitor': {
        const outputSchema = String(body?.outputSchema || '').trim();
        const assetsDir = String(body?.assetsDir || '').trim();
        const profileType = (body?.profileType === 'time_series' ? 'time_series' : 'snapshot') as MonitorProfileType;
        if (!outputSchema || !assetsDir) {
          return NextResponse.json({ ok: false, error: 'outputSchema and assetsDir are required' }, { status: 400 });
        }
        const monitor = await createMonitor({
          fullName, outputSchema, assetsDir, profileType,
          timestampCol: body?.timestampCol ? String(body.timestampCol) : undefined,
          granularities: Array.isArray(body?.granularities) ? body.granularities.map((g: any) => String(g)) : undefined,
        });
        return NextResponse.json({ ok: true, monitor });
      }
      case 'refresh-monitor': {
        const refresh = await refreshMonitor(fullName);
        return NextResponse.json({ ok: true, refresh });
      }
      default:
        return NextResponse.json({ ok: false, error: `unknown action "${action}"` }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const blocked = gated(); if (blocked) return blocked;
  const table = (req.nextUrl.searchParams.get('table') || '').trim();
  const catalog = req.nextUrl.searchParams.get('catalog') || undefined;
  const schema = req.nextUrl.searchParams.get('schema') || undefined;
  if (!table) return NextResponse.json({ ok: false, error: 'table query param required' }, { status: 400 });
  const fullName = table.includes('.') ? table : [catalog, schema, table].filter(Boolean).join('.');
  try {
    await deleteMonitor(fullName);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
