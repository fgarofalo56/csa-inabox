/**
 * BFF + unit tests for the F20 Refresh-summary route.
 *
 * Per .claude/rules/no-vaporware.md these exercise the REAL route handler with
 * the Azure/Cosmos backends mocked — pinning auth, the honest Log-Analytics
 * gate, the happy-path shape, and the pure next-run projection from a real ADF
 * ScheduleTrigger recurrence. No DOM-only assertions.
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import type { AdfTrigger } from '@/lib/azure/adf-client';

// Loaded dynamically (see beforeAll) so route.ts is imported AFTER the mock
// factories + their helper classes have initialized — a top-level static
// import would eager-load route.ts before the Fake* classes exist.
let computeNextRun: typeof import('@/app/api/admin/refresh-summary/route')['computeNextRun'];
let GET: typeof import('@/app/api/admin/refresh-summary/route')['GET'];

// --------------------------------------------------------------------------
// mocks
// --------------------------------------------------------------------------

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'tenant-oid', upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

class FakeMonitorNotConfigured extends Error {
  missing: string[];
  constructor(missing: string[]) { super('Monitor not configured'); this.missing = missing; }
}
const queryLogsMock = vi.fn();
vi.mock('@/lib/azure/monitor-client', () => ({
  queryLogs: (...a: any[]) => queryLogsMock(...a),
  MonitorNotConfiguredError: FakeMonitorNotConfigured,
  MonitorError: class extends Error { status = 500; },
}));

const adfConfigGateMock = vi.fn(() => null as { missing: string } | null);
const listTriggersMock = vi.fn(async () => [] as AdfTrigger[]);
vi.mock('@/lib/azure/adf-client', () => ({
  adfConfigGate: () => adfConfigGateMock(),
  listTriggers: () => listTriggersMock(),
}));

const itemsQuery = vi.fn(async () => ({ resources: [] as any[] }));
const wsQuery = vi.fn(async () => ({ resources: [] as any[] }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({ items: { query: () => ({ fetchAll: itemsQuery }) } }),
  workspacesContainer: async () => ({ items: { query: () => ({ fetchAll: wsQuery }) } }),
}));

function req(url: string) {
  const u = new URL(url, 'http://localhost');
  return { url: u.toString(), nextUrl: u } as any;
}

beforeAll(async () => {
  const mod = await import('@/app/api/admin/refresh-summary/route');
  computeNextRun = mod.computeNextRun;
  GET = mod.GET;
});

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'tenant-oid', upn: 'a@b.com' }, exp: Date.now() / 1000 + 3600 } as any);
  // #1602 gates behind requireTenantAdmin — authorize the test session as the
  // bootstrap tenant admin (the 401 spec sets session=null and still 401s).
  process.env.LOOM_TENANT_ADMIN_OID = 'tenant-oid';
  adfConfigGateMock.mockReturnValue(null);
  listTriggersMock.mockResolvedValue([]);
  itemsQuery.mockResolvedValue({ resources: [] });
  wsQuery.mockResolvedValue({ resources: [] });
  queryLogsMock.mockReset();
  delete process.env.LOOM_SYNAPSE_WORKSPACE;
});

afterEach(() => { vi.clearAllMocks(); });

// --------------------------------------------------------------------------
// computeNextRun (pure)
// --------------------------------------------------------------------------

function schedule(props: Partial<AdfTrigger['properties']>): AdfTrigger {
  return { name: 't', properties: { type: 'ScheduleTrigger', runtimeState: 'Started', ...props } } as AdfTrigger;
}

describe('computeNextRun', () => {
  const now = Date.UTC(2026, 5, 9, 10, 0, 0); // 2026-06-09T10:00:00Z

  it('projects the next hourly occurrence past now', () => {
    const t = schedule({
      typeProperties: { recurrence: { frequency: 'Hour', interval: 4, startTime: '2026-06-09T00:00:00Z' } },
    });
    // anchors at 00:00, +4h steps → 00,04,08,12 → first past 10:00 is 12:00
    expect(computeNextRun(t, now)).toBe('2026-06-09T12:00:00.000Z');
  });

  it('returns the anchor itself when it is in the future', () => {
    const t = schedule({
      typeProperties: { recurrence: { frequency: 'Day', interval: 1, startTime: '2026-06-10T02:00:00Z' } },
    });
    expect(computeNextRun(t, now)).toBe('2026-06-10T02:00:00.000Z');
  });

  it('returns null for a stopped trigger', () => {
    const t = schedule({
      runtimeState: 'Stopped',
      typeProperties: { recurrence: { frequency: 'Hour', interval: 1, startTime: '2026-06-09T00:00:00Z' } },
    });
    expect(computeNextRun(t, now)).toBeNull();
  });

  it('returns null for a tumbling-window (non-schedule) trigger', () => {
    const t = { name: 'tw', properties: { type: 'TumblingWindowTrigger', runtimeState: 'Started' } } as AdfTrigger;
    expect(computeNextRun(t, now)).toBeNull();
  });

  it('returns null for Month frequency (calendar cadence not modelled)', () => {
    const t = schedule({
      typeProperties: { recurrence: { frequency: 'Month', interval: 1, startTime: '2026-01-01T00:00:00Z' } },
    });
    expect(computeNextRun(t, now)).toBeNull();
  });
});

// --------------------------------------------------------------------------
// route
// --------------------------------------------------------------------------

describe('GET /api/admin/refresh-summary', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null);
    expect((await GET(req('/api/admin/refresh-summary'))).status).toBe(401);
  });

  it('honest gate when Log Analytics is not configured', async () => {
    queryLogsMock.mockImplementation(() => { throw new FakeMonitorNotConfigured(['LOOM_LOG_ANALYTICS_WORKSPACE_ID']); });
    const j = await (await GET(req('/api/admin/refresh-summary'))).json();
    expect(j.ok).toBe(false);
    expect(j.gate.missing).toContain('LOOM_LOG_ANALYTICS_WORKSPACE_ID');
  });

  it('returns real run history rows with status + duration, and a schedule next-run', async () => {
    // ADF LA result: one Succeeded run.
    queryLogsMock.mockResolvedValue({
      columns: ['PipelineName', 'RunId', 'Status', 'Start', 'End', 'ErrorCode', 'ErrorMessage'],
      rows: [['nightly-orders', 'run-123', 'Succeeded', '2026-06-09T02:00:00Z', '2026-06-09T02:14:00Z', null, null]],
      rowCount: 1,
    });
    listTriggersMock.mockResolvedValue([
      {
        name: 'nightly-trigger',
        properties: {
          type: 'ScheduleTrigger',
          runtimeState: 'Started',
          pipelines: [{ pipelineReference: { referenceName: 'nightly-orders', type: 'PipelineReference' } }],
          typeProperties: { recurrence: { frequency: 'Day', interval: 1, startTime: '2026-06-09T02:00:00Z' } },
        },
      } as AdfTrigger,
    ]);
    const j = await (await GET(req('/api/admin/refresh-summary?days=7'))).json();
    expect(j.ok).toBe(true);
    expect(j.adfConfigured).toBe(true);
    expect(j.total).toBe(1);
    const row = j.rows[0];
    expect(row.pipelineName).toBe('nightly-orders');
    expect(row.lastRunStatus).toBe('Succeeded');
    expect(row.lastRunDurationMs).toBe(14 * 60_000);
    expect(row.triggerName).toBe('nightly-trigger');
    expect(typeof row.nextRunAt).toBe('string');
  });

  it('applies the status filter server-side', async () => {
    queryLogsMock.mockResolvedValue({
      columns: ['PipelineName', 'RunId', 'Status', 'Start', 'End', 'ErrorCode', 'ErrorMessage'],
      rows: [
        ['ok-pl', 'r1', 'Succeeded', '2026-06-09T02:00:00Z', '2026-06-09T02:05:00Z', null, null],
        ['bad-pl', 'r2', 'Failed', '2026-06-09T03:00:00Z', '2026-06-09T03:01:00Z', 'E1', 'boom'],
      ],
      rowCount: 2,
    });
    const j = await (await GET(req('/api/admin/refresh-summary?status=Failed'))).json();
    expect(j.total).toBe(1);
    expect(j.rows[0].pipelineName).toBe('bad-pl');
    expect(j.rows[0].lastRunError).toContain('boom');
  });

  it('still returns run history when ADF is not configured (next-run omitted)', async () => {
    adfConfigGateMock.mockReturnValue({ missing: 'LOOM_ADF_NAME' });
    queryLogsMock.mockResolvedValue({
      columns: ['PipelineName', 'RunId', 'Status', 'Start', 'End', 'ErrorCode', 'ErrorMessage'],
      rows: [['pl', 'r1', 'Succeeded', '2026-06-09T02:00:00Z', '2026-06-09T02:05:00Z', null, null]],
      rowCount: 1,
    });
    const j = await (await GET(req('/api/admin/refresh-summary'))).json();
    expect(j.ok).toBe(true);
    expect(j.adfConfigured).toBe(false);
    expect(j.rows[0].nextRunAt).toBeUndefined();
    expect(listTriggersMock).not.toHaveBeenCalled();
  });
});
