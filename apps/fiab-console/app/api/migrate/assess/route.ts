/**
 * POST /api/migrate/assess — M1 estate assessment (the inbound-migration on-ramp).
 *
 * Points Loom at a source estate (Snowflake / Databricks Unity Catalog /
 * Microsoft Fabric / Power BI), enumerates it through the `apps/loom-migrate`
 * reader, and returns a MIGRATION-READINESS REPORT: a per-object mapping to a
 * Loom item type with a `1:1` / `needs-review` effort flag (lib/migrate/
 * assessment.ts — the shared substrate M2/M3 consume).
 *
 * Guards & gates:
 *   - withTenantAdmin — reading an external estate is a tenant-admin action.
 *   - FLAG0 n-migrate (`n-m1-estate-assess`) — kill-switch; OFF → honest 503.
 *   - svc-loom-migrate gate — LOOM_MIGRATE_URL unset → the normalized gate
 *     envelope (Fix-it names the prerequisite). A source whose CONNECTION
 *     prerequisite is missing comes back as an honest connector gate (never
 *     fabricated counts) per no-vaporware / no-fabric-dependency.
 *
 * AUDITED DATA-ACCESS: every assess — success or failure — emits an audit
 * event FIRST (synchronous fan-out) then writes a durable `_auditLog` row.
 * There is no unaudited path to the reader.
 *
 * 200 → { ok:true, report }                    (real readiness report)
 * 200 → { ok:false, gated:true, gate }         (honest connector gate)
 * 401 → unauthenticated · 403 → not tenant admin
 * 503 → feature flag off / reader not configured (gate envelope)
 */
import { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { apiHonestGateError, backendGateResponse } from '@/lib/api/gate-envelope';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import {
  enumerateEstate,
  isMigrateConfigured,
  MigrateReaderError,
  type MigrateConnection,
} from '@/lib/migrate/migrate-client';
import { assessInventory, type MigrationSourceType } from '@/lib/migrate/assessment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

const SOURCE_TYPES: MigrationSourceType[] = ['snowflake', 'databricks-uc', 'fabric', 'powerbi'];

interface Body {
  sourceType?: unknown;
  connection?: unknown;
}

/** Write the durable data-access audit row (best-effort; never fails the read). */
async function writeAuditRow(row: Record<string, unknown>): Promise<void> {
  try {
    const al = await auditLogContainer();
    await al.items.create({ id: crypto.randomUUID(), ...row });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[migrate] audit row write failed:', (e as Error)?.message || e);
  }
}

export const POST = withTenantAdmin(async (req: NextRequest, { session }) => {
  // FLAG0 — kill-switch. OFF reverts the on-ramp (no prior behavior → honest 503).
  if (!(await runtimeFlag('n-m1-estate-assess'))) {
    return apiError(
      'Estate assessment is turned off (runtime flag n-m1-estate-assess). Re-enable it on /admin/runtime-flags.',
      503,
      { code: 'feature_disabled' },
    );
  }

  // svc-loom-migrate infra gate — the reader must be wired.
  if (!isMigrateConfigured()) {
    return apiHonestGateError('svc-loom-migrate');
  }
  // Belt-and-braces: if the registry evaluates the gate as blocked, honor it.
  const gated = backendGateResponse('svc-loom-migrate');
  if (gated) return gated;

  const body = (await req.json().catch(() => ({}))) as Body;
  const sourceType = String(body.sourceType || '') as MigrationSourceType;
  if (!SOURCE_TYPES.includes(sourceType)) {
    return apiError(`sourceType must be one of: ${SOURCE_TYPES.join(', ')}.`, 400, { code: 'invalid_source_type' });
  }
  const connection: MigrateConnection =
    body.connection && typeof body.connection === 'object' ? (body.connection as MigrateConnection) : {};

  const tenantId = session.claims.tid || session.claims.oid;
  const auditBase = {
    tenantId,
    itemType: 'migration-assessment',
    itemId: `migrate:${sourceType}`,
    action: 'migrate.assess',
    upn: session.claims.upn,
    actorOid: session.claims.oid,
    sourceType,
    at: new Date().toISOString(),
  };
  const emit = (outcome: 'success' | 'failure' | 'denied', detail: Record<string, unknown>) => {
    // AUDIT: emit FIRST (synchronous fan-out to SIEM + webhooks) …
    emitAuditEvent({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn,
      action: 'migrate.assess',
      targetType: 'migration-assessment',
      targetId: `migrate:${sourceType}`,
      outcome,
      tenantId,
      timestamp: auditBase.at,
      detail: { sourceType, ...detail },
    });
    // … then persist the durable Cosmos row.
    return writeAuditRow({ ...auditBase, outcome, summary: `Estate assessment of ${sourceType} by ${session.claims.upn}`, ...detail });
  };

  try {
    const result = await enumerateEstate(sourceType, connection);

    if (!result.ok) {
      // Honest connector gate — reader reachable, source needs a connection.
      await emit('denied', { gated: true, prerequisite: result.gate.prerequisite });
      return apiOk({
        ok: false,
        gated: true,
        gate: {
          id: 'svc-loom-migrate',
          title: 'Source connection required',
          remediation: result.gate.message,
          missing: result.gate.prerequisite,
          fixItHref: '/admin/gates?gate=svc-loom-migrate',
        },
      });
    }

    const report = assessInventory(result.inventory);
    await emit('success', {
      objects: report.totals.objects,
      oneToOne: report.totals.oneToOne,
      needsReview: report.totals.needsReview,
    });
    return apiOk({ report });
  } catch (e) {
    if (e instanceof MigrateReaderError) {
      await emit('failure', { error: e.message.slice(0, 300) });
      return apiError(e.message, e.status, { code: 'reader_error' });
    }
    await emit('failure', { error: 'unexpected' });
    return apiServerError(e, 'Estate assessment failed', 'migrate_assess_failed');
  }
});
