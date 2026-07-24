/**
 * N17 — incident store (SERVER-ONLY). Owns the incident lifecycle over two
 * vendor-neutral signal producers: N17's own monitors and N7d's data-quality
 * findings (CONSUMED via listDqFindings — never re-derived).
 *
 * AUDIT convention (BLOCKING): every privileged mutation emits its audit event
 * FIRST, synchronously, BEFORE the awaited Cosmos write (emitAuditEvent is the
 * fan-out; the `_auditLog` row is the durable record written right after). A
 * state change that never reaches Cosmos is still attributable.
 *
 * O1 alert standard: incident opens/escalations route through
 * `dispatchAlert` (lib/azure/alert-dispatch.ts → the ONE shared action group) —
 * no parallel action group. Best-effort; a failed alert never fails the write.
 *
 * Azure-native, in-boundary Cosmos — the detect→open→ack→resolve loop runs fully
 * disconnected in an air-gapped IL5 enclave (no SaaS incident service). MOAT:
 * collector (monitors) + console (incidents) + anomaly detection are entirely
 * in-boundary; no external ML / SaaS is ever contacted.
 */

import { incidentsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { dispatchAlert, type AlertSeverity } from '@/lib/azure/alert-dispatch';
import { listDqFindings } from '@/lib/azure/dq-finding-store';
import type { DqFindingDoc } from '@/lib/azure/dq-finding-model';
import {
  INCIDENT_SCHEMA_VERSION,
  MAX_INCIDENT_TIMELINE,
  incidentId,
  transitionIncident,
  type IncidentDoc,
  type IncidentAction,
  type IncidentSource,
  type IncidentStatus,
  type IncidentTimelineEntry,
} from './incident-model';
import type { MonitorSeverity, MonitorVerdict } from './incident-monitor-model';

/** Runbook the ux-baseline "Runbook →" link points at (repo-relative doc). */
export const INCIDENT_RUNBOOK_PATH = 'docs/fiab/runbooks/data-incident.md';

/** Actor context for the audit trail (from the admin session). */
export interface IncidentActor {
  oid: string;
  who: string;
  tenantId: string;
}

/** Map an incident severity to the O1 alert severity band. */
function alertSeverityFor(sev: MonitorSeverity): AlertSeverity {
  if (sev === 'error') return 'P2';
  if (sev === 'warning') return 'P3';
  return 'P3';
}

function appendTimeline(doc: IncidentDoc, entry: IncidentTimelineEntry): void {
  doc.timeline = [...(doc.timeline || []), entry].slice(-MAX_INCIDENT_TIMELINE);
}

// ── Read ─────────────────────────────────────────────────────────────────────

export interface ListIncidentsOpts {
  status?: IncidentStatus;
  /** Restrict to one source item. */
  itemId?: string;
  limit?: number;
}

/** List a tenant's incidents newest-first (single-partition query on /tenantId). */
export async function listIncidents(tenantId: string, opts: ListIncidentsOpts = {}): Promise<IncidentDoc[]> {
  const c = await incidentsContainer();
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 200), 1000));
  const filters = ['c.tenantId = @t', "c.docType = 'incident'"];
  const params: Array<{ name: string; value: unknown }> = [{ name: '@t', value: tenantId }];
  if (opts.status) { filters.push('c.status = @s'); params.push({ name: '@s', value: opts.status }); }
  if (opts.itemId) { filters.push('c.itemId = @i'); params.push({ name: '@i', value: opts.itemId }); }
  const query = `SELECT * FROM c WHERE ${filters.join(' AND ')} ORDER BY c.updatedAt DESC OFFSET 0 LIMIT ${limit}`;
  const { resources } = await c.items.query<IncidentDoc>({ query, parameters: params as never }).fetchAll();
  return resources;
}

export async function getIncident(tenantId: string, id: string): Promise<IncidentDoc | null> {
  const c = await incidentsContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<IncidentDoc>();
    return resource ?? null;
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 404) return null;
    throw e;
  }
}

// ── Open / update (from a monitor verdict) ───────────────────────────────────

export interface OpenIncidentInput {
  source: IncidentSource;
  severity: MonitorSeverity;
  dedupKey: string;
  itemId: string;
  itemType: string;
  workspaceId?: string;
  table?: string;
  monitorId?: string;
  monitorKind?: IncidentDoc['monitorKind'];
  title: string;
  detail: string;
  metric?: IncidentDoc['metric'];
  schemaChange?: IncidentDoc['schemaChange'];
  findingIds?: string[];
}

/**
 * Open a NEW incident, or UPDATE the still-open incident with the same dedup key
 * (recurrence: bump occurrences + refresh detail, keep the timeline). A resolved
 * incident with the same key is REOPENED. Every path is audited (emit-first) and
 * the open/reopen fires an O1 alert.
 */
