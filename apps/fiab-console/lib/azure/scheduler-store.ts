/**
 * scheduler-store — Cosmos read/write for the CSA Loom UNIFIED job scheduler
 * (rel-T81).
 *
 * Today only `semantic-model/[id]/refresh-schedule` and `notebook/[id]/schedule`
 * exist — two bespoke, per-item scheduling surfaces. This store backs a SINGLE
 * cross-item scheduler: any schedulable Loom item (data-pipeline, notebook,
 * kql-database, warehouse job, …) registers a schedule here, and a server-side
 * tick evaluator triggers the REAL Azure backend run (ADF / Synapse Livy / AML
 * Spark / ADX) via the existing clients (see lib/scheduler/run-adapters.ts) and
 * records the run outcome.
 *
 * Storage: the main `loom` Cosmos database.
 *   • container `schedules`      — PK /tenantId  (one doc per schedule)
 *   • container `schedule-runs`  — PK /scheduleId (run history; 90-day TTL)
 * Both are created on first use (createIfNotExists) so a fresh environment needs
 * no extra ARM/Bicep step beyond the Cosmos account — mirrors
 * business-events-store.ts and cosmos-client.ts.
 *
 * Auth: Console UAMI (LOOM_UAMI_CLIENT_ID) → Cosmos DB Built-in Data Contributor
 * at account scope (the same grant cosmos-client.ts relies on).
 *
 * Tenant isolation: every read/write is scoped by `tenantId` (the caller's Entra
 * `tid`, via tenantScopeId()). A schedule doc's partition key IS its tenantId, so
 * a point-read with the wrong tenant simply misses — no cross-tenant enumeration.
 *
 * No mocks. Real Cosmos data plane. Pure helpers carry no Azure-SDK import.
 */

import type { Container } from '@azure/cosmos';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

/** The job runners the unified scheduler can trigger — all Azure-native. */
export type JobKind = 'adf-pipeline' | 'synapse-livy' | 'aml-spark' | 'adx-command';

export const JOB_KINDS: { kind: JobKind; label: string; backend: string }[] = [
  { kind: 'adf-pipeline', label: 'Data pipeline run', backend: 'Azure Data Factory / Synapse pipeline' },
  { kind: 'synapse-livy', label: 'Spark job (Synapse)', backend: 'Synapse Spark pool (Livy)' },
  { kind: 'aml-spark', label: 'Spark job (Azure ML)', backend: 'Azure ML serverless Spark' },
  { kind: 'adx-command', label: 'ADX command', backend: 'Azure Data Explorer (Kusto)' },
];

export type RunStatus = 'running' | 'succeeded' | 'failed';
export type RunTrigger = 'manual' | 'scheduled';

/** Reference to the Loom item this schedule operates on. */
export interface ScheduleItemRef {
  type: string;
  id: string;
  workspaceId?: string;
}

/**
 * Per-job structured config. Kept as discrete, validated fields (never a raw
 * JSON blob) — each maps 1:1 to a real backend call argument in run-adapters.ts.
 */
export interface ScheduleJobConfig {
  /** adf-pipeline: the ADF/Synapse pipeline name to createRun. */
  pipelineName?: string;
  /** adf-pipeline: typed pipeline parameters. */
  pipelineParameters?: Record<string, unknown>;
  /** synapse-livy / aml-spark: the Spark pool (Livy) to run on. */
  sparkPoolName?: string;
  /** synapse-livy / aml-spark: the code to submit. */
  code?: string;
  /** adx-command: target ADX database. */
  database?: string;
  /** adx-command: the control command (`.` prefixed) or query to run. */
  command?: string;
}

/** Failure-notification config (reuses existing alert/notification plumbing). */
export interface ScheduleNotify {
  onFailure: boolean;
  /** Optional email recipient for failure alerts. */
  email?: string;
  /** Optional webhook URL POSTed on failure. */
  webhook?: string;
}

export interface ScheduleDoc {
  /** Document id — a stable, generated slug. */
  id: string;
  /** Partition key — the caller's Entra tenant id (tenantScopeId). */
  tenantId: string;
  displayName: string;
  itemRef: ScheduleItemRef;
  jobKind: JobKind;
  jobConfig: ScheduleJobConfig;
  /** Standard 5-field cron string (built by the wizard, never free-typed). */
  cron: string;
  /** Windows/IANA time-zone id the cron is evaluated in. */
  timezone: string;
  enabled: boolean;
  notify: ScheduleNotify;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  /** Denormalized last-run summary for fast list rendering. */
  lastRunAt?: string;
  lastStatus?: RunStatus;
  /** Watermark of the last minute the tick evaluator processed this schedule. */
  lastTickAt?: string;
}

