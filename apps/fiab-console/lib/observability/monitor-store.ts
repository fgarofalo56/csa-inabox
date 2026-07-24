/**
 * N17 — monitor store (SERVER-ONLY). Per-table freshness / volume / schema-drift
 * monitors: config CRUD (audited) + the observation feed + run→evaluate→trip.
 *
 * DEFAULT-ON (loom_default_on_opt_out): a registered monitor is `enabled` unless
 * an operator flips it off — never a spend/config gate. Baselines REUSE the N7d
 * anomaly detector (incident-monitor-model → dq-anomaly-baseline); no external ML.
 *
 * Each observation is recorded on the monitor's own rolling window (bounded so
 * the doc stays < 2 MB). Recording evaluates the monitor against its history and,
 * when it trips, opens/updates an incident (openIncidentFromMonitor → the O1
 * alert + emit-first audit). Azure-native, in-boundary Cosmos; the whole loop is
 * IL5-safe and disconnected-capable.
 */

import { monitorsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import {
  MONITOR_SCHEMA_VERSION,
  MAX_MONITOR_OBSERVATIONS,
  monitorId,
  type MonitorDoc,
  type StoredObservation,
} from './incident-model';
import { evaluateMonitor, type MonitorConfig, type MonitorKind, type MonitorObservation, type MonitorVerdict } from './incident-monitor-model';
import { openIncidentFromMonitor, type IncidentActor } from './incident-store';
import type { IncidentDoc } from './incident-model';

export interface MonitorActor {
  oid: string;
  who: string;
  tenantId: string;
}

/** List a tenant's monitors (single-partition query on /tenantId). */
export async function listMonitors(tenantId: string, opts: { itemId?: string } = {}): Promise<MonitorDoc[]> {
  const c = await monitorsContainer();
  const filters = ['c.tenantId = @t', "c.docType = 'monitor'"];
  const params: Array<{ name: string; value: unknown }> = [{ name: '@t', value: tenantId }];
  if (opts.itemId) { filters.push('c.itemId = @i'); params.push({ name: '@i', value: opts.itemId }); }
  const query = `SELECT * FROM c WHERE ${filters.join(' AND ')} ORDER BY c.updatedAt DESC`;
  const { resources } = await c.items.query<MonitorDoc>({ query, parameters: params as never }).fetchAll();
  return resources;
}

export async function getMonitor(tenantId: string, id: string): Promise<MonitorDoc | null> {
  const c = await monitorsContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<MonitorDoc>();
    return resource ?? null;
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 404) return null;
    throw e;
  }
}

export interface UpsertMonitorInput {
  kind: MonitorKind;
  itemId: string;
  itemType: string;
  workspaceId?: string;
  table: string;
  enabled?: boolean;
  freshnessSlaMinutes?: number;
  window?: number;
  zThreshold?: number;
  minSamplesForZ?: number;
  relThreshold?: number;
  absFloor?: number;
}

/**
 * Create or update a monitor (idempotent per deterministic id). DEFAULT-ON: a
 * new monitor is enabled unless `enabled:false` is passed. Audited (emit-first).
 */
export async function upsertMonitor(input: UpsertMonitorInput, actor: MonitorActor): Promise<MonitorDoc> {
  const c = await monitorsContainer();
  const id = monitorId(input.kind, input.itemId, input.table);
  const now = new Date().toISOString();
  let existing: MonitorDoc | null = null;
  try {
    const { resource } = await c.item(id, actor.tenantId).read<MonitorDoc>();
    existing = resource ?? null;
  } catch (e: unknown) {
    if ((e as { code?: number })?.code !== 404) throw e;
  }
  const doc: MonitorDoc = {
    id,
    tenantId: actor.tenantId,
    docType: 'monitor',
    schemaVersion: MONITOR_SCHEMA_VERSION,
    kind: input.kind,
    enabled: input.enabled ?? existing?.enabled ?? true,
    itemId: input.itemId,
    itemType: input.itemType,
    workspaceId: input.workspaceId ?? existing?.workspaceId,
    table: input.table,
    freshnessSlaMinutes: input.freshnessSlaMinutes ?? existing?.freshnessSlaMinutes,
    window: input.window ?? existing?.window,
    zThreshold: input.zThreshold ?? existing?.zThreshold,
    minSamplesForZ: input.minSamplesForZ ?? existing?.minSamplesForZ,
    relThreshold: input.relThreshold ?? existing?.relThreshold,
    absFloor: input.absFloor ?? existing?.absFloor,
    observations: existing?.observations ?? [],
    lastRunAt: existing?.lastRunAt,
    lastValue: existing?.lastValue,
    openIncidentId: existing?.openIncidentId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    createdBy: existing?.createdBy ?? actor.who,
  };
  emitAuditEvent({
    actorOid: actor.oid,
    actorUpn: actor.who,
    action: existing ? 'monitor.update' : 'monitor.create',
    targetType: 'monitor',
    targetId: id,
    outcome: 'success',
    tenantId: actor.tenantId,
    timestamp: now,
    detail: { kind: input.kind, itemId: input.itemId, table: input.table, enabled: doc.enabled },
  });
  await c.items.upsert(doc);
  await writeMonitorAudit(actor, existing ? 'monitor.update' : 'monitor.create', doc);
  return doc;
}

