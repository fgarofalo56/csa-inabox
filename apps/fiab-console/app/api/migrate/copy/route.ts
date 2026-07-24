/**
 * /api/migrate/copy — M2 schema + data COPY-IN (the inbound-migration copy step).
 *
 * Consumes M1's readiness report (lib/migrate/assessment.ts), builds a copy-in
 * plan (lib/migrate/copy-plan.ts), and realizes it as a REAL Azure Data Factory
 * Copy pipeline that lands each assessed table into ADLS Bronze, then (opt-in)
 * materializes it as a managed Delta table in the target Loom lakehouse — the
 * N7b/N7c mirror substrate run IN REVERSE, reusing the SAME adf-client /
 * synapse-dev-client orchestration paths (lib/migrate/copy-engine.ts). No second
 * orchestrator.
 *
 * Guards & gates:
 *   - withTenantAdmin — bulk-copying an external estate into the lake is a
 *     tenant-admin action.
 *   - FLAG0 n-m2-copy-in — kill-switch; OFF → honest 503.
 *   - The copy's ADF/ADLS prerequisites (factory + linked services + Bronze, or
 *     an unsupported source) come back as an HONEST connector gate
 *     ({ ok:false, gated:true, gate }) — never a fabricated copy — per
 *     no-vaporware / no-fabric-dependency (the default path reaches no Fabric
 *     host; a Fabric/Power BI estate is only ever a SOURCE).
 *
 * AUDITED MUTATION: every start / materialize emits an audit event FIRST
 * (synchronous fan-out) then persists the durable `_auditLog` row + the copy-job
 * doc (migration-copy-jobs, PK /tenantId). No unaudited path writes to the lake.
 *
 * POST { action:'start', report, migrationId? }        → { ok:true, job }
 * POST { action:'status', migrationId }                → { ok:true, job }   (refreshed from ADF)
 * POST { action:'materialize', migrationId, source }   → { ok:true, job }   (one object → managed Delta)
 * POST { … } (gated)                                   → { ok:false, gated:true, gate }
 * GET  ?migrationId=…                                  → { ok:true, job }   (monitor poll)
 * 401 unauthenticated · 403 not tenant admin · 503 flag off
 */
import { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { auditLogContainer, migrationCopyJobsContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { buildCopyInPlan } from '@/lib/migrate/copy-plan';
import { startCopyIn, refreshCopyStatus, materializeDelta } from '@/lib/migrate/copy-engine';
import {
  copyJobId, summarizeCopyJob, type CopyJobDoc, type CopyObjectResult,
} from '@/lib/migrate/copy-job-model';
import type { ReadinessReport, MigrationSourceType } from '@/lib/migrate/assessment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

const SOURCE_TYPES: MigrationSourceType[] = ['snowflake', 'databricks-uc', 'fabric', 'powerbi'];

interface Body {
  action?: unknown;
  report?: unknown;
  migrationId?: unknown;
  source?: unknown;
}

/** Best-effort durable audit row (never fails the mutation). */
async function writeAuditRow(row: Record<string, unknown>): Promise<void> {
  try {
    const al = await auditLogContainer();
    await al.items.create({ id: crypto.randomUUID(), ...row });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[migrate-copy] audit row write failed:', (e as Error)?.message || e);
  }
}

/** Read one copy-job doc (or null). PK /tenantId, id copy:<migrationId>. */
async function readJob(tenantId: string, migrationId: string): Promise<CopyJobDoc | null> {
  const c = await migrationCopyJobsContainer();
  try {
    const { resource } = await c.item(copyJobId(migrationId), tenantId).read<CopyJobDoc>();
    return resource ?? null;
  } catch (e) {
    if ((e as { code?: number })?.code === 404) return null;
    throw e;
  }
}

/** Upsert a copy-job doc. */
async function writeJob(doc: CopyJobDoc): Promise<CopyJobDoc> {
  const c = await migrationCopyJobsContainer();
  const { resource } = await c.items.upsert<CopyJobDoc>(doc);
  return (resource as CopyJobDoc) ?? doc;
}

/** Coerce a client-supplied readiness report (validated shape only). */
function coerceReport(raw: unknown): ReadinessReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<ReadinessReport>;
  if (!SOURCE_TYPES.includes(r.sourceType as MigrationSourceType)) return null;
  if (!Array.isArray(r.objects)) return null;
  // Re-run the pure assessment when only an inventory-ish report was posted is
  // unnecessary — M1 already assessed. Trust the typed shape; the plan builder
  // is pure and ignores anything it doesn't recognize.
  return r as ReadinessReport;
}

export const POST = withTenantAdmin(async (req: NextRequest, { session }) => {
  // FLAG0 — kill-switch. OFF reverts the copy step (no prior behavior → honest 503).
  if (!(await runtimeFlag('n-m2-copy-in'))) {
    return apiError(
      'Migration copy-in is turned off (runtime flag n-m2-copy-in). Re-enable it on /admin/runtime-flags.',
      503, { code: 'feature_disabled' },
    );
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const action = String(body.action || 'start');
  const tenantId = session.claims.tid || session.claims.oid;

  const emit = (
    verb: 'start' | 'status' | 'materialize',
    outcome: 'success' | 'failure' | 'denied',
    migrationId: string,
    detail: Record<string, unknown>,
  ) => {
    // AUDIT: emit FIRST (synchronous fan-out to SIEM + webhooks) …
    emitAuditEvent({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn,
      action: `migrate.copy.${verb}`,
      targetType: 'migration-copy-job',
      targetId: copyJobId(migrationId),
      outcome,
      tenantId,
      timestamp: new Date().toISOString(),
      detail,
    });
    // … then persist the durable Cosmos row.
    return writeAuditRow({
      tenantId, itemType: 'migration-copy-job', itemId: copyJobId(migrationId),
      action: `migrate.copy.${verb}`, upn: session.claims.upn, actorOid: session.claims.oid,
      outcome, at: new Date().toISOString(), summary: `Migration copy-in ${verb} (${migrationId}) by ${session.claims.upn}`, ...detail,
    });
  };

  try {
    if (action === 'start') {
      const report = coerceReport(body.report);
      if (!report) return apiError('A valid M1 readiness report (sourceType + objects) is required to start a copy.', 400, { code: 'invalid_report' });

      const migrationId = (typeof body.migrationId === 'string' && body.migrationId.trim())
        ? body.migrationId.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || `${report.sourceType}-${Date.now().toString(36)}`
        : `${report.sourceType}-${Date.now().toString(36)}`;

      const plan = buildCopyInPlan(report);
      const started = await startCopyIn(plan, migrationId);

      if (!started.ok) {
        await emit('start', 'denied', migrationId, { gated: true, missing: started.gate.missing });
        return apiOk({
          ok: false, gated: true,
          gate: {
            id: 'svc-migrate-copy',
            title: 'Copy-in prerequisite required',
            remediation: started.gate.message,
            missing: [started.gate.missing],
            fixItHref: '/admin/gates?gate=svc-loom-migrate',
          },
        });
      }

      const { status, totals } = summarizeCopyJob(started.objects);
      const nowIso = new Date().toISOString();
      const doc: CopyJobDoc = {
        id: copyJobId(migrationId), tenantId, docType: 'migration-copy-job', migrationId,
        sourceType: report.sourceType, sourceLabel: report.sourceLabel,
        pipelineName: started.pipelineName, adfRunId: started.adfRunId, basePath: started.basePath,
        status, objects: started.objects, totals,
        startedAt: nowIso, updatedAt: nowIso, startedBy: session.claims.upn || session.claims.oid,
        schemaVersion: 1,
      };
      await writeJob(doc);
      await emit('start', 'success', migrationId, { objects: totals.objects, pipeline: started.pipelineName, runId: started.adfRunId });
      return apiOk({ job: doc });
    }

    if (action === 'status') {
      const migrationId = String(body.migrationId || '').trim();
      if (!migrationId) return apiError('migrationId is required.', 400, { code: 'missing_migration_id' });
      const doc = await readJob(tenantId, migrationId);
      if (!doc) return apiError('No copy-in job for that migration id.', 404, { code: 'job_not_found' });
      if (!doc.adfRunId) return apiOk({ job: doc });

      const objects = await refreshCopyStatus(doc.adfRunId, doc.objects);
      const { status, totals } = summarizeCopyJob(objects);
      const updated: CopyJobDoc = { ...doc, objects, status, totals, updatedAt: new Date().toISOString() };
      await writeJob(updated);
      return apiOk({ job: updated });
    }

    if (action === 'materialize') {
      const migrationId = String(body.migrationId || '').trim();
      const source = String(body.source || '').trim();
      if (!migrationId || !source) return apiError('migrationId and source are required to materialize.', 400, { code: 'missing_params' });
      const doc = await readJob(tenantId, migrationId);
      if (!doc) return apiError('No copy-in job for that migration id.', 404, { code: 'job_not_found' });

      const target = doc.objects.find((o) => o.source === source);
      if (!target) return apiError(`Object '${source}' is not in this copy job.`, 404, { code: 'object_not_found' });
      if (target.status !== 'succeeded') return apiError('Copy the object to Bronze first — materialize needs the completed Parquet.', 409, { code: 'copy_incomplete' });

      const materialized = await materializeDelta(target);
      const objects: CopyObjectResult[] = doc.objects.map((o) => (o.source === source ? materialized : o));
      const { status, totals } = summarizeCopyJob(objects);
      const updated: CopyJobDoc = { ...doc, objects, status, totals, updatedAt: new Date().toISOString() };
      await writeJob(updated);
      await emit('materialize', 'success', migrationId, { source, rows: materialized.rows });
      return apiOk({ job: updated });
    }

    return apiError(`Unknown action '${action}'. Expected start | status | materialize.`, 400, { code: 'invalid_action' });
  } catch (e) {
    return apiServerError(e, 'Migration copy-in failed', 'migrate_copy_failed');
  }
});

export const GET = withTenantAdmin(async (req: NextRequest, { session }) => {
  if (!(await runtimeFlag('n-m2-copy-in'))) {
    return apiError('Migration copy-in is turned off (runtime flag n-m2-copy-in).', 503, { code: 'feature_disabled' });
  }
  const tenantId = session.claims.tid || session.claims.oid;
  const migrationId = String(req.nextUrl.searchParams.get('migrationId') || '').trim();
  if (!migrationId) return apiError('migrationId query param is required.', 400, { code: 'missing_migration_id' });
  try {
    const doc = await readJob(tenantId, migrationId);
    if (!doc) return apiError('No copy-in job for that migration id.', 404, { code: 'job_not_found' });
    if (!doc.adfRunId) return apiOk({ job: doc });
    const objects = await refreshCopyStatus(doc.adfRunId, doc.objects);
    const { status, totals } = summarizeCopyJob(objects);
    const updated: CopyJobDoc = { ...doc, objects, status, totals, updatedAt: new Date().toISOString() };
    await writeJob(updated);
    return apiOk({ job: updated });
  } catch (e) {
    return apiServerError(e, 'Migration copy-in status failed', 'migrate_copy_status_failed');
  }
});
