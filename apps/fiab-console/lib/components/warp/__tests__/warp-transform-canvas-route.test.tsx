/**
 * Warp transform canvas on a serverless SQL pool target, against the REAL
 * visual-query route: `fetch` is answered by the route's own `POST` (only the
 * session, item lookup, storage and SQL client are stood in, as in
 * `app/api/items/synapse-serverless-sql-pool/__tests__/visual-query-scope.test.ts`),
 * so every refusal shown here is the text the route produces, not a fixture.
 *
 * What breaks each case:
 *   - Sink graph, non-admin: Run and Validate not turned off (the button is
 *     live, or a click posts), the reason not shown, or the buttons removed
 *     from the tab order (native `disabled` instead of `disabledFocusable`).
 *   - positive halves: the Sink check applied to a tenant admin, to a dedicated
 *     SQL pool target, or to a Sink that names no table (a plain SELECT the
 *     route runs).
 *   - real refusal: the route wording a visual query as the SQL editor
 *     ("This editor …"), or the canvas not showing the route's remediation.
 *
 * Not killable, stated here: the canvas also drops Run's `onClick` while the
 * Sink check holds, but Fluent's `disabledFocusable` already swallows the
 * click, so keeping the handler changes nothing a test can see (an equivalent
 * mutant, measured). The "posts nothing" assertion pins the outcome; the
 * dropped handler keeps the canvas from depending on that Fluent detail.
 *
 * `@xyflow/react` is stubbed as in `warp-transform-canvas-scope.test.tsx`; the
 * canvas component and its run wiring are real.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { SessionProvider } from '@/lib/components/session-context';

vi.mock('@xyflow/react', async () => {
  const R = await vi.importActual<typeof import('react')>('react');
  const Passthrough = ({ children }: { children?: React.ReactNode }) => R.createElement('div', null, children);
  return {
    ReactFlow: ({ children }: any) => R.createElement('div', { 'data-testid': 'rf-canvas' }, children),
    ReactFlowProvider: Passthrough,
    Background: () => null,
    MiniMap: () => null,
    Panel: Passthrough,
    Handle: () => null,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    BackgroundVariant: { Dots: 'dots' },
    useReactFlow: () => ({
      zoomIn: vi.fn(), zoomOut: vi.fn(), fitView: vi.fn(),
      setViewport: vi.fn(), getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    }),
    useNodesState: (init: any[]) => { const [v, set] = R.useState(init); return [v, set, vi.fn()]; },
    useEdgesState: (init: any[]) => { const [v, set] = R.useState(init); return [v, set, vi.fn()]; },
    useNodesInitialized: () => true,
    useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  };
});
vi.mock('@/lib/components/editor/monaco-textarea', () => ({ MonacoTextarea: () => null }));

// ---- the route's dependencies (server side) ----
const SESSION = { claims: { oid: 'oid-reader', tid: 'tid-1', upn: 'r@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION, tenantScopeId: () => 'tid-1' }));
vi.mock('@/lib/auth/pdp/enforce', () => ({ pdpCheck: vi.fn(async () => null) }));
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeItemWorkspace: vi.fn(async () => null) }));
const admin = vi.hoisted(() => ({ isTenantAdmin: vi.fn(() => false) }));
vi.mock('@/lib/auth/feature-gate', async () => ({
  ...(await vi.importActual<any>('@/lib/auth/feature-gate')),
  isTenantAdmin: admin.isTenantAdmin,
}));
const POOL_ITEM = { id: 'pool-1', itemType: 'synapse-serverless-sql-pool', workspaceId: 'ws-1', displayName: 'P', state: {} };
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          if (/c\.itemType = 'lakehouse'/.test(spec.query)) return { resources: [] };
          const params: Record<string, unknown> = Object.fromEntries(
            (spec.parameters ?? []).map((p: any) => [p.name, p.value]),
          );
          const hit = params['@id'] === POOL_ITEM.id && params['@t'] === POOL_ITEM.itemType;
          return { resources: hit ? [POOL_ITEM] : [] };
        },
      }),
    },
  }),
}));
const synapse = vi.hoisted(() => ({
  executeQuery: vi.fn(async (..._a: any[]) => ({
    columns: ['a'], rows: [[1]], rowCount: 1, executionMs: 3, truncated: false, messages: [],
  })),
  executeQueryAsUser: vi.fn(),
  serverlessTarget: vi.fn((database = 'master') => ({ server: 's', database, cacheKey: `k:${database}` })),
  dedicatedTarget: vi.fn(() => ({ server: 'd', database: 'pool', cacheKey: 'dedicated:pool' })),
  serverlessEndpoint: () => 's.sql.azuresynapse.net',
  getSynapseSqlSuffix: () => 'sql.azuresynapse.net',
}));
vi.mock('@/lib/azure/synapse-sql-client', () => synapse);
vi.mock('@/lib/azure/synapse-pool-arm', () => ({ getPoolState: vi.fn(async () => ({ state: 'Online' })) }));
vi.mock('@/lib/azure/sql-access-mode', () => ({ resolveAccessMode: vi.fn(async () => 'service') }));
vi.mock('@/lib/azure/sql-user-token-store', () => ({ getUserSqlToken: vi.fn(async () => null) }));
vi.mock('@/lib/azure/databricks-client', () => ({ executeStatement: vi.fn(), getWarehouse: vi.fn() }));

import { POST } from '@/app/api/items/[type]/[id]/visual-query/route';
import { VISUAL_QUERY_SURFACE } from '@/app/api/items/synapse-serverless-sql-pool/_lib/visual-query-surface';
import { WarpTransformCanvas, SERVERLESS_SINK_REASON, type WarpRunTarget } from '../warp-transform-canvas';

const POOL: WarpRunTarget = { id: 'pool-1', label: 'Pool (serverless)', engine: 'synapse-serverless-sql-pool', dialect: 'tsql', workspaceId: 'ws-1' };
const DEDICATED: WarpRunTarget = { id: 'dp-1', label: 'Dedicated', engine: 'synapse-dedicated-sql-pool', dialect: 'tsql' };

function sinkGraph(table = 'out_t'): any {
  return {
    nodes: [
      { id: 's1', kind: 'source', inputs: [], schema: 'INFORMATION_SCHEMA', table: 'TABLES' },
      { id: 'k1', kind: 'sink', inputs: ['s1'], sink: { mode: 'table', table } },
    ],
    outputId: 'k1',
  };
}
const SYS_GRAPH: any = { nodes: [{ id: 's1', kind: 'source', inputs: [], schema: 'sys', table: 'databases' }], outputId: 's1' };

const routeCalls: string[] = [];
const routeBodies: any[] = [];

/** Answer `/visual-query` with the real route handler; anything else with `{ ok: true }`. */
function installRouteFetch() {
  routeCalls.length = 0;
  routeBodies.length = 0;
  vi.spyOn(global, 'fetch').mockImplementation((async (url: any, init?: any) => {
    const u = String(url);
    const m = u.match(/\/api\/items\/([^/]+)\/([^/]+)\/visual-query/);
    if (!m) return Response.json({ ok: true });
    routeCalls.push(u);
    const body = JSON.parse(String(init?.body ?? '{}'));
    routeBodies.push(body);
    const full = new URL(u, 'http://x/');
    const req = { url: full.toString(), nextUrl: full, json: async () => body } as any;
    return POST(req, { params: Promise.resolve({ type: m[1], id: decodeURIComponent(m[2]) }) } as any);
  }) as any);
}

