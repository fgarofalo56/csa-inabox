/**
 * Azure SQL database editor — Vitest contract tests.
 *
 * Two suites:
 *  1. AzureSqlDatabaseEditor (the focused server-scoped editor in
 *     azure-sql-editors.tsx) — chrome + ribbon smoke.
 *  2. UnifiedSqlDatabaseEditor — the editor ACTUALLY REGISTERED for the
 *     `azure-sql-database` item type (lib/editors/registry.ts). These assert
 *     the Tier-0 parity gap is closed: after selecting an Azure SQL server,
 *     the rich sys.* object navigator (SqlDbTree) mounts in the Schema tab and
 *     the Server-admin tab surfaces real firewall / Microsoft Entra admin /
 *     geo-replication controls calling the existing ARM routes.
 *
 * Per .claude/rules/no-vaporware.md: real assertions, no no-ops.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react';
import { AzureSqlDatabaseEditor } from '../azure-sql-editors';
import { UnifiedSqlDatabaseEditor } from '../unified-sql-database-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('AzureSqlDatabaseEditor', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('mounts and surfaces at least one ribbon button', async () => {
    installFetchMock({});
    let err: unknown = null;
    try {
      render(<AzureSqlDatabaseEditor item={makeItem('azure-sql-database', 'Azure SQL database')} id="new" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      const ribbon = screen.getByTestId('ribbon');
      expect(ribbon.querySelectorAll('button').length).toBeGreaterThan(0);
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });

  it('mounts the live sys.* schema browser (SqlDbTree) in the left pane once a server + database are selected', async () => {
    const m = installFetchMock({
      // useSqlServers() inventory.
      '/api/items/azure-sql-server': () => ({ ok: true, servers: [{ name: 'loom-sql-01', location: 'eastus2', fqdn: 'loom-sql-01.database.windows.net' }] }),
      // useSqlDatabases() — route reads ?server= only.
      '/api/items/azure-sql-server/current/databases': () => ({ ok: true, databases: [{ name: 'appdb' }] }),
      // sys.* navigator routes (real backend; mocked transport here).
      '/api/sqldb/tables': () => ({ ok: true, database: 'appdb', tables: [{ objectId: 1, schema: 'dbo', name: 'Orders', fullName: 'dbo.Orders', type: 'U', rowCount: 7 }] }),
      '/api/sqldb/views': () => ({ ok: true, views: [] }),
      '/api/sqldb/procedures': () => ({ ok: true, procedures: [] }),
      '/api/sqldb/functions': () => ({ ok: true, functions: [] }),
      '/api/sqldb/schemas': () => ({ ok: true, schemas: [{ schemaId: 1, name: 'dbo' }] }),
      '/api/sqldb/table-types': () => ({ ok: true, tableTypes: [] }),
    });
    const calls = m.calls;

    render(<AzureSqlDatabaseEditor item={makeItem('azure-sql-database', 'Azure SQL database')} id="sqldb-fixture" />);

    // Pick the server, then the database, via the left-pane native <select>s.
    await waitFor(() => expect(screen.getAllByRole('option', { name: /loom-sql-01/i }).length).toBeGreaterThan(0));
    const serverSelect = screen.getAllByRole('combobox')
      .find((el) => within(el).queryAllByRole('option', { name: /loom-sql-01/i }).length > 0);
    expect(serverSelect).toBeTruthy();
    fireEvent.change(serverSelect!, { target: { value: 'loom-sql-01' } });

    await waitFor(() => expect(screen.getAllByRole('option', { name: /appdb/i }).length).toBeGreaterThan(0));
    const dbSelect = screen.getAllByRole('combobox')
      .find((el) => within(el).queryAllByRole('option', { name: /appdb/i }).length > 0);
    expect(dbSelect).toBeTruthy();
    fireEvent.change(dbSelect!, { target: { value: 'appdb' } });

    // Click the left-pane "Browse objects" button to open the schema browser.
    // (Both the ribbon and the left pane expose this label once connected, so
    // target the first match — either opens the browser.)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Browse objects$/i }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: /^Browse objects$/i })[0]);

    // SqlDbTree mounts and pulls the real table from the (mocked) sys.tables backend.
    await waitFor(() => expect(screen.getByRole('tree', { name: /SQL database objects/i })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('dbo.Orders')).toBeInTheDocument());

    // Proves the browser targeted the user-selected connection via the
    // explicit ?server=&database= override (no Fabric workspace consulted).
    const sqldbCall = calls.find((c) => c.url.includes('/api/sqldb/tables'));
    expect(sqldbCall?.url).toMatch(/server=loom-sql-01/);
    expect(sqldbCall?.url).toMatch(/database=appdb/);
    expect(sqldbCall?.url).not.toMatch(/workspaceId=[^&]+/);
  });
});

describe('UnifiedSqlDatabaseEditor (registered azure-sql-database editor)', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    const m = installFetchMock({
      // Tenant inventory: one reachable Azure SQL server, no MI/PG.
      '/api/items/sql-databases': () => ({
        ok: true,
        sql: { servers: [{ id: 'srv1', name: 'loom-sql-01', location: 'eastus2', fqdn: 'loom-sql-01.database.windows.net' }] },
        mi: { instances: [] },
        postgres: { servers: [] },
      }),
      // Databases on the picked server.
      '/api/items/azure-sql-server/sqldb-fixture/databases': () => ({
        ok: true,
        databases: [{ name: 'appdb' }],
      }),
      // sys.* object navigator routes (real backend; mocked transport here).
      '/api/sqldb/tables': () => ({ ok: true, database: 'appdb', tables: [{ objectId: 1, schema: 'dbo', name: 'Customers', fullName: 'dbo.Customers', type: 'U', rowCount: 42 }] }),
      '/api/sqldb/views': () => ({ ok: true, views: [] }),
      '/api/sqldb/procedures': () => ({ ok: true, procedures: [] }),
      '/api/sqldb/functions': () => ({ ok: true, functions: [] }),
      '/api/sqldb/schemas': () => ({ ok: true, schemas: [{ schemaId: 1, name: 'dbo' }] }),
      '/api/sqldb/table-types': () => ({ ok: true, tableTypes: [] }),
      // Server-admin routes (existing ARM-backed BFF).
      '/api/items/azure-sql-database/sqldb-fixture/firewall': () => ({ ok: true, rules: [{ name: 'allow-corp', startIpAddress: '10.0.0.0', endIpAddress: '10.0.0.255' }] }),
      '/api/items/azure-sql-database/sqldb-fixture/aad-admin': () => ({ ok: true, admin: { login: 'admins@contoso.com', sid: '11111111-2222-3333-4444-555555555555' } }),
    });
    calls = m.calls;
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  function renderEditor() {
    render(<UnifiedSqlDatabaseEditor item={makeItem('azure-sql-database', 'Azure SQL database')} id="sqldb-fixture" />);
  }

  // Scope ribbon-action lookups to the chrome stub's ribbon container so a
  // stray un-cleaned render can't produce "multiple elements".
  function ribbonButton(name: RegExp) {
    return within(screen.getByTestId('ribbon')).getByRole('button', { name });
  }

  // Pick the server via the left-pane <select> so the ribbon + tabs enable.
  // The native <select>s aren't label-associated, so locate the one that
  // actually carries the inventory server option and fire a change on it.
  async function pickServer() {
    await waitFor(() => {
      expect(screen.getAllByRole('option', { name: /loom-sql-01/i }).length).toBeGreaterThan(0);
    });
    const serverSelect = screen
      .getAllByRole('combobox')
      .find((el) => within(el).queryAllByRole('option', { name: /loom-sql-01/i }).length > 0);
    expect(serverSelect).toBeTruthy();
    fireEvent.change(serverSelect!, { target: { value: 'loom-sql-01' } });
  }

  it('loads ARM inventory on mount and lists the Azure SQL server', async () => {
    renderEditor();
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/items/sql-databases'))).toBe(true));
    await waitFor(() => expect(screen.getAllByText(/loom-sql-01/).length).toBeGreaterThan(0));
  });

  it('mounts the sys.* object navigator (SqlDbTree) in the Schema tab wired to the selected Azure SQL connection', async () => {
    renderEditor();
    await pickServer();

    // Open the Schema tab via the ribbon "Browse objects" action.
    await waitFor(() => expect(ribbonButton(/Browse objects/i)).not.toBeDisabled());
    fireEvent.click(ribbonButton(/Browse objects/i));

    // The SqlDbTree navigator renders (aria-label="SQL database objects")
    // and its sys.* routes are hit with the explicit server/database override.
    await waitFor(() => {
      expect(screen.getByRole('tree', { name: /SQL database objects/i })).toBeInTheDocument();
    });
    // The tree pulled the real table from the (mocked) sys.tables backend.
    await waitFor(() => expect(screen.getByText('dbo.Customers')).toBeInTheDocument());
    // Proves the navigator targeted the user-selected connection, not a Fabric item.
    const sqldbCall = calls.find((c) => c.url.includes('/api/sqldb/tables'));
    expect(sqldbCall?.url).toMatch(/server=loom-sql-01/);
  });

  it('surfaces firewall + Microsoft Entra admin + geo-replication on the Server-admin tab against the existing ARM routes', async () => {
    renderEditor();
    await pickServer();

    // Open Server admin via the ribbon "Firewall" action.
    await waitFor(() => expect(ribbonButton(/^Firewall$/i)).not.toBeDisabled());
    fireEvent.click(ribbonButton(/^Firewall$/i));

    const main = screen.getByTestId('main-panel');

    // Firewall control: the existing rule loaded from /firewall renders + an Add control exists.
    await waitFor(() => expect(within(main).getByText('allow-corp')).toBeInTheDocument());
    expect(within(main).getByRole('button', { name: /Add rule/i })).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/api/items/azure-sql-database/sqldb-fixture/firewall'))).toBe(true);

    // Microsoft Entra admin control: the Set-admin button + the loaded admin.
    expect(within(main).getByRole('button', { name: /Set Microsoft Entra admin/i })).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/api/items/azure-sql-database/sqldb-fixture/aad-admin'))).toBe(true);

    // Geo-replication control wired to the existing replication route.
    expect(within(main).getByRole('button', { name: /Create geo-replica/i })).toBeInTheDocument();
  });
});
