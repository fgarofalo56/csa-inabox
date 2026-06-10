/**
 * Backend contract tests for the AI tile generator (NL → KQL):
 *
 *   POST /api/items/kql-dashboard/[id]/generate-tile
 *
 * The Azure OpenAI call (aoaiCompleteJson) and the ADX I/O (kusto-client) are
 * mocked at their module boundaries; these tests pin the route contract:
 *  - auth gate (401)
 *  - ADX-missing honest gate (503, names the env var)
 *  - AOAI-missing honest gate (503, NoAoaiDeploymentError surfaced)
 *  - happy path: schema grounded → generated {title,kql,viz} → validated by a
 *    real executeQuery → tile returned with its result inlined
 *  - validation-failure path: tile is STILL returned, with validationError set
 *  - management-command rejection (422)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/copilot-config-store', () => ({ loadTenantCopilotConfig: vi.fn(async () => null) }));
vi.mock('@/lib/azure/kusto-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/kusto-client');
  return {
    ...actual,
    executeQuery: vi.fn(),
    loadKustoItem: vi.fn(),
    getDatabaseSchemaJson: vi.fn(),
    listTables: vi.fn(async () => []),
    resolveDashboardDatabase: vi.fn(async () => 'loomdb-default'),
    kustoConfigGate: vi.fn(() => null),
  };
});
vi.mock('@/lib/azure/copilot-orchestrator', async () => {
  const actual: any = await vi.importActual('@/lib/azure/copilot-orchestrator');
  return {
    ...actual,
    aoaiCompleteJson: vi.fn(),
    resolveAoaiTarget: vi.fn(async () => ({ endpoint: 'https://x', deployment: 'gpt-4o', apiVersion: 'v' })),
  };
});

import { getSession } from '@/lib/auth/session';
import {
  executeQuery, loadKustoItem, getDatabaseSchemaJson, kustoConfigGate,
} from '@/lib/azure/kusto-client';
import {
  aoaiCompleteJson, resolveAoaiTarget, NoAoaiDeploymentError,
} from '@/lib/azure/copilot-orchestrator';
import { POST } from '../[id]/generate-tile/route';

const ctx = { params: Promise.resolve({ id: 'dash-1' }) };
function jsonReq(body: any) { return { json: async () => body } as any; }

const RESULT = { columns: ['c'], columnTypes: ['long'], rows: [[5]], rowCount: 1, executionMs: 2, truncated: false };
const SCHEMA = { Databases: { 'loomdb-default': { Tables: { Events: { OrderedColumns: [{ Name: 'Timestamp', CslType: 'datetime' }, { Name: 'Service', CslType: 'string' }] } } } } };

beforeEach(() => {
  vi.resetAllMocks();
  (kustoConfigGate as any).mockReturnValue(null);
  (resolveAoaiTarget as any).mockResolvedValue({ endpoint: 'https://x', deployment: 'gpt-4o', apiVersion: 'v' });
  (loadKustoItem as any).mockResolvedValue({ id: 'dash-1', workspaceId: 'w', itemType: 'kql-dashboard', displayName: 'D', state: {} });
  (getDatabaseSchemaJson as any).mockResolvedValue(SCHEMA);
  (executeQuery as any).mockResolvedValue(RESULT);
});

describe('POST /api/items/kql-dashboard/[id]/generate-tile', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await POST(jsonReq({ prompt: 'x' }), ctx);
    expect(res.status).toBe(401);
  });

  it('400 when prompt is empty', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o' } });
    const res = await POST(jsonReq({ prompt: '   ' }), ctx);
    expect(res.status).toBe(400);
  });

  it('503 honest gate when ADX is not configured (names the env var)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o' } });
    (kustoConfigGate as any).mockReturnValue({ missing: 'LOOM_KUSTO_CLUSTER_URI' });
    const res = await POST(jsonReq({ prompt: 'count events' }), ctx);
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toContain('LOOM_KUSTO_CLUSTER_URI');
  });

  it('503 honest gate when no AOAI deployment is configured', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o' } });
    (resolveAoaiTarget as any).mockRejectedValue(new NoAoaiDeploymentError('Deploy a gpt-4o model first.'));
    const res = await POST(jsonReq({ prompt: 'count events' }), ctx);
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.error).toContain('Deploy a gpt-4o');
  });

  it('generates a validated tile grounded on the live schema', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o' } });
    (aoaiCompleteJson as any).mockResolvedValue({
      title: 'Events per service',
      kql: 'Events | where Timestamp between (_startTime .. _endTime) | summarize count() by Service',
      viz: 'column',
    });
    const res = await POST(jsonReq({ prompt: 'events per service' }), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.schemaGrounded).toBe(true);
    expect(j.validated).toBe(true);
    expect(j.tile.viz).toBe('column');
    expect(j.tile.title).toBe('Events per service');
    expect(j.tile.result).toEqual(RESULT);
    // The schema summary the model saw must include the real table+columns.
    const sysAndUser = (aoaiCompleteJson as any).mock.calls[0][0];
    expect(JSON.stringify(sysAndUser)).toContain('Events(Timestamp:datetime, Service:string)');
    // The validation run binds _startTime/_endTime so the KQL is executable.
    const [, executedKql] = (executeQuery as any).mock.calls[0];
    expect(executedKql).toContain('let _startTime =');
    expect(executedKql).toContain('let _endTime = now();');
  });

  it('still returns the tile when validation fails, with validationError set', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o' } });
    (aoaiCompleteJson as any).mockResolvedValue({ title: 'Bad', kql: 'NoSuchTable | count', viz: 'stat' });
    (executeQuery as any).mockRejectedValue(new Error("'NoSuchTable' could not be resolved"));
    const res = await POST(jsonReq({ prompt: 'bad query' }), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.validated).toBe(false);
    expect(j.validationError).toContain('NoSuchTable');
    expect(j.tile.kql).toBe('NoSuchTable | count');
    expect(j.tile.result).toBeUndefined();
  });

  it('422 when the model returns a management command', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o' } });
    (aoaiCompleteJson as any).mockResolvedValue({ title: 'X', kql: '.show tables', viz: 'table' });
    const res = await POST(jsonReq({ prompt: 'list tables' }), ctx);
    expect(res.status).toBe(422);
  });

  it('falls back to a bare table list when schema JSON is empty', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o' } });
    (getDatabaseSchemaJson as any).mockResolvedValue(null);
    const { listTables } = await import('@/lib/azure/kusto-client');
    (listTables as any).mockResolvedValue([{ name: 'Events' }, { name: 'Metrics' }]);
    (aoaiCompleteJson as any).mockResolvedValue({ title: 'C', kql: 'Events | count', viz: 'stat' });
    const res = await POST(jsonReq({ prompt: 'count' }), ctx);
    const j = await res.json();
    expect(j.schemaGrounded).toBe(true);
    const sysAndUser = (aoaiCompleteJson as any).mock.calls[0][0];
    expect(JSON.stringify(sysAndUser)).toContain('Events');
  });
});
