/**
 * BFF contract tests for GET /api/admin/rum.
 *
 * Pins the fix for the live route-smoke failure (Actions run 30330893902):
 * /admin/rum answered HTTP 500 because the six KQL queries reference App
 * Insights tables (`AppBrowserTimings`, `AppPageViews`, `AppExceptions`,
 * `AppEvents`) that a workspace only materializes on FIRST INGEST. Until a real
 * browser session lands, Log Analytics rejects the query with 400
 * BadArgumentError / SemanticError SEM0100 — which fell straight through
 * `MonitorNotConfiguredError` into `apiServerError`.
 *
 * The three cases this file locks down (no-vaporware.md):
 *   (a) not configured        → 503 honest gate, unchanged
 *   (b) configured, no data   → 200 with an EMPTY rollup + the missing table
 *                               names, so the panel renders its designed empty
 *                               state (never a 500, never a fake-healthy zero)
 *   (c) genuine failure       → still 500
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'o', upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  tenantScopeId: () => 'tenant-1',
}));

// monitor-client double — keep the REAL error classes + classifier, stub queryLogs.
const queryLogsMock = vi.fn();
vi.mock('@/lib/azure/monitor-client', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, queryLogs: (...a: unknown[]) => queryLogsMock(...a) };
});

// The runtime kill-switch reads Cosmos; it already defaults on failure, but stub
// it so these cases exercise the telemetry path only.
vi.mock('@/lib/admin/runtime-flags', () => ({ runtimeFlag: async () => true }));

import { GET } from '../route';
import { MonitorError, MonitorNotConfiguredError } from '@/lib/azure/monitor-client';

const req = (window = 'P1D') =>
  ({ nextUrl: { searchParams: new URLSearchParams({ window }) } }) as any;

const empty = { columns: [], rows: [], rowCount: 0 };

/** The verbatim Log Analytics answer for a table that has never been ingested. */
const missingTable = (table: string) =>
  new MonitorError('The request had some invalid properties', 400, {
    error: {
      code: 'BadArgumentError',
      message: 'The request had some invalid properties',
      innererror: {
        code: 'SemanticError',
        innererror: {
          code: 'SEM0100',
          message: `'where' operator: Failed to resolve table or column expression named '${table}'`,
        },
      },
    },
  });

beforeEach(() => {
  queryLogsMock.mockReset();
  getSessionMock.mockReturnValue({ claims: { oid: 'o' }, exp: Date.now() / 1000 + 3600 } as any);
  process.env.LOOM_TENANT_ADMIN_OID = 'o';
  // The route is wrapped in the SWR result cache (process-global) — disable it so
  // each case recomputes against its own queryLogs mock instead of a sibling's.
  process.env.LOOM_QUERY_CACHE_DISABLED = '1';
  process.env.LOOM_LOG_ANALYTICS_WORKSPACE_ID = 'ws-guid-123';
});

describe('GET /api/admin/rum', () => {
  it('rejects a window outside the dropdown allow-list', async () => {
    const res = await GET(req('P90D'));
    expect(res.status).toBe(400);
  });

  it('(b) 200 + empty rollup when the App Insights tables were never ingested', async () => {
    // Every browser table is missing — the exact shape of a deployment that has
    // never had a real browser session.
    queryLogsMock.mockImplementation((kql: string) => {
      const table = /^\s*(\w+)/.exec(kql)?.[1] ?? 'AppBrowserTimings';
      return Promise.reject(missingTable(table));
    });

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.rum.loads.views).toBe(0);
    expect(body.rum.errorCount).toBe(0);
    expect(body.rum.routeChanges).toBe(0);
    expect(body.rum.vitals.samples).toBe(0);
    // HONEST about why it is empty — not a silent zero.
    expect(body.rum.missingTables).toEqual(
      expect.arrayContaining(['AppBrowserTimings', 'AppExceptions', 'AppEvents', 'AppPageViews']),
    );
  });

  it('(b) reports only the tables that are actually missing', async () => {
    queryLogsMock.mockImplementation((kql: string) =>
      /^\s*AppPageViews/.test(kql) ? Promise.reject(missingTable('AppPageViews')) : Promise.resolve(empty),
    );
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rum.missingTables).toEqual(['AppPageViews']);
  });

  it('(b) a fully-ingested workspace with zero rows in the window is still 200 and NOT flagged', async () => {
    queryLogsMock.mockResolvedValue(empty);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rum.missingTables).toEqual([]);
    expect(body.rum.loads.views).toBe(0);
  });

  it('(a) 503 honest gate when the workspace env var is unset', async () => {
    queryLogsMock.mockRejectedValue(new MonitorNotConfiguredError(['LOOM_LOG_ANALYTICS_WORKSPACE_ID']));
    const res = await GET(req());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/LOOM_LOG_ANALYTICS_WORKSPACE_ID/);
  });

  it('(a) 503 honest gate naming the role when the UAMI cannot read the workspace', async () => {
    queryLogsMock.mockRejectedValue(
      new MonitorError('The provided credentials have insufficient access', 403, {
        error: { code: 'InsufficientAccessError', message: 'insufficient access' },
      }),
    );
    const res = await GET(req());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/Log Analytics Reader/);
  });

  it('(c) a genuine service failure is STILL a 500 — real errors are never swallowed', async () => {
    queryLogsMock.mockRejectedValue(
      new MonitorError('Internal server error', 500, {
        error: { code: 'InternalServerError', message: 'Internal server error' },
      }),
    );
    const res = await GET(req());
    expect(res.status).toBe(500);
  });
});
