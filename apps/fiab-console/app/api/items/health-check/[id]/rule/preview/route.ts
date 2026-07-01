/**
 * POST /api/items/health-check/[id]/rule/preview
 *   body: { checkType, params?, ...flatParams }
 *   → { ok, query, checkType, run?: { fired, count, columns, rows }, runGate? }
 *
 * Compiles the wizard's check config to the SAME real KQL the created
 * scheduledQueryRule will evaluate (shared check-type library), then best-effort
 * runs it once against Log Analytics for a live sample. The compiled KQL is
 * ALWAYS returned so the wizard can show a preview even before the workspace is
 * configured; the live sample gates honestly (runGate) when Azure Monitor isn't
 * set up / the UAMI lacks read access. Azure-native — no Microsoft Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../../_lib/item-crud';
import { triggerMonitorActivatorRule } from '@/lib/azure/activator-monitor';
import { MonitorNotConfiguredError, MonitorError } from '@/lib/azure/monitor-client';
import { buildCheckQuery, CHECK_TYPE_BY_ID } from '../../../_lib/check-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'health-check';

function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  // A preview needs no persisted item, but we still confirm ownership when saved.
  if (id && id !== 'new') {
    const hc = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
    if (!hc) return err('health-check not found', 404, 'not_found');
  }
  const body = await req.json().catch(() => ({} as any));
  const checkType = String(body?.checkType || 'freshness');
  if (!CHECK_TYPE_BY_ID[checkType]) return err(`unknown check type "${checkType}"`, 400, 'unknown_type');
  const merged = { ...(body || {}), ...(body?.params && typeof body.params === 'object' ? body.params : {}) };
  const query = buildCheckQuery(checkType, merged);
  if (!query) return err('This check type needs more input (a table / column / KQL).', 400, 'incomplete');

  // Best-effort live sample — never blocks returning the compiled KQL.
  let run: { fired: boolean; count: number; columns: string[]; rows: unknown[][] } | undefined;
  let runGate: { reason: string; remediation: string } | undefined;
  try {
    const r = await triggerMonitorActivatorRule(query);
    run = { fired: r.fired, count: r.count, columns: r.columns, rows: r.rows.slice(0, 20) };
  } catch (e: any) {
    if (e instanceof MonitorNotConfiguredError) {
      runGate = {
        reason: 'The live sample runs the KQL against Log Analytics.',
        remediation: `Set ${e.missing?.join(' / ') || 'LOOM_LOG_ANALYTICS_WORKSPACE_ID'} on the Console to preview live results. No Microsoft Fabric required.`,
      };
    } else if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
      runGate = { reason: 'The Console UAMI needs read access to the Log Analytics workspace.', remediation: 'Grant the Console UAMI "Log Analytics Reader" on the workspace.' };
    } else {
      runGate = { reason: 'Live sample failed.', remediation: e?.message || String(e) };
    }
  }

  return NextResponse.json({ ok: true, checkType, query, ...(run ? { run } : {}), ...(runGate ? { runGate } : {}) });
}
