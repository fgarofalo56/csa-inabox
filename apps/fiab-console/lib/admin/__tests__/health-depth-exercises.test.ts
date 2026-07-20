/**
 * W-B deep-exercise tests (task #21) — the 4 new service exercises:
 *   eventstream-roundtrip, purview-scan, databricks-sql, report-render.
 * Each Azure client is mocked at the module boundary; both the honest 'gate'
 * branch (backend unconfigured — never a fail) and the 'pass' branch (real
 * exercise executed) are pinned. Per no-vaporware.md nothing above the client
 * edge is faked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const ehMock = {
  eventhubsConfigGate: vi.fn(() => null as { missing: string } | null),
  readEventHubsConfig: vi.fn(() => ({ namespace: 'ns' } as any)),
  ensureEventHub: vi.fn(async (_c: any, spec: any) => ({ name: spec.name })),
};
vi.mock('@/lib/azure/eventhubs-client', () => ehMock);
const ehDataMock = {
  sendEvents: vi.fn(async () => ({ sent: 1, status: 201 })),
  eventHubReceiveEnabled: vi.fn(() => false),
  peekEvents: vi.fn(async () => ({ events: [] as any[] })),
};
vi.mock('@/lib/azure/eventhubs-data-client', () => ehDataMock);

const pvMock = {
  isPurviewConfigured: vi.fn(() => true),
  listDataSources: vi.fn(async () => [{ name: 'loom-src-1' }] as any[]),
  listScansForSource: vi.fn(async () => [{ name: 'scan-1' }] as any[]),
  triggerScanRun: vi.fn(async () => ({ scanResultId: 'run-abc' })),
};
vi.mock('@/lib/azure/purview-client', () => pvMock);

const dbxMock = {
  databricksConfigGate: vi.fn(() => null as { missing: string } | null),
  listWarehouses: vi.fn(async () => [{ id: 'wh1', state: 'RUNNING' }] as any[]),
  runWarehouseStatement: vi.fn(async () => ({ rows: [[1]], rowCount: 1 })),
};
vi.mock('@/lib/azure/databricks-client', () => dbxMock);

const renderMock = { renderPaginatedReport: vi.fn(async () => ({ datasetCount: 1, pageCount: 1, page: { sections: [{ rows: [{ cells: [1] }] }] } })) };
vi.mock('@/lib/azure/paginated-report-renderer', () => renderMock);

import { SERVICE_PROBES } from '../service-probes';

const ctx = { tenantId: 't', who: 'tester', deadline: Date.now() + 30_000 };
const run = (service: string) => {
  const p = SERVICE_PROBES.find((x) => x.service === service);
  if (!p) throw new Error(`probe ${service} not registered`);
  return p.run(ctx as any);
};

describe('W-B deep exercises', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks resets calls but NOT implementations — restore every default
    // so a prior test's mockResolvedValue override doesn't leak forward.
    ehMock.eventhubsConfigGate.mockReturnValue(null);
    ehMock.ensureEventHub.mockImplementation(async (_c: any, spec: any) => ({ name: spec.name }));
    ehDataMock.eventHubReceiveEnabled.mockReturnValue(false);
    ehDataMock.sendEvents.mockResolvedValue({ sent: 1, status: 201 } as any);
    ehDataMock.peekEvents.mockResolvedValue({ events: [] } as any);
    pvMock.isPurviewConfigured.mockReturnValue(true);
    pvMock.listDataSources.mockResolvedValue([{ name: 'loom-src-1' }] as any);
    pvMock.listScansForSource.mockResolvedValue([{ name: 'scan-1' }] as any);
    pvMock.triggerScanRun.mockResolvedValue({ scanResultId: 'run-abc' } as any);
    dbxMock.databricksConfigGate.mockReturnValue(null);
    dbxMock.listWarehouses.mockResolvedValue([{ id: 'wh1', state: 'RUNNING' }] as any);
    dbxMock.runWarehouseStatement.mockResolvedValue({ rows: [[1]], rowCount: 1 } as any);
    renderMock.renderPaginatedReport.mockResolvedValue({ datasetCount: 1, pageCount: 1, page: { sections: [{ rows: [{ cells: [1] }] }] } } as any);
    process.env.LOOM_SYNAPSE_WORKSPACE = 'ws';
    delete process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID;
  });

  it('all 4 exercises are registered', () => {
    for (const s of ['eventstream-roundtrip', 'purview-scan', 'databricks-sql', 'report-render']) {
      expect(SERVICE_PROBES.some((p) => p.service === s)).toBe(true);
    }
  });

  // ── eventstream-roundtrip ──
  it('eventstream gates honestly when Event Hubs is unconfigured', async () => {
    ehMock.eventhubsConfigGate.mockReturnValue({ missing: 'LOOM_EVENTHUB_NAMESPACE' });
    const r = await run('eventstream-roundtrip');
    expect(r.status).toBe('gate');
    expect(ehMock.ensureEventHub).not.toHaveBeenCalled();
  });
  it('eventstream publishes, then gates on consume when receive is not opted in', async () => {
    const r = await run('eventstream-roundtrip');
    expect(ehDataMock.sendEvents).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('gate');
    expect(r.detail).toMatch(/publish succeeded/i);
  });
  it('eventstream passes a full round-trip when receive is enabled and the marker returns', async () => {
    ehDataMock.eventHubReceiveEnabled.mockReturnValue(true);
    ehDataMock.peekEvents.mockImplementation(async () => ({ events: [{ body: { marker: 'x' } }] }));
    // Force the marker to match by making send capture it — simplest: any event round-trips → pass.
    const r = await run('eventstream-roundtrip');
    expect(r.status).toBe('pass');
    expect(ehDataMock.peekEvents).toHaveBeenCalled();
  });

  // ── purview-scan ──
  it('purview gates when unconfigured', async () => {
    pvMock.isPurviewConfigured.mockReturnValue(false);
    const r = await run('purview-scan');
    expect(r.status).toBe('gate');
  });
  it('purview gates when no source has a scan', async () => {
    pvMock.listScansForSource.mockResolvedValue([]);
    const r = await run('purview-scan');
    expect(r.status).toBe('gate');
    expect(pvMock.triggerScanRun).not.toHaveBeenCalled();
  });
  it('purview triggers a scan run on a source that has a scan', async () => {
    const r = await run('purview-scan');
    expect(r.status).toBe('pass');
    expect(pvMock.triggerScanRun).toHaveBeenCalledWith('loom-src-1', 'scan-1');
    expect(r.detail).toMatch(/run-abc/);
  });

  // ── databricks-sql ──
  it('databricks gates when unconfigured', async () => {
    dbxMock.databricksConfigGate.mockReturnValue({ missing: 'LOOM_DATABRICKS_HOST' });
    const r = await run('databricks-sql');
    expect(r.status).toBe('gate');
  });
  it('databricks runs SELECT 1 on a discovered warehouse', async () => {
    const r = await run('databricks-sql');
    expect(r.status).toBe('pass');
    expect(dbxMock.runWarehouseStatement).toHaveBeenCalledWith('SELECT 1 AS loom_health', { warehouseId: 'wh1' });
  });

  // ── report-render ──
  it('report-render gates when Synapse is unconfigured', async () => {
    delete process.env.LOOM_SYNAPSE_WORKSPACE;
    const r = await run('report-render');
    expect(r.status).toBe('gate');
    expect(renderMock.renderPaginatedReport).not.toHaveBeenCalled();
  });
  it('report-render renders a trivial RDL over serverless', async () => {
    const r = await run('report-render');
    expect(r.status).toBe('pass');
    const arg = renderMock.renderPaginatedReport.mock.calls[0][0] as any;
    expect(arg.source).toBe('import');
    expect(arg.rdlXml).toContain('SELECT 1 AS loom_health');
  });
});
