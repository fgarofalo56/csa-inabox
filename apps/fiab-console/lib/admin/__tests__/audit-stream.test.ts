import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildAuditRow,
  auditStreamConfig,
  postAuditEvents,
  emitAuditEvent,
  AUDIT_STREAM,
  AUDIT_INGESTION_API_VERSION,
  type AdminAuditEvent,
} from '../audit-stream';

/**
 * BR-SIEM audit-stream emitter — unit tests.
 *
 * Per no-vaporware.md we do NOT fake the Azure Monitor Logs Ingestion backend:
 * the real POST path (token acquisition + fetch) needs a live UAMI + DCR and is
 * exercised in deployment. Here we assert the two behaviours that are pure /
 * deterministic and load-bearing: (1) the honest un-provisioned no-op gate, and
 * (2) the exact LoomAudit_CL row shape the ingestion API expects.
 */

const SAMPLE: AdminAuditEvent = {
  actorOid: 'oid-123',
  actorUpn: 'admin@contoso.gov',
  action: 'feature-grant.upsert',
  targetType: 'feature-grant',
  targetId: 'admin.permissions::user::u1',
  tenantId: 'tid-999',
  detail: { capabilityId: 'admin.permissions', role: 'Admin' },
};

describe('audit-stream — honest gate (un-provisioned = silent no-op)', () => {
  const saved = { ep: process.env.LOOM_AUDIT_DCR_ENDPOINT, id: process.env.LOOM_AUDIT_DCR_ID };
  beforeEach(() => {
    delete process.env.LOOM_AUDIT_DCR_ENDPOINT;
    delete process.env.LOOM_AUDIT_DCR_ID;
  });
  afterEach(() => {
    if (saved.ep === undefined) delete process.env.LOOM_AUDIT_DCR_ENDPOINT; else process.env.LOOM_AUDIT_DCR_ENDPOINT = saved.ep;
    if (saved.id === undefined) delete process.env.LOOM_AUDIT_DCR_ID; else process.env.LOOM_AUDIT_DCR_ID = saved.id;
  });

  it('auditStreamConfig() returns null when either env var is unset', () => {
    expect(auditStreamConfig()).toBeNull();
    process.env.LOOM_AUDIT_DCR_ENDPOINT = 'https://dce.example.ingest.monitor.azure.com';
    // still missing the DCR id
    expect(auditStreamConfig()).toBeNull();
  });

  it('auditStreamConfig() resolves + trims when both are set', () => {
    process.env.LOOM_AUDIT_DCR_ENDPOINT = 'https://dce.example.ingest.monitor.azure.com/';
    process.env.LOOM_AUDIT_DCR_ID = 'dcr-abc123';
    expect(auditStreamConfig()).toEqual({
      endpoint: 'https://dce.example.ingest.monitor.azure.com', // trailing slash stripped
      dcrId: 'dcr-abc123',
    });
  });

  it('postAuditEvents() no-ops (sent:0, skipped) when un-provisioned — never posts', async () => {
    const res = await postAuditEvents([SAMPLE]);
    expect(res).toEqual({ sent: 0, skipped: 'not-configured' });
  });

  it('postAuditEvents() short-circuits on an empty batch', async () => {
    process.env.LOOM_AUDIT_DCR_ENDPOINT = 'https://dce.example.ingest.monitor.azure.com';
    process.env.LOOM_AUDIT_DCR_ID = 'dcr-abc123';
    expect(await postAuditEvents([])).toEqual({ sent: 0, skipped: 'empty' });
  });

  it('emitAuditEvent() never throws, even un-provisioned', () => {
    expect(() => emitAuditEvent(SAMPLE)).not.toThrow();
  });
});

describe('audit-stream — buildAuditRow payload shape', () => {
  it('maps every AdminAuditEvent field to its LoomAudit_CL column', () => {
    const row = buildAuditRow({ ...SAMPLE, timestamp: '2026-07-08T12:00:00.000Z' });
    expect(row).toEqual({
      TimeGenerated: '2026-07-08T12:00:00.000Z',
      ActorOid: 'oid-123',
      ActorUpn: 'admin@contoso.gov',
      Action: 'feature-grant.upsert',
      TargetType: 'feature-grant',
      TargetId: 'admin.permissions::user::u1',
      Outcome: 'success', // defaulted
      Detail: JSON.stringify({ capabilityId: 'admin.permissions', role: 'Admin' }),
      TenantId: 'tid-999',
    });
  });

  it('defaults TimeGenerated to an ISO string and Outcome to success', () => {
    const row = buildAuditRow({ ...SAMPLE, detail: undefined });
    expect(new Date(row.TimeGenerated).toISOString()).toBe(row.TimeGenerated);
    expect(row.Outcome).toBe('success');
    expect(row.Detail).toBe(''); // undefined detail → empty string
  });

  it('passes a string detail through verbatim and honours an explicit outcome', () => {
    const row = buildAuditRow({ ...SAMPLE, detail: 'raw-note', outcome: 'denied' });
    expect(row.Detail).toBe('raw-note');
    expect(row.Outcome).toBe('denied');
  });

  it('exposes the stream name + API version the ingestion URL is built from', () => {
    expect(AUDIT_STREAM).toBe('Custom-LoomAudit_CL');
    expect(AUDIT_INGESTION_API_VERSION).toBe('2023-01-01');
  });
});