function configFromDoc(doc: MonitorDoc): MonitorConfig {
  return {
    kind: doc.kind,
    freshnessSlaMinutes: doc.freshnessSlaMinutes,
    window: doc.window,
    zThreshold: doc.zThreshold,
    minSamplesForZ: doc.minSamplesForZ,
    relThreshold: doc.relThreshold,
    absFloor: doc.absFloor,
  };
}

export interface RecordObservationInput {
  value: number;
  columns?: string[];
  at?: string;
}

export interface MonitorRunResult {
  monitor: MonitorDoc;
  verdict: MonitorVerdict;
  incident?: IncidentDoc | null;
}

/**
 * Record a new observation, evaluate the monitor against its PRIOR history, and
 * (when tripped + enabled) open/update an incident. The observation is appended
 * to the rolling window AFTER evaluation so the current value never pollutes its
 * own baseline. Returns the verdict + any incident. Persists the monitor doc.
 */
export async function recordObservation(
  tenantId: string,
  id: string,
  obs: RecordObservationInput,
  actor: IncidentActor,
): Promise<MonitorRunResult | null> {
  const monitor = await getMonitor(tenantId, id);
  if (!monitor) return null;

  const at = obs.at || new Date().toISOString();
  const current: MonitorObservation = { at, value: obs.value, ...(obs.columns ? { columns: obs.columns } : {}) };
  const history: MonitorObservation[] = (monitor.observations || []).map((o) => ({ at: o.at, value: o.value, ...(o.columns ? { columns: o.columns } : {}) }));

  const verdict = evaluateMonitor(configFromDoc(monitor), current, history);

  // Append the observation (newest-last) and cap the window.
  const stored: StoredObservation = { at, value: obs.value, ...(obs.columns ? { columns: obs.columns } : {}) };
  monitor.observations = [...(monitor.observations || []), stored].slice(-MAX_MONITOR_OBSERVATIONS);
  monitor.lastRunAt = at;
  monitor.lastValue = obs.value;

  let incident: IncidentDoc | null = null;
  // Only an ENABLED monitor opens incidents (disabled = opt-out kill-switch).
  if (monitor.enabled && verdict.tripped) {
    incident = await openIncidentFromMonitor(
      verdict,
      { monitorId: monitor.id, itemId: monitor.itemId, itemType: monitor.itemType, workspaceId: monitor.workspaceId, table: monitor.table },
      actor,
    );
    monitor.openIncidentId = incident?.id;
  }

  const c = await monitorsContainer();
  await c.items.upsert(monitor);
  return { monitor, verdict, incident };
}

/** Durable `_auditLog` row for a monitor mutation (best-effort). */
async function writeMonitorAudit(actor: MonitorActor, action: string, doc: MonitorDoc): Promise<void> {
  try {
    const al = await auditLogContainer();
    await al.items.create({
      id: crypto.randomUUID(),
      tenantId: actor.tenantId,
      itemId: doc.itemId,
      itemType: 'monitor',
      action,
      summary: `${action} — ${doc.kind} monitor on ${doc.table}`.slice(0, 400),
      monitorId: doc.id,
      enabled: doc.enabled,
      upn: actor.who,
      actorOid: actor.oid,
      at: doc.updatedAt,
    });
  } catch {
    /* audit best-effort; emitAuditEvent already fanned the event out */
  }
}