function mount(isTenantAdmin: boolean, graph: any, targets: WarpRunTarget[] = [POOL]) {
  admin.isTenantAdmin.mockReturnValue(isTenantAdmin);
  installRouteFetch();
  render(
    <FluentProvider theme={webLightTheme}>
      <SessionProvider value={{ authenticated: true, user: null, isTenantAdmin, loading: false }}>
        <WarpTransformCanvas targets={targets} workspaces={[{ id: 'ws-1', name: 'WS' }]} initialGraph={graph} />
      </SessionProvider>
    </FluentProvider>,
  );
}

const runButton = () => screen.getByRole('button', { name: /Run \/ Preview/ });
const validateButton = () => screen.getByRole('button', { name: /^Validate$/ });

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Warp canvas against the real visual-query route, serverless SQL pool target', () => {
  it('a graph ending in a Sink turns Run and Validate off for a caller who is not a tenant admin, with the reason, and posts nothing', async () => {
    mount(false, sinkGraph());
    for (const b of [runButton(), validateButton()]) {
      expect(b.getAttribute('aria-disabled')).toBe('true');
      // Focusable: native `disabled` would take it out of the tab order.
      expect(b.hasAttribute('disabled')).toBe(false);
      expect(b.getAttribute('title')).toBe(SERVERLESS_SINK_REASON);
      fireEvent.click(b);
    }
    const bar = screen.getByTestId('warp-sink-not-run');
    expect(bar.textContent).toContain(
      'Sinks are not run on a serverless target for your role: remove the Sink, or pick a warehouse or dedicated pool target',
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(routeCalls).toEqual([]);
    expect(synapse.executeQuery).not.toHaveBeenCalled();
  });

  it('a tenant admin\'s Sink graph is not turned off, and Run reaches the route (positive half)', async () => {
    mount(true, sinkGraph());
    expect(screen.queryByTestId('warp-sink-not-run')).toBeNull();
    expect(runButton().getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(runButton());
    await waitFor(() => expect(synapse.executeQuery).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(routeCalls[0]).toContain('/api/items/synapse-serverless-sql-pool/pool-1/visual-query');
  });

  it('a Sink graph on a dedicated SQL pool target is not turned off (positive half)', () => {
    mount(false, sinkGraph(), [DEDICATED]);
    expect(screen.queryByTestId('warp-sink-not-run')).toBeNull();
    expect(runButton().getAttribute('aria-disabled')).not.toBe('true');
    expect(validateButton().getAttribute('aria-disabled')).not.toBe('true');
  });

  it('a Sink that names no table is a plain SELECT: Run stays on and the route runs it (positive half)', async () => {
    mount(false, sinkGraph(''));
    expect(screen.queryByTestId('warp-sink-not-run')).toBeNull();
    fireEvent.click(runButton());
    await waitFor(() => expect(synapse.executeQuery).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(synapse.executeQuery.mock.calls[0][0].cacheKey).toBe('sql-pool-reader:k:master');
  });

  it('a refusal shown on the canvas is the route\'s own text, worded for a visual query, with its remediation', async () => {
    mount(false, SYS_GRAPH);
    fireEvent.click(runButton());
    await waitFor(() => expect(document.body.textContent).toContain('Query not run'), { timeout: 5000 });
    const text = document.body.textContent || '';
    // The route's lead for this surface, and the sys-schema rule it applied.
    expect(text).toContain(VISUAL_QUERY_SURFACE.lead.trim());
    expect(text).toContain('The sys schema object sys.databases is not accepted');
    expect(text).toContain('INFORMATION_SCHEMA.TABLES');
    // 'This editor' means the route worded the canvas as the SQL editor.
    expect(text).not.toContain('This editor runs');
    expect(text).not.toContain('Run failed');
    // The refusal answered the Run (a graph), not a column lookup.
    expect(routeBodies.some((b) => b.graph && !b.describe)).toBe(true);
    expect(synapse.executeQuery).not.toHaveBeenCalled();
  });
});
