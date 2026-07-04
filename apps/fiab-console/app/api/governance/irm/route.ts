/**
 * /api/governance/irm — Insider Risk Management for Lakehouse indicators
 * (Fabric Build 2026 #35).
 *
 *   GET  ?days=30  → compute IRM indicators over the Cosmos audit log +
 *                    Azure Monitor signals. Returns
 *                    { ok, kpis, findings, topActors, indicators, thresholds,
 *                      windowDays, gates }.
 *   POST { thresholds, enabled }  → persist structured tenant thresholds /
 *                    indicator toggles to the `irm:<tenantId>` settings doc.
 *
 * Azure-native: computes over the ADLS/Delta lakehouse audit trail + Monitor;
 * NEVER calls api.fabric.microsoft.com / OneLake. Works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset. A missing Log Analytics workspace
 * degrades to an honest `gates.la` MessageBar — Cosmos indicators still load.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  computeIrmIndicators,
  writeIrmThresholds,
  IRM_INDICATORS,
  type IrmThresholds,
} from '@/lib/azure/irm-client';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const days = Math.min(90, Math.max(1, Number(req.nextUrl.searchParams.get('days') || 30)));
  try {
    const report = await computeIrmIndicators({ tenantId, days });
    return NextResponse.json({ ok: true, ...report, indicators: IRM_INDICATORS });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  try {
    const body = (await req.json().catch(() => ({}))) as Partial<IrmThresholds> & {
      enabled?: Record<string, boolean>;
    };
    // Build a validated, structured patch — never persist freeform fields.
    const patch: Partial<IrmThresholds> = {};
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const clampHour = (v: number) => Math.min(24, Math.max(0, Math.round(v)));
    if (num(body.volumeZ) !== undefined) patch.volumeZ = Math.max(0, body.volumeZ!);
    if (num(body.minVolumeEvents) !== undefined) patch.minVolumeEvents = Math.max(1, Math.round(body.minVolumeEvents!));
    if (num(body.minOffHoursEvents) !== undefined) patch.minOffHoursEvents = Math.max(1, Math.round(body.minOffHoursEvents!));
    if (num(body.privilegedMinEvents) !== undefined) patch.privilegedMinEvents = Math.max(1, Math.round(body.privilegedMinEvents!));
    if (num(body.pipelineMinRuns) !== undefined) patch.pipelineMinRuns = Math.max(1, Math.round(body.pipelineMinRuns!));
    if (num(body.businessStart) !== undefined) patch.businessStart = clampHour(body.businessStart!);
    if (num(body.businessEnd) !== undefined) patch.businessEnd = clampHour(body.businessEnd!);
    if (typeof body.flagWeekends === 'boolean') patch.flagWeekends = body.flagWeekends;
    if (typeof body.timezone === 'string' && body.timezone.trim()) patch.timezone = body.timezone.trim();
    if (body.enabled && typeof body.enabled === 'object') {
      const ids = new Set(IRM_INDICATORS.map((i) => i.id));
      const filtered: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(body.enabled)) {
        if (ids.has(k)) filtered[k] = !!v;
      }
      patch.enabled = filtered;
    }
    const thresholds = await writeIrmThresholds(tenantId, patch);
    return NextResponse.json({ ok: true, thresholds });
  } catch (e: any) {
    return apiServerError(e);
  }
}