export async function openOrUpdateIncident(input: OpenIncidentInput, actor: IncidentActor): Promise<IncidentDoc> {
  const c = await incidentsContainer();
  const id = incidentId(input.source, input.itemId, input.dedupKey);
  const now = new Date().toISOString();

  let existing: IncidentDoc | null = null;
  try {
    const { resource } = await c.item(id, actor.tenantId).read<IncidentDoc>();
    existing = resource ?? null;
  } catch (e: unknown) {
    if ((e as { code?: number })?.code !== 404) throw e;
  }

  let doc: IncidentDoc;
  let action: 'opened' | 'reopened' | 'updated';
  if (!existing) {
    action = 'opened';
    doc = {
      id,
      tenantId: actor.tenantId,
      docType: 'incident',
      schemaVersion: INCIDENT_SCHEMA_VERSION,
      status: 'open',
      severity: input.severity,
      source: input.source,
      dedupKey: input.dedupKey,
      itemId: input.itemId,
      itemType: input.itemType,
      workspaceId: input.workspaceId,
      table: input.table,
      monitorId: input.monitorId,
      monitorKind: input.monitorKind,
      title: input.title,
      detail: input.detail,
      metric: input.metric,
      schemaChange: input.schemaChange,
      findingIds: input.findingIds,
      timeline: [],
      runbookUrl: INCIDENT_RUNBOOK_PATH,
      openedAt: now,
      updatedAt: now,
      occurrences: 1,
    };
    appendTimeline(doc, { at: now, type: 'opened', by: actor.who, actorOid: actor.oid, note: input.detail.slice(0, 500) });
  } else if (existing.status === 'resolved') {
    action = 'reopened';
    doc = {
      ...existing,
      status: 'open',
      severity: input.severity,
      title: input.title,
      detail: input.detail,
      metric: input.metric,
      schemaChange: input.schemaChange,
      findingIds: mergeIds(existing.findingIds, input.findingIds),
      updatedAt: now,
      resolvedAt: undefined,
      acknowledgedAt: undefined,
      occurrences: (existing.occurrences || 1) + 1,
    };
    appendTimeline(doc, { at: now, type: 'reopened', by: actor.who, actorOid: actor.oid, note: 'signal re-fired' });
  } else {
    action = 'updated';
    doc = {
      ...existing,
      severity: input.severity,
      title: input.title,
      detail: input.detail,
      metric: input.metric,
      schemaChange: input.schemaChange,
      findingIds: mergeIds(existing.findingIds, input.findingIds),
      updatedAt: now,
      occurrences: (existing.occurrences || 1) + 1,
    };
    appendTimeline(doc, { at: now, type: 'updated', by: actor.who, actorOid: actor.oid, note: 'signal re-fired while open' });
  }

  // AUDIT FIRST (synchronous fan-out), THEN the awaited Cosmos write.
  emitAuditEvent({
    actorOid: actor.oid,
    actorUpn: actor.who,
    action: `incident.${action}`,
    targetType: 'incident',
    targetId: id,
    outcome: 'success',
    tenantId: actor.tenantId,
    timestamp: now,
    detail: { severity: input.severity, source: input.source, dedupKey: input.dedupKey, itemId: input.itemId },
  });
  await c.items.upsert(doc);
  await writeAuditRow(actor, `incident.${action}`, doc);

  // O1 alert on open/reopen only (an update while-open doesn't re-page).
  if (action !== 'updated') {
    await dispatchAlert({
      source: 'data-observability',
      severity: alertSeverityFor(input.severity),
      title: `[${input.severity}] ${input.title}`,
      body: input.detail,
      dedupKey: `data-observability:${id}`,
    }).catch(() => undefined);
  }
  return doc;
}

// ── Transition (ack / resolve / reopen / note) ───────────────────────────────

export interface TransitionOutcome {
  ok: boolean;
  incident?: IncidentDoc;
  error?: string;
  status?: number;
}

/**
 * Apply a lifecycle transition. Runs the PURE state machine
 * ({@link transitionIncident}); on a legal transition it appends a timeline
 * entry, audits (emit-first), and writes. An illegal transition returns a 409
 * with the state-machine's precise error (no write, no audit).
 */
