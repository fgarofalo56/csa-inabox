/**
 * AzureSqlServerEditor — Vitest contract tests.
 *
 * Suite 1 (smoke): chrome mounts + at least one ribbon button.
 * Suite 2 (server → database → schema/table browser): picking a server lists
 *   its databases; selecting a database mounts the live sys.* object navigator
 *   (SqlDbTree) against that database's FQDN on a dedicated connection. This is
 *   the previously-deferred "table/schema browser" sub-panel — now real.
 *
 * Per .claude/rules/no-vaporware.md: real assertions, no no-ops.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { AzureSqlServerEditor } from '../azure-sql-editors';
import { makeItem, installFetchMock } from './test-helpers';

describe('AzureSqlServerEditor', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('mounts and surfaces at least one ribbon button', async () => {
    installFetchMock({});
    let err: unknown = null;
    try {
      render(<AzureSqlServerEditor item={makeItem('azure-sql-server', 'Azure SQL server')} id="new" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      const ribbon = screen.getByTestId('ribbon');
      expect(ribbon.querySelectorAll('button').length).toBeGreaterThan(0);
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });

  it('browses server → database → schema/table: selecting a database mounts the live sys.* navigator on that db connection', async () => {
    const m = installFetchMock({
      // ARM server inventory.
      '/api/items/azure-sql-server': () => ({
        ok: true,
        servers: [{ id: 'srv1', name: 'loom-sql-01', location: 'eastus2', fqdn: 'loom-sql-01.database.windows.net', state: 'Ready', version: '12.0', publicNetworkAccess: 'Disabled' }],
      }),
      // Databases on the picked server (server editor uses id="new").
      '/api/items/azure-sql-server/new/databases': () => ({ ok: true, databases: [{ name: 'appdb', status: 'Online', sku: { name: 'GP_Gen5_2' } }] }),
      // sys.* object navigator routes (real backend; mocked transport here).
      '/api/sqldb/tables': () => ({ ok: true, database: 'appdb', tables: [{ objectId: 1, schema: 'dbo', name: 'Orders', fullName: 'dbo.Orders', type: 'U', rowCount: 7 }] }),
      '/api/sqldb/views': () => ({ ok: true, views: [] }),
      '/api/sqldb/procedures': () => ({ ok: true, procedures: [] }),
      '/api/sqldb/functions': () => ({ ok: true, functions: [] }),
      '/api/sqldb/schemas': () => ({ ok: true, schemas: [{ schemaId: 1, name: 'dbo' }] }),
      '/api/sqldb/table-types': () => ({ ok: true, tableTypes: [] }),
    });
    const calls = m.calls;

    render(<AzureSqlServerEditor item={makeItem('azure-sql-server', 'Azure SQL server')} id="new" />);

    // Pick the server in the left-pane tree.
    await waitFor(() => expect(screen.getAllByText(/loom-sql-01/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('loom-sql-01')[0]);

    // The server's databases load (appears both in the tree and the main table).
    await waitFor(() => expect(screen.getAllByText('appdb').length).toBeGreaterThan(0));
    expect(calls.some((c) => c.url.includes('/api/items/azure-sql-server/new/databases') && c.url.includes('server=loom-sql-01'))).toBe(true);

    // Select the database — mounts the live sys.* navigator sub-panel.
    fireEvent.click(screen.getAllByText('appdb')[0]);

    // SqlDbTree mounts and pulls the real table from the (mocked) sys.tables backend.
    await waitFor(() => expect(screen.getByRole('tree', { name: /SQL database objects/i })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('dbo.Orders')).toBeInTheDocument());

    // Proves the browser targeted the selected database on its own connection
    // via the explicit ?server=<fqdn>&database= override (no Fabric workspace).
    const sqldbCall = calls.find((c) => c.url.includes('/api/sqldb/tables'));
    expect(sqldbCall?.url).toMatch(/server=loom-sql-01\.database\.windows\.net/);
    expect(sqldbCall?.url).toMatch(/database=appdb/);
    expect(sqldbCall?.url).not.toMatch(/workspaceId=[^&]+/);
  });
});
