/**
 * M2 — copy-in JOB doc shape + PURE state helpers + MIG1 migrator registration.
 *
 * One doc per copy-in RUN (id `copy:<migrationId>`, PK /tenantId) records the
 * ADF pipeline that was authored, its run id, and the per-object copy status +
 * real row counts the /admin/migrate "Copy in" monitor renders. The monitor
 * refreshes counts live from the ADF activity-run output (copy-engine), then
 * persists them here so a reload shows the last known state without re-hitting
 * ADF — no mock rows, no derived guesses (no-vaporware).
 *
 * LEAF module: imports ONLY `cosmos-migrations` (no cosmos-client, no Azure SDK,
 * no next) so cosmos-client can import the container-name constant + call the
 * migrator registrar at module scope before any read materializes — the
 * lakehouse-interop-model / prompt-registry-model precedent. Safe to import from
 * a client component for the shared types.
 *
 * CURRENT SCHEMA VERSION: 1. A future breaking change bumps
 * COPY_JOB_SCHEMA_VERSION and registers its `fromVersion` migrator in
 * {@link registerCopyJobMigrators} (called at module scope). Per MIG1 there is
 * deliberately NO v1 migrator.
 *
 * Per-cloud: identical Commercial / GCC-High / IL5 — pure metadata in the
 * deployment's own Cosmos. SOVEREIGN MOAT: the copy runs in-boundary (ADF in the
 * deployment's VNet → the deployment's own ADLS Bronze); nothing here leaves the
 * boundary.
 */
import { registerMigrator, type DocMigrator } from '../azure/cosmos-migrations';
import type { CopyTargetKind } from './copy-plan';

export const COPY_JOB_CONTAINER = 'migration-copy-jobs';
export const COPY_JOB_SCHEMA_VERSION = 1;

/** Lifecycle of one object's copy (ADF Copy activity → optional Delta materialize). */
export type CopyObjectStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

/** Lifecycle of the whole copy-in run. */
export type CopyJobStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'gated';

/** Per-object copy result the monitor grid renders (real counts, honest states). */
export interface CopyObjectResult {
  /** Source object reference (`<db>.<schema>.<name>`). */
  source: string;
  /** Loom target table (managed Delta). */
  targetTable: string;
  targetKind: CopyTargetKind;
  status: CopyObjectStatus;
  /** Rows copied by the ADF Copy activity (null until the run reports it). */
  rows: number | null;
  /** ADF Copy activity name backing this object (monitor maps run output → row). */
  activityName: string;
  /** Bronze landing folder (https) for the read-back query. */
  landingPath?: string;
  /** Ready-to-run Synapse Serverless read over the landed data (receipt/editor). */
  readBack?: string;
  /** Honest detail (skip reason, ADF error, materialize note). */
  note?: string;
}

/** The `migration-copy-jobs` doc. */
export interface CopyJobDoc {
  id: string;
  /** Partition key — the owning principal's Entra tenant/oid (Loom tenant scope). */
  tenantId: string;
  docType: 'migration-copy-job';
  /** Stable migration id this copy belongs to. */
  migrationId: string;
  sourceType: string;
  sourceLabel?: string;
  /** ADF pipeline authored for this copy (the run-id receipt anchor). */
  pipelineName?: string;
  /** ADF pipeline run id (createRun) — the monitor queries its activity runs. */
  adfRunId?: string;
  /** Bronze landing root (https) for the whole migration. */
  basePath?: string;
  status: CopyJobStatus;
  objects: CopyObjectResult[];
  totals: { objects: number; succeeded: number; failed: number; rows: number };
  /** Honest gate/error carried to the surface when the run couldn't start. */
  gate?: { missing: string; message: string };
  error?: string;
  startedAt: string;
  updatedAt: string;
  startedBy: string;
  schemaVersion: number;
}

/** Cosmos id for a migration's copy-job doc. */
export function copyJobId(migrationId: string): string {
  return `copy:${String(migrationId).trim()}`;
}

/** Aggregate the per-object results into a job status + totals (PURE). */
export function summarizeCopyJob(objects: CopyObjectResult[]): {
  status: CopyJobStatus; totals: CopyJobDoc['totals'];
} {
  let succeeded = 0, failed = 0, running = 0, rows = 0;
  for (const o of objects) {
    if (o.status === 'succeeded') succeeded += 1;
    else if (o.status === 'failed') failed += 1;
    else if (o.status === 'running' || o.status === 'pending') running += 1;
    if (typeof o.rows === 'number') rows += o.rows;
  }
  const total = objects.length;
  let status: CopyJobStatus;
  if (running > 0) status = 'running';
  else if (failed > 0 && succeeded > 0) status = 'partial';
  else if (failed > 0) status = 'failed';
  else status = 'succeeded';
  return { status, totals: { objects: total, succeeded, failed, rows } };
}

/**
 * MIG1 — register the `migration-copy-jobs` migrator chain. Called at module
 * scope so the chain is in place before cosmos-client materializes any read.
 * There is deliberately NO v1 migrator: version 1 is the initial shape.
 */
export function registerCopyJobMigrators(): void {
  const chain: Array<[number, DocMigrator]> = [];
  for (const [fromVersion, migrate] of chain) {
    registerMigrator(COPY_JOB_CONTAINER, fromVersion, migrate);
  }
}

registerCopyJobMigrators();