export async function transitionIncidentStatus(
  tenantId: string,
  id: string,
  action: IncidentAction,
  actor: IncidentActor,
  note?: string,
): Promise<TransitionOutcome> {
  const incident = await getIncident(tenantId, id);
  if (!incident) return { ok: false, error: 'incident not found', status: 404 };

  const t = transitionIncident(incident.status, action);
  if (!t.ok) return { ok: false, error: t.error, status: 409 };

  const now = new Date().toISOString();
  const next: IncidentDoc = { ...incident, status: t.nextStatus, updatedAt: now };
  if (t.nextStatus === 'acknowledged') next.acknowledgedAt = now;
  if (t.nextStatus === 'resolved') next.resolvedAt = now;
  if (t.timelineType === 'reopened') { next.resolvedAt = undefined; next.acknowledgedAt = undefined; }
  appendTimeline(next, { at: now, type: t.timelineType, by: actor.who, actorOid: actor.oid, ...(note ? { note: note.slice(0, 1000) } : {}) });

  const c = await incidentsContainer();
  // AUDIT FIRST, THEN the Cosmos write.
  emitAuditEvent({
    actorOid: actor.oid,
    actorUpn: actor.who,
    action: `incident.${action}`,
    targetType: 'incident',
    targetId: id,
    outcome: 'success',
    tenantId,
    timestamp: now,
    detail: { from: incident.status, to: t.nextStatus, ...(note ? { note } : {}) },
  });
  await c.items.upsert(next);
  await writeAuditRow(actor, `incident.${action}`, next, note);
  return { ok: true, incident: next };
}

// ── N7d finding consumer ─────────────────────────────────────────────────────

/**
 * CONSUME N7d data-quality findings into incidents (N7d is the PRODUCER; N17 is
 * the CONSUMER — we do NOT re-run any check). Reads the tenant's OPEN findings,
 * groups them by (itemId, checkKey), and opens/updates ONE incident per group,
 * folding the finding ids in. Idempotent (deterministic incident id).
 */
export async function consumeFindingsIntoIncidents(actor: IncidentActor, opts: { limit?: number } = {}): Promise<{ opened: number; groups: number }> {
  const findings = await listDqFindings(actor.tenantId, { openOnly: true, limit: opts.limit ?? 500 });
  const groups = new Map<string, DqFindingDoc[]>();
  for (const f of findings) {
    const key = `${f.itemId}::${f.checkKey}`;
    (groups.get(key) || groups.set(key, []).get(key)!).push(f);
  }
  let opened = 0;
  for (const [, list] of groups) {
    const worst = list.reduce((a, b) => (severityRank(b.severity) > severityRank(a.severity) ? b : a));
    await openOrUpdateIncident(
      {
        source: 'dq-finding',
        severity: worst.severity,
        dedupKey: worst.checkKey,
        itemId: worst.itemId,
        itemType: worst.itemType,
        workspaceId: worst.workspaceId,
        table: worst.target?.table,
        title: worst.title,
        detail: `${list.length} data-quality finding(s) on ${worst.target?.table || worst.itemType}: ${worst.detail}`,
        metric: worst.metric
          ? {
            name: worst.metric.name,
            value: worst.metric.value,
            baselineMean: worst.metric.baselineMean,
            baselineStddev: worst.metric.baselineStddev,
            zScore: worst.metric.zScore,
            threshold: worst.metric.threshold,
          }
          : undefined,
        findingIds: list.map((f) => f.id),
      },
      actor,
    );
    opened += 1;
  }
  return { opened, groups: groups.size };
}

/**
 * Promote a tripped MONITOR verdict into an incident (or update the open one).
 * A HEALTHY verdict is a no-op here — the monitor store closes/leaves incidents.
 */
export async function openIncidentFromMonitor(
  verdict: MonitorVerdict,
  ctx: { monitorId: string; itemId: string; itemType: string; workspaceId?: string; table: string },
  actor: IncidentActor,
): Promise<IncidentDoc | null> {
  if (!verdict.tripped) return null;
  return openOrUpdateIncident(
    {
      source: 'monitor',
      severity: verdict.severity,
      dedupKey: ctx.monitorId,
      itemId: ctx.itemId,
      itemType: ctx.itemType,
      workspaceId: ctx.workspaceId,
      table: ctx.table,
      monitorId: ctx.monitorId,
      monitorKind: verdict.kind,
      title: verdict.title,
      detail: verdict.detail,
      metric: verdict.metric,
      schemaChange: verdict.schemaChange,
    },
    actor,
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function severityRank(s: MonitorSeverity): number {
  return s === 'error' ? 3 : s === 'warning' ? 2 : 1;
}

function mergeIds(a?: string[], b?: string[]): string[] | undefined {
  const merged = [...new Set([...(a || []), ...(b || [])])];
  return merged.length ? merged : undefined;
}

/** Durable `_auditLog` row (written AFTER the emit fan-out + the mutation). */
async function writeAuditRow(actor: IncidentActor, action: string, doc: IncidentDoc, note?: string): Promise<void> {
  try {
    const al = await auditLogContainer();
    await al.items.create({
      id: crypto.randomUUID(),
      tenantId: actor.tenantId,
      itemId: doc.itemId || 'observability',
      itemType: 'incident',
      action,
      summary: `${action} — ${doc.title}`.slice(0, 400),
      incidentId: doc.id,
      status: doc.status,
      severity: doc.severity,
      ...(note ? { note: note.slice(0, 1000) } : {}),
      upn: actor.who,
      actorOid: actor.oid,
      at: doc.updatedAt,
    });
  } catch {
    /* audit best-effort; the emit fan-out already carried the event */
  }
}
