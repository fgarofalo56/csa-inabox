import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mocks ────────────────────────────────────────────────────────────────────
const emitAuditEventMock = vi.hoisted(() => vi.fn());
const dispatchAlertMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const listDqFindingsMock = vi.hoisted(() => vi.fn(async () => [] as any[]));

vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: emitAuditEventMock }));
vi.mock('@/lib/azure/alert-dispatch', () => ({ dispatchAlert: dispatchAlertMock }));
vi.mock('@/lib/azure/dq-finding-store', () => ({ listDqFindings: listDqFindingsMock }));

function makeContainer() {
  const store = new Map<string, any>();
  return {
    _store: store,
    item(id: string) {
      return {
        async read<T>() {
          const d = store.get(id);
          if (d === undefined) { const e: any = new Error('nf'); e.code = 404; throw e; }
          return { resource: d as T };
        },
      };
    },
    items: {
      async upsert(doc: any) { store.set(doc.id, doc); return { resource: doc }; },
      async create(doc: any) { store.set(doc.id, doc); return { resource: doc }; },
      query() { return { async fetchAll() { return { resources: [...store.values()] }; } }; },
    },
  };
}

const monitors = makeContainer();
const incidents = makeContainer();
const auditLog = makeContainer();

vi.mock('@/lib/azure/cosmos-client', () => ({
  monitorsContainer: async () => monitors,
  incidentsContainer: async () => incidents,
  auditLogContainer: async () => auditLog,
}));

import { recordObservation, upsertMonitor } from '@/lib/observability/monitor-store';
import { transitionIncidentStatus, consumeFindingsIntoIncidents, listIncidents } from '@/lib/observability/incident-store';
import { monitorId } from '@/lib/observability/incident-model';

const actor = { oid: 'tenant-1', who: 'admin@contoso.com', tenantId: 'tenant-1' };

beforeEach(() => {
  monitors._store.clear();
  incidents._store.clear();
  auditLog._store.clear();
  emitAuditEventMock.mockClear();
  dispatchAlertMock.mockClear();
  listDqFindingsMock.mockReset();
  listDqFindingsMock.mockResolvedValue([]);
});

describe('recordObservation → incident', () => {
  it('a stale freshness observation opens an incident + fires the O1 alert', async () => {
    await upsertMonitor({ kind: 'freshness', itemId: 'i1', itemType: 'lakehouse', table: 'cat.sch.orders', freshnessSlaMinutes: 60 }, actor);
    const id = monitorId('freshness', 'i1', 'cat.sch.orders');

    const result = await recordObservation('tenant-1', id, { value: 500 }, actor); // 500 min > 60 SLA
    expect(result).toBeTruthy();
    expect(result!.verdict.tripped).toBe(true);
    expect(result!.incident).toBeTruthy();
    expect(result!.incident!.status).toBe('open');
    // O1 alert routed through dispatchAlert (the one shared action group).
    expect(dispatchAlertMock).toHaveBeenCalledTimes(1);
    // audit emitted for the incident open.
    expect(emitAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'incident.opened' }));
    // The incident is persisted + listable.
    const list = await listIncidents('tenant-1');
    expect(list.some((i) => i.id === result!.incident!.id)).toBe(true);
  });

  it('a healthy observation does NOT open an incident', async () => {
    await upsertMonitor({ kind: 'freshness', itemId: 'i2', itemType: 'lakehouse', table: 't2', freshnessSlaMinutes: 1440 }, actor);
    const id = monitorId('freshness', 'i2', 't2');
    const result = await recordObservation('tenant-1', id, { value: 10 }, actor);
    expect(result!.verdict.tripped).toBe(false);
    expect(result!.incident).toBeNull();
    expect(dispatchAlertMock).not.toHaveBeenCalled();
  });

  it('a disabled monitor never opens incidents (opt-out kill-switch)', async () => {
    await upsertMonitor({ kind: 'freshness', itemId: 'i3', itemType: 'lakehouse', table: 't3', freshnessSlaMinutes: 60, enabled: false }, actor);
    const id = monitorId('freshness', 'i3', 't3');
    const result = await recordObservation('tenant-1', id, { value: 999 }, actor);
    expect(result!.verdict.tripped).toBe(true); // still evaluates
    expect(result!.incident).toBeNull();        // but opens nothing
  });
});

describe('incident transitions (each audited)', () => {
  async function openOne(): Promise<string> {
    await upsertMonitor({ kind: 'freshness', itemId: 'i9', itemType: 'lakehouse', table: 't9', freshnessSlaMinutes: 60 }, actor);
    const mid = monitorId('freshness', 'i9', 't9');
    const r = await recordObservation('tenant-1', mid, { value: 999 }, actor);
    return r!.incident!.id;
  }

  it('acknowledge → resolve appends audited timeline entries', async () => {
    const id = await openOne();
    emitAuditEventMock.mockClear();

    const ack = await transitionIncidentStatus('tenant-1', id, 'acknowledge', actor);
    expect(ack.ok).toBe(true);
    expect(ack.incident!.status).toBe('acknowledged');
    expect(emitAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'incident.acknowledge' }));

    const res = await transitionIncidentStatus('tenant-1', id, 'resolve', actor, 'root cause fixed');
    expect(res.ok).toBe(true);
    expect(res.incident!.status).toBe('resolved');
    const last = res.incident!.timeline.at(-1)!;
    expect(last.type).toBe('resolved');
    expect(last.note).toBe('root cause fixed');
  });

  it('an illegal transition returns 409 and does NOT audit or write', async () => {
    const id = await openOne();
    await transitionIncidentStatus('tenant-1', id, 'resolve', actor); // → resolved
    emitAuditEventMock.mockClear();

    const bad = await transitionIncidentStatus('tenant-1', id, 'acknowledge', actor); // resolved can't ack
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe(409);
    expect(emitAuditEventMock).not.toHaveBeenCalled();
  });

  it('404 for an unknown incident', async () => {
    const r = await transitionIncidentStatus('tenant-1', 'incident:monitor:nope', 'acknowledge', actor);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });
});

describe('N7d finding consumer', () => {
  it('groups open findings into incidents (idempotent, folds finding ids)', async () => {
    listDqFindingsMock.mockResolvedValue([
      { id: 'finding:r1:rule-check:a', itemId: 'iX', itemType: 'data-quality', checkKey: 'not_null', severity: 'error', title: 'nulls', detail: 'null rate high', target: { table: 'cat.sch.x', engine: 'synapse' } },
      { id: 'finding:r2:rule-check:a', itemId: 'iX', itemType: 'data-quality', checkKey: 'not_null', severity: 'warning', title: 'nulls', detail: 'null rate', target: { table: 'cat.sch.x', engine: 'synapse' } },
      { id: 'finding:r1:rule-check:b', itemId: 'iX', itemType: 'data-quality', checkKey: 'unique', severity: 'error', title: 'dupes', detail: 'dup keys', target: { table: 'cat.sch.x', engine: 'synapse' } },
    ]);
    const r = await consumeFindingsIntoIncidents(actor);
    expect(r.groups).toBe(2);   // (iX,not_null) + (iX,unique)
    expect(r.opened).toBe(2);
    const list = await listIncidents('tenant-1');
    const nn = list.find((i) => i.dedupKey === 'not_null');
    expect(nn).toBeTruthy();
    expect(nn!.source).toBe('dq-finding');
    expect(nn!.severity).toBe('error'); // worst-of the group
    expect(nn!.findingIds).toEqual(expect.arrayContaining(['finding:r1:rule-check:a', 'finding:r2:rule-check:a']));
  });
});
