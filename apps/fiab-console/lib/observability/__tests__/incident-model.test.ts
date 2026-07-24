import { describe, it, expect } from 'vitest';
import {
  transitionIncident, monitorId, incidentId,
  MONITOR_CONTAINER, INCIDENT_CONTAINER,
} from '@/lib/observability/incident-model';

describe('incident state machine', () => {
  it('open → acknowledge → resolved is the happy path', () => {
    const a = transitionIncident('open', 'acknowledge');
    expect(a).toEqual({ ok: true, nextStatus: 'acknowledged', timelineType: 'acknowledged' });
    const r = transitionIncident('acknowledged', 'resolve');
    expect(r).toEqual({ ok: true, nextStatus: 'resolved', timelineType: 'resolved' });
  });

  it('open can resolve directly', () => {
    expect(transitionIncident('open', 'resolve')).toEqual({ ok: true, nextStatus: 'resolved', timelineType: 'resolved' });
  });

  it('resolved can only reopen (back to open)', () => {
    expect(transitionIncident('resolved', 'reopen')).toEqual({ ok: true, nextStatus: 'open', timelineType: 'reopened' });
    expect(transitionIncident('resolved', 'acknowledge').ok).toBe(false);
    expect(transitionIncident('resolved', 'resolve').ok).toBe(false);
  });

  it('rejects re-acknowledging and reopening a live incident', () => {
    expect(transitionIncident('acknowledged', 'acknowledge').ok).toBe(false);
    expect(transitionIncident('open', 'reopen').ok).toBe(false);
  });

  it('note leaves status unchanged for any state', () => {
    for (const s of ['open', 'acknowledged', 'resolved'] as const) {
      const t = transitionIncident(s, 'note');
      expect(t).toEqual({ ok: true, nextStatus: s, timelineType: 'note' });
    }
  });
});

describe('deterministic ids', () => {
  it('monitorId is stable + slugged per (kind, item, table)', () => {
    const a = monitorId('freshness', 'item-1', 'cat.sch.tbl');
    expect(a).toBe(monitorId('freshness', 'item-1', 'cat.sch.tbl'));
    expect(a).not.toBe(monitorId('volume', 'item-1', 'cat.sch.tbl'));
    expect(a).toMatch(/^monitor:freshness:/);
  });

  it('incidentId dedups per (source, item, key)', () => {
    const a = incidentId('monitor', 'item-1', 'monitor:freshness:item-1:tbl');
    expect(a).toBe(incidentId('monitor', 'item-1', 'monitor:freshness:item-1:tbl'));
    expect(a).not.toBe(incidentId('dq-finding', 'item-1', 'monitor:freshness:item-1:tbl'));
  });

  it('exports the two container ids', () => {
    expect(MONITOR_CONTAINER).toBe('loom-monitors');
    expect(INCIDENT_CONTAINER).toBe('loom-incidents');
  });
});
