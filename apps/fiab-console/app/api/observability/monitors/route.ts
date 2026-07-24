/**
 * /api/observability/monitors — N17 per-table monitor registry.
 *
 *   GET  — list this tenant's monitors (freshness / volume / schema-drift).
 *   POST — create or update a monitor (audited, emit-first). DEFAULT-ON.
 *
 * withTenantAdmin (admin surface). FLAG0 kill-switch: n17-incident-console — OFF
 * returns a clean "turned off" gate (never a red error). Real Cosmos backend
 * (no-vaporware); Azure-native (no Fabric). MOAT: monitors are entirely
 * in-boundary — no external observability SaaS.
 */
import { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError } from '@/lib/api/respond';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { listMonitors, upsertMonitor } from '@/lib/observability/monitor-store';
import { N17_FLAG_ID } from '@/lib/observability/incident-model';
import type { MonitorKind } from '@/lib/observability/incident-monitor-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_KINDS = new Set<MonitorKind>(['freshness', 'volume', 'schema-drift']);

async function flagOff(): Promise<boolean> {
  return !(await runtimeFlag(N17_FLAG_ID, { default: true }));
}

export const GET = withTenantAdmin(async (_req, { session }) => {
  if (await flagOff()) return apiOk({ flagOff: true, monitors: [] });
  const monitors = await listMonitors(session.claims.oid);
  return apiOk({ monitors });
});

export const POST = withTenantAdmin(async (req: NextRequest, { session }) => {
  if (await flagOff()) return apiError('the incident console is turned off (n17-incident-console)', 409, { code: 'flag_off' });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return apiError('invalid JSON body', 400, { code: 'bad_json' });
  }
  const kind = String(body.kind || '') as MonitorKind;
  const itemId = String(body.itemId || '').trim();
  const itemType = String(body.itemType || '').trim();
  const table = String(body.table || '').trim();
  if (!VALID_KINDS.has(kind)) return apiError('kind must be freshness | volume | schema-drift', 400, { code: 'bad_kind' });
  if (!itemId || !itemType || !table) return apiError('itemId, itemType and table are required', 400, { code: 'bad_input' });

  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const actor = { oid: session.claims.oid, who: session.claims.upn || session.claims.oid, tenantId: session.claims.oid };
  const monitor = await upsertMonitor(
    {
      kind,
      itemId,
      itemType,
      table,
      workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      freshnessSlaMinutes: num(body.freshnessSlaMinutes),
      window: num(body.window),
      zThreshold: num(body.zThreshold),
      minSamplesForZ: num(body.minSamplesForZ),
      relThreshold: num(body.relThreshold),
      absFloor: num(body.absFloor),
    },
    actor,
  );
  return apiOk({ monitor });
});