export interface RunDoc {
  id: string;
  /** Partition key — the parent schedule id. */
  scheduleId: string;
  tenantId: string;
  trigger: RunTrigger;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  /** Backend run id (ADF runId / AML jobName / Livy statement id). */
  runId?: string;
  /** Terminal exit value surfaced to the UI (result summary / exit code). */
  exitValue?: string;
  /** Genericized failure message (safe to show; never a raw stack). */
  error?: string;
}

const DB_ID = process.env.LOOM_COSMOS_DB || 'loom';
const SCHEDULES_ID = 'schedules';
const RUNS_ID = 'schedule-runs';
const RUNS_TTL_SECS = 7776000; // 90 days — run history auto-evicts

let _client: any = null;
let _schedules: Container | null = null;
let _runs: Container | null = null;

/** Honest config gate — the scheduler store needs a Cosmos endpoint. */
export function schedulerConfigGate(): { missing: string } | null {
  if (!process.env.LOOM_COSMOS_ENDPOINT) return { missing: 'LOOM_COSMOS_ENDPOINT' };
  return null;
}

function endpoint(): string {
  const v = process.env.LOOM_COSMOS_ENDPOINT;
  if (!v) throw new Error('LOOM_COSMOS_ENDPOINT not set — cannot reach the schedule store');
  return v;
}

async function credential() {
  const { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } = await import('@azure/identity');
  const clientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  const chain: any[] = [];
  if (clientId) chain.push(new ManagedIdentityCredential({ clientId }));
  chain.push(new DefaultAzureCredential());
  return new ChainedTokenCredential(new AcaManagedIdentityCredential(), ...chain);
}

async function client(): Promise<any> {
  if (_client) return _client;
  const { CosmosClient } = await import('@azure/cosmos');
  _client = new CosmosClient({ endpoint: endpoint(), aadCredentials: await credential() });
  return _client;
}

async function containers(): Promise<{ schedules: Container; runs: Container }> {
  if (_schedules && _runs) return { schedules: _schedules, runs: _runs };
  const { database } = await (await client()).databases.createIfNotExists({ id: DB_ID });
  const { container: s } = await database.containers.createIfNotExists({
    id: SCHEDULES_ID,
    partitionKey: { paths: ['/tenantId'] },
  });
  const { container: r } = await database.containers.createIfNotExists({
    id: RUNS_ID,
    partitionKey: { paths: ['/scheduleId'] },
    defaultTtl: RUNS_TTL_SECS,
  });
  _schedules = s;
  _runs = r;
  return { schedules: s, runs: r };
}

/** Stable id from a display name + random suffix. */
export function scheduleId(displayName: string): string {
  const slug = (displayName || 'schedule')
    .trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'schedule';
  return `${slug}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ── Schedule CRUD (all tenant-scoped) ───────────────────────────────────────

export async function listSchedules(tenantId: string): Promise<ScheduleDoc[]> {
  const { schedules } = await containers();
  const { resources } = await schedules.items
    .query<ScheduleDoc>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.updatedAt DESC',
      parameters: [{ name: '@t', value: tenantId }],
    })
    .fetchAll();
  return resources ?? [];
}

export async function getSchedule(tenantId: string, id: string): Promise<ScheduleDoc | null> {
  const { schedules } = await containers();
  try {
    const { resource } = await schedules.item(id, tenantId).read<ScheduleDoc>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

export async function upsertSchedule(doc: ScheduleDoc): Promise<ScheduleDoc> {
  const { schedules } = await containers();
  const { resource } = await schedules.items.upsert<ScheduleDoc>(doc);
  return (resource as ScheduleDoc) ?? doc;
}

export async function deleteSchedule(tenantId: string, id: string): Promise<void> {
  const { schedules } = await containers();
  try {
    await schedules.item(id, tenantId).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
}

/**
 * Every ENABLED schedule across ALL tenants — used only by the server-side tick
 * evaluator (which runs as the Console UAMI, not a user session) to find due
 * schedules. Not exposed to any user-facing route.
 */
export async function listAllEnabledSchedules(): Promise<ScheduleDoc[]> {
  const { schedules } = await containers();
  const { resources } = await schedules.items
    .query<ScheduleDoc>('SELECT * FROM c WHERE c.enabled = true')
    .fetchAll();
  return resources ?? [];
}

// ── Run history ─────────────────────────────────────────────────────────────

export async function recordRun(run: RunDoc): Promise<RunDoc> {
  const { runs } = await containers();
  const { resource } = await runs.items.upsert<RunDoc>(run);
  return (resource as RunDoc) ?? run;
}

export async function listRuns(scheduleId: string, limit = 50): Promise<RunDoc[]> {
  const { runs } = await containers();
  const { resources } = await runs.items
    .query<RunDoc>({
      query: 'SELECT TOP @n * FROM c WHERE c.scheduleId = @s ORDER BY c.startedAt DESC',
      parameters: [{ name: '@n', value: Math.min(200, Math.max(1, limit)) }, { name: '@s', value: scheduleId }],
    })
    .fetchAll();
  return resources ?? [];
}
