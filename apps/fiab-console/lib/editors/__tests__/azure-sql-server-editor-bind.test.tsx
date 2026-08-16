/**
 * `AzureSqlServerEditor` — the AUTO-BIND half of the #3623 regression fix.
 *
 * THE REGRESSION. `registry.ts` maps the `azure-sql-server` slug to this editor,
 * and its Entra-admin dialog posts to `/api/items/azure-sql-database/[id]/aad-admin`
 * with an `azure-sql-server` item id. #3623 put that route behind
 * `withBoundSqlServer`, whose `SQL_EDITOR_ITEM_TYPES` listed one slug (three after
 * review) and never this one — so a working button started 404ing.
 *
 * WHY THE ROUTE FIX ALONE IS NOT ENOUGH, which is what these specs pin. Adding the
 * slug gets the caller past the owner check and straight into the NEXT refusal:
 * `withBoundSqlServer` resolves its target from `state.connection`, and this
 * surface picked its server from live ARM discovery and persisted NOTHING. So the
 * button would have gone 404 → 409 `no_bound_connection`, whose remediation text
 * says "open the Connect tab" — a tab this editor does not have. A dead end with a
 * different status code is not a fix, and `auto-bind-by-default.md` §4 forbids it.
 *
 * The pick is therefore the binding. These specs assert the POST /connect actually
 * happens, carries the SELECTED server, and is not repeated per click.
 *
 * Per .claude/rules/no-vaporware.md: real assertions, no no-ops.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { AzureSqlServerEditor } from '../azure-sql-editors';
import { makeItem, installFetchMock } from './test-helpers';

const SERVERS = {
  ok: true,
  servers: [
    { id: 'srv1', name: 'loom-sql-01', location: 'eastus2', fqdn: 'loom-sql-01.database.windows.net' },
    { id: 'srv2', name: 'loom-sql-02', location: 'westus2', fqdn: 'loom-sql-02.database.windows.net' },
  ],
};

describe('AzureSqlServerEditor — binds its picked server to the item (#3623)', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    const m = installFetchMock({
      '/api/items/azure-sql-server': () => SERVERS,
      '/api/items/azure-sql-server/srv-item/databases': () => ({ ok: true, databases: [{ name: 'appdb' }] }),
      '/api/items/azure-sql-database/srv-item/connect': () => ({ ok: true, item: { id: 'srv-item' } }),
      '/api/items/azure-sql-database/srv-item/aad-admin': () => ({
        ok: true, admin: { login: 'admins@contoso.com', sid: '1111-2222' },
      }),
      '/api/items/azure-sql-database/srv-item/firewall': () => ({ ok: true, rules: [] }),
    });
    calls = m.calls;
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  function renderEditor(id = 'srv-item') {
    render(<AzureSqlServerEditor item={makeItem('azure-sql-server', 'Azure SQL server')} id={id} />);
  }

  /** Click a server in the left-pane tree, the way the operator does. */
  async function pickServer(name = 'loom-sql-01') {
    await waitFor(() => expect(screen.getAllByText(name).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText(name)[0]);
  }

  const connectCalls = () =>
    calls.filter((c) => c.url.endsWith('/connect') && c.init?.method === 'POST');

  //   MUTATION: delete the `ensureBound()` call from loadAad. → no /connect is
  //   posted, and against the real route the dialog 409s `no_bound_connection`.
  it('POSTs /connect with the SELECTED server before reading the Entra admin', async () => {
    renderEditor();
    await pickServer();

    fireEvent.click(screen.getByRole('button', { name: /AAD admin/i }));

    await waitFor(() => expect(connectCalls().length).toBeGreaterThan(0));
    const bind = connectCalls()[0];
    expect(bind.url).toBe('/api/items/azure-sql-database/srv-item/connect');
    expect(JSON.parse(String(bind.init!.body))).toMatchObject({
      family: 'azure-sql',
      server: 'loom-sql-01',
    });
  });

  // The binding must be the server the operator actually chose. A bind that
  // always sent the first discovered server would satisfy the spec above.
  //   MUTATION: bind `servers[0].name` instead of `selected.name`.
  it('binds the server the operator picked, not the first one discovered', async () => {
    renderEditor();
    await pickServer('loom-sql-02');

    fireEvent.click(screen.getByRole('button', { name: /AAD admin/i }));

    await waitFor(() => expect(connectCalls().length).toBeGreaterThan(0));
    expect(JSON.parse(String(connectCalls()[0].init!.body))).toMatchObject({ server: 'loom-sql-02' });
  });

  // The Entra admin sits at SERVER scope and the route does not require a bound
  // database, so binding one would be inventing a coordinate the operator never
  // chose.
  it('binds server scope only — no database is invented', async () => {
    renderEditor();
    await pickServer();
    fireEvent.click(screen.getByRole('button', { name: /AAD admin/i }));

    await waitFor(() => expect(connectCalls().length).toBeGreaterThan(0));
    const body = JSON.parse(String(connectCalls()[0].init!.body));
    expect(body.database).toBeFalsy();
  });

  // `bindItemConnection` caches on the selection key. Without that this surface
  // would write to Cosmos on every dialog open.
  //   MUTATION: drop `cachedKey: boundKeyRef.current`. → two POSTs.
  it('binds at most once per selection, not once per dialog open', async () => {
    renderEditor();
    await pickServer();

    fireEvent.click(screen.getByRole('button', { name: /AAD admin/i }));
    await waitFor(() => expect(connectCalls().length).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: /^Firewall$/i }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/firewall'))).toBe(true));
    expect(connectCalls().length).toBe(1);
  });

  // An unsaved item has no id to bind to. The dialog must say so rather than
  // POST /connect to `/api/items/azure-sql-database/new/connect`.
  it('does NOT bind an unsaved item (id=new)', async () => {
    renderEditor('new');
    await pickServer();
    fireEvent.click(screen.getByRole('button', { name: /AAD admin/i }));

    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/items/azure-sql-server'))).toBe(true));
    expect(connectCalls().length).toBe(0);
  });
});
