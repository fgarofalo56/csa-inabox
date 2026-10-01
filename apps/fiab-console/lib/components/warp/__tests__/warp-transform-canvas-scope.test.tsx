/**
 * Warp transform canvas on a serverless SQL pool target, for a caller who is
 * not a tenant admin.
 *
 * The visual-query route item-scopes a serverless SQL pool for that caller: it
 * runs one read-only SELECT in master and refuses anything else with
 * `{ ok:false, code, error, remediation }`. The canvas must show that refusal
 * with its remediation (the SQL editors' shared bar), and say up front what
 * runs, instead of a bare red "Run failed".
 *
 * What breaks each case:
 *   - scope note: the `!isAdmin` or the serverless-engine condition dropped
 *     (note shown to an admin, or on a dedicated pool target), or the note
 *     removed (a non-admin on a serverless target sees none).
 *   - run refusal: the canvas not routing a refusal through `isSqlRefusal` /
 *     `SqlRefusalOrError` (the remediation is lost and "Run failed" shows).
 *   - other failure: every failure turned into a refusal (the red "Run failed"
 *     bar disappears for an error that is not a refusal).
 *   - validate refusal: the validate path showing the refusal a second time as
 *     a bare warning string.
 *   - describe refusal: the column lookup keeping only `j.error` (the
 *     remediation is lost).
 *
 * `@xyflow/react` is stubbed as in `assets-canvas.test.tsx` (the real engine
 * OOMs the jsdom fork); the canvas component and its run wiring are real.
 *
 * The refusals here are sentinel bodies, so each case can tell the error from
 * the remediation. The route's own text on the canvas, and the Sink graph that
 * turns Run and Validate off, are in `warp-transform-canvas-route.test.tsx`,
 * which answers the canvas with the real route.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

import { WarpTransformCanvas, type WarpRunTarget } from '../warp-transform-canvas';

const POOL: WarpRunTarget = { id: 'pool-1', label: 'Pool (serverless)', engine: 'synapse-serverless-sql-pool', dialect: 'tsql', workspaceId: 'ws-1' };
const DEDICATED: WarpRunTarget = { id: 'synapse-dedicated', label: 'Dedicated', engine: 'synapse-dedicated-sql-pool', dialect: 'tsql' };
const GRAPH = { nodes: [{ id: 'src1', kind: 'source', inputs: [], schema: 'INFORMATION_SCHEMA', table: 'TABLES' }], outputId: 'src1' } as any;

const REFUSAL = {
  ok: false,
  code: 'query_construct_not_accepted',
  error: 'This editor runs read-only SELECT queries. Refused-3317 is not accepted.',
  remediation: 'Query the lakehouse in its SQL tab. Remediation-3317.',
};

let runBody: unknown = REFUSAL;
const calls: string[] = [];

function installFetch() {
  calls.length = 0;
  vi.spyOn(global, 'fetch').mockImplementation((async (url: any) => {
    const u = String(url);
    calls.push(u);
    return new Response(JSON.stringify(u.includes('/visual-query') ? runBody : { ok: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as any);
}

function mount(isTenantAdmin: boolean, targets: WarpRunTarget[] = [POOL], graph: any = GRAPH) {
  installFetch();
  render(
    <FluentProvider theme={webLightTheme}>
      <SessionProvider value={{ authenticated: true, user: null, isTenantAdmin, loading: false }}>
        <WarpTransformCanvas targets={targets} workspaces={[{ id: 'ws-1', name: 'WS' }]} initialGraph={graph} />
      </SessionProvider>
    </FluentProvider>,
  );
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); runBody = REFUSAL; });

describe('Warp canvas, serverless SQL pool target, caller who is not a tenant admin', () => {
  it('says what runs on a serverless SQL pool', () => {
    mount(false);
    const note = screen.getByTestId('warp-serverless-scope');
    expect(note.textContent).toContain('read-only SELECT in master');
    expect(note.textContent).toContain('INFORMATION_SCHEMA');
    expect(note.textContent).toContain('This limit is temporary');
  });

  it('shows no scope note to a tenant admin, or on a dedicated SQL pool target (the canvas still renders)', () => {
    mount(true);
    expect(screen.getByRole('button', { name: /Run \/ Preview/ })).toBeTruthy();
    expect(screen.queryByTestId('warp-serverless-scope')).toBeNull();
    cleanup();
    mount(false, [DEDICATED]);
    expect(screen.getByRole('button', { name: /Run \/ Preview/ })).toBeTruthy();
    expect(screen.queryByTestId('warp-serverless-scope')).toBeNull();
  });

  it('shows a refused run as "Query not run" with the route\'s remediation, not "Run failed"', async () => {
    mount(false);
    fireEvent.click(screen.getByRole('button', { name: /Run \/ Preview/ }));
    await waitFor(() => expect(document.body.textContent).toContain('Remediation-3317'), { timeout: 5000 });
    const text = document.body.textContent || '';
    expect(text).toContain('Query not run');
    expect(text).toContain('Refused-3317');
    expect(text).not.toContain('Run failed');
    // The run posted to the ITEM's visual-query route (no ambient id).
    expect(calls.some((u) => u.includes('/api/items/synapse-serverless-sql-pool/pool-1/visual-query'))).toBe(true);
  });

  it('keeps an ordinary failure as the red "Run failed" bar (positive half)', async () => {
    runBody = { ok: false, error: 'Invalid object name Sentinel-4410.' };
    mount(false);
    fireEvent.click(screen.getByRole('button', { name: /Run \/ Preview/ }));
    await waitFor(() => expect(document.body.textContent).toContain('Sentinel-4410'), { timeout: 5000 });
    expect(document.body.textContent).toContain('Run failed');
    expect(document.body.textContent).not.toContain('Query not run');
  });

  it('shows a refused Validate once, with the remediation', async () => {
    mount(false);
    fireEvent.click(screen.getByRole('button', { name: /^Validate$/ }));
    await waitFor(() => expect(document.body.textContent).toContain('Remediation-3317'), { timeout: 5000 });
    const text = document.body.textContent || '';
    expect(text).toContain('Query not run');
    // The error text appears once: the validate bar does not repeat it.
    expect(text.split('Refused-3317').length - 1).toBe(1);
  });

  it('shows a refused column lookup with the remediation', async () => {
    mount(false, [POOL], { nodes: [], outputId: '' });
    fireEvent.click(screen.getAllByRole('button', { name: /Add a source/ })[0]);
    const table = await screen.findByPlaceholderText('fact_sale');
    fireEvent.change(table, { target: { value: 'TABLES' } });
    fireEvent.click(screen.getByRole('button', { name: /^Add source$/ }));
    await waitFor(() => expect(document.body.textContent).toContain('Remediation-3317'), { timeout: 5000 });
    expect(document.body.textContent).toContain('Query not run');
  });
});
