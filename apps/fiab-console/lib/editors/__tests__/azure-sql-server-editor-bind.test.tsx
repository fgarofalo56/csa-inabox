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

const PRINCIPALS = {
  ok: true,
  results: [
    { id: 'aaaaaaaa-1111-2222-3333-444444444444', type: 'user', displayName: 'Ada Lovelace', upn: 'ada@contoso.com' },
    { id: 'bbbbbbbb-5555-6666-7777-888888888888', type: 'user', displayName: 'Adam Smith', upn: 'adam@contoso.com' },
  ],
};

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
      '/api/items/azure-sql-database/srv-item/principal-search': () => PRINCIPALS,
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

// ═══════════════════════════════════════════════════════════════════════════
// THE ENTRA ADMIN IS PICKED, NOT TYPED (check-no-freeform boy-scout).
//
// The dialog used to carry three free-text boxes — login, "Object id (sid)" and
// "Tenant id (optional)". The sid is a GUID with no meaning to a human, so the
// operator had to leave Loom, find the principal in the portal, copy its object
// id back, and hope it belonged to the same principal they typed the login for.
// ARM does not reject a mismatch: it sets a SERVER ADMIN — sysadmin-equivalent
// on every database — whose login text and actual identity disagree.
//
// Both coordinates now come from ONE Microsoft Graph object.
// ═══════════════════════════════════════════════════════════════════════════
describe('AzureSqlServerEditor — Entra admin comes from a live Graph pick', () => {
  // `hidden: true` on the dialog-internal queries: jsdom does not implement
  // HTMLDialogElement.showModal(), so Fluent's portalled DialogSurface never
  // enters the accessibility tree here even though React has rendered its
  // children. Same reason and same convention as
  // spark-job-definition-lineage.test.tsx. It means these specs prove the WIRING,
  // not the visibility — the browser receipt (ux-baseline.md G1) is still owed.
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    const m = installFetchMock({
      '/api/items/azure-sql-server': () => SERVERS,
      '/api/items/azure-sql-database/srv-item/connect': () => ({ ok: true, item: { id: 'srv-item' } }),
      '/api/items/azure-sql-database/srv-item/aad-admin': () => ({ ok: true, admin: null }),
      '/api/items/azure-sql-database/srv-item/principal-search': () => PRINCIPALS,
    });
    calls = m.calls;
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  async function openDialogAndSearch(term = 'Ada') {
    render(<AzureSqlServerEditor item={makeItem('azure-sql-server', 'Azure SQL server')} id="srv-item" />);
    await waitFor(() => expect(screen.getAllByText('loom-sql-01').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('loom-sql-01')[0]);
    fireEvent.click(screen.getByRole('button', { name: /AAD admin/i }));
    const box = await screen.findByPlaceholderText(/Start typing a name or UPN/i);
    fireEvent.change(box, { target: { value: term } });
    return box;
  }

  //   MUTATION: reinstate the free-text sid Input. → no Graph call is made.
  it('searches Microsoft Graph as the operator types — no GUID is asked for', async () => {
    await openDialogAndSearch();
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/principal-search?q=Ada'))).toBe(true);
    });
    // The results are offered as options, not as a box to paste an id into.
    expect(await screen.findByRole('button', { name: /Ada Lovelace/, hidden: true })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/1111-2222-3333/)).toBeNull();
  });

  // THE MISMATCH CATCHER. login and sid must come from the SAME Graph object.
  //   MUTATION: send `login` from one principal and `sid` from another (or from
  //   a separate free-text field). → this assertion goes red.
  it('PUTs the login and sid of the SAME picked principal', async () => {
    await openDialogAndSearch();
    fireEvent.click(await screen.findByRole('button', { name: /Ada Lovelace/, hidden: true }));
    fireEvent.click(screen.getByRole('button', { name: /Set Microsoft Entra admin/i, hidden: true }));

    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith('/aad-admin') && c.init?.method === 'PUT')).toBe(true);
    });
    const put = calls.find((c) => c.url.endsWith('/aad-admin') && c.init?.method === 'PUT')!;
    const body = JSON.parse(String(put.init!.body));
    expect(body.login).toBe('ada@contoso.com');
    expect(body.sid).toBe('aaaaaaaa-1111-2222-3333-444444444444');
    // Both are Ada's — not Adam's, who is the other search hit.
    expect(body.sid).not.toBe('bbbbbbbb-5555-6666-7777-888888888888');
  });

  // The tenant field is GONE, not hidden: ARM defaults it to the server's own
  // tenant, which is the tenant this Graph search resolves against.
  //   MUTATION: reinstate a tenantId field and send it. → this goes red.
  it('sends NO tenantId — ARM defaults it to the server’s tenant', async () => {
    await openDialogAndSearch();
    fireEvent.click(await screen.findByRole('button', { name: /Ada Lovelace/, hidden: true }));
    fireEvent.click(screen.getByRole('button', { name: /Set Microsoft Entra admin/i, hidden: true }));

    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith('/aad-admin') && c.init?.method === 'PUT')).toBe(true);
    });
    const put = calls.find((c) => c.url.endsWith('/aad-admin') && c.init?.method === 'PUT')!;
    expect(JSON.parse(String(put.init!.body))).not.toHaveProperty('tenantId');
  });

  // Save must be impossible until a real principal is selected — the old form
  // enabled it on any two non-empty strings.
  it('cannot save before a principal is picked', async () => {
    await openDialogAndSearch();
    expect(screen.getByRole('button', { name: /Set Microsoft Entra admin/i, hidden: true })).toBeDisabled();
  });

  // Graph permission gaps surface honestly rather than as an empty list
  // (no-vaporware.md) — the route's structured remediation is rendered.
  it('surfaces a Graph permission gap with its remediation', async () => {
    cleanup();
    const m = installFetchMock({
      '/api/items/azure-sql-server': () => SERVERS,
      '/api/items/azure-sql-database/srv-item/connect': () => ({ ok: true, item: { id: 'srv-item' } }),
      '/api/items/azure-sql-database/srv-item/aad-admin': () => ({ ok: true, admin: null }),
      '/api/items/azure-sql-database/srv-item/principal-search': () => ({
        ok: false, error: 'graph_forbidden', remediation: 'Grant the Console UAMI Directory.Read.All.',
      }),
    });
    calls = m.calls;
    await openDialogAndSearch();
    expect(await screen.findByText(/Grant the Console UAMI Directory.Read.All/)).toBeInTheDocument();
  });
});
