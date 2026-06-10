/**
 * EventstreamEditor — code-first T-SQL operator tab.
 *
 * Confirms the SQL-operator surface is real (no-vaporware):
 *   - the "SQL operator" tab renders the Monaco T-SQL editor + named-sinks
 *     manager loaded from GET /sql-operator
 *   - Compile POSTs { action: 'compile' } and renders the compiler receipt
 *   - per-output Test POSTs { action: 'test', outputAlias } and renders the
 *     produced rows in a grid
 *   - Apply sinks POSTs { action: 'apply-sinks' } and renders the ASA-output
 *     receipt
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { EventstreamEditor } from '../phase3-editors';
import { makeItem, installFetchMock } from './test-helpers';

describe('EventstreamEditor — SQL operator tab', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    const m = installFetchMock({
      '/api/loom/workspaces': () => ({ ok: true, workspaces: [{ id: 'ws-1', name: 'Default Workspace' }] }),
      '/api/items/eventstream/es-fixture/sql-operator': (_u, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (body.action === 'compile') {
          return { ok: true, valid: true, errors: [], warnings: [], outputs: ['hot-path', 'aggregates'] };
        }
        if (body.action === 'test') {
          return { ok: true, outputAlias: body.outputAlias, status: 'Success', rows: [{ eventType: 'order', amount: 42 }] };
        }
        if (body.action === 'apply-sinks') {
          return { ok: true, asaJobName: 'asa-loom-default-eastus2', outputs: [{ name: 'hot-path', type: 'Microsoft.Kusto/clusters/databases', id: '/arm/hot-path' }] };
        }
        if (body.action === 'save') {
          return { ok: true, sqlOperator: body, asaPushed: true };
        }
        // GET
        return {
          ok: true,
          sqlOperator: {
            query: 'SELECT * INTO [hot-path] FROM [eventstream-input];',
            sinks: [{ alias: 'hot-path', kind: 'kusto', database: 'loomdb-default', table: 'Orders' }],
            asaJobName: 'asa-loom-default-eastus2',
          },
        };
      },
      '/api/items/eventstream/es-fixture': () => ({
        ok: true,
        runtimeStatus: 'config-only',
        asaJobName: 'asa-loom-default-eastus2',
        config: { source: { kind: 'eventhub', name: 'orders-hub' }, transforms: [], sinks: [] },
      }),
    });
    calls = m.calls;
  });

  afterEach(() => { vi.restoreAllMocks(); });

  async function openSqlTab() {
    render(<EventstreamEditor item={makeItem('eventstream', 'Eventstream')} id="es-fixture" />);
    const tab = await waitFor(() => {
      const t = screen.getAllByRole('tab', { name: /sql operator/i });
      expect(t.length).toBeGreaterThan(0);
      return t[0];
    });
    fireEvent.click(tab);
    await waitFor(() => {
      expect(screen.getByText(/code-first t-sql operator/i)).toBeTruthy();
    });
  }

  it('renders the SQL operator tab with the named-sinks manager', async () => {
    await openSqlTab();
    // GET /sql-operator fired to hydrate the persisted query + sinks.
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/sql-operator') && (!c.init || c.init.method === undefined || c.init.method === 'GET'))).toBe(true);
    });
    expect(screen.getByText('Named sinks')).toBeTruthy();
    expect(screen.getByText('Test a single output')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^compile$/i }).length).toBeGreaterThan(0);
  });

  it('Compile POSTs action=compile and renders the receipt', async () => {
    await openSqlTab();
    const compile = screen.getAllByRole('button', { name: /^compile$/i })[0];
    fireEvent.click(compile);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/sql-operator') && c.init?.method === 'POST' && String(c.init?.body).includes('"compile"'))).toBe(true);
    });
    await waitFor(() => { expect(screen.getByText(/query compiled/i)).toBeTruthy(); });
  });

  it('Apply sinks POSTs action=apply-sinks and renders the ASA output receipt', async () => {
    await openSqlTab();
    const apply = await waitFor(() => {
      const b = screen.getAllByRole('button', { name: /apply sinks to asa/i }).filter((x) => !(x as HTMLButtonElement).disabled);
      expect(b.length).toBeGreaterThan(0);
      return b[0];
    });
    fireEvent.click(apply);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/sql-operator') && c.init?.method === 'POST' && String(c.init?.body).includes('"apply-sinks"'))).toBe(true);
    });
    await waitFor(() => { expect(screen.getByText(/created\/updated 1 asa output/i)).toBeTruthy(); });
  });

  it('per-output Test POSTs action=test and renders produced rows', async () => {
    await openSqlTab();
    // Choose the output alias, then click Test output.
    const select = await waitFor(() => {
      const sels = screen.getAllByRole('combobox');
      // The output-alias select offers hot-path (from the loaded query INTO).
      const target = sels.find((el) => Array.from((el as HTMLSelectElement).options || []).some((o) => o.value === 'hot-path'));
      expect(target).toBeTruthy();
      return target as HTMLSelectElement;
    });
    fireEvent.change(select, { target: { value: 'hot-path' } });
    const test = screen.getAllByRole('button', { name: /test output/i })[0];
    fireEvent.click(test);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/sql-operator') && c.init?.method === 'POST' && String(c.init?.body).includes('"test"'))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText(/status/i)).toBeTruthy();
      expect(screen.getByText('42')).toBeTruthy();
    });
  });
});
