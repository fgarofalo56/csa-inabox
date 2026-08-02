/**
 * Publish-side pickers (issue #2618 / LU-9) — the replacements for the two
 * free-text surfaces the Loom sharing backend used to expose.
 *
 * These drive the REAL `IdentityPicker` (only the network is stubbed), so they
 * assert the wiring to the real Graph enumeration endpoint rather than
 * re-implementing the component under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within, configure } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import {
  LakehouseTablePicker, RecipientPrincipalPicker, principalIdFor,
  type SelectedPrincipal, type PickedDeltaTable,
} from '../share-publish-pickers';

const clientFetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({
  clientFetch: (...a: unknown[]) => clientFetchMock(...a),
}));

const USER = {
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  type: 'user' as const, displayName: 'Dana Guest', upn: 'dana@partner.example',
};
const SPN = {
  id: 'objid-of-spn-in-this-tenant',
  appId: 'bbbbbbbb-1111-2222-3333-444444444444',
  type: 'spn' as const, displayName: 'Partner Loader',
};
const GROUP = {
  id: 'cccccccc-1111-2222-3333-444444444444',
  type: 'group' as const, displayName: 'Partner Analysts',
};

function json(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

let graphResults: unknown[] = [];
const graphCalls: string[] = [];

beforeEach(() => {
  // Role queries here navigate Fluent listbox popovers, which render through a
  // portal. Portalled Fluent surfaces intermittently carry `aria-hidden` under
  // jsdom (see the sibling data-shares-publish-dialogs spec for the dump that
  // proved it), which silently empties any `*ByRole` result. Opt out of the
  // a11y-tree filter so navigation is deterministic; the assertions that carry
  // the meaning here are the `onSelect` payload checks, not the lookups.
  // `configure` is global, so it is restored in afterEach.
  configure({ defaultHidden: true });
  clientFetchMock.mockReset();
  graphResults = [];
  graphCalls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    graphCalls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ ok: true, results: graphResults }) };
  }));
});
afterEach(() => { configure({ defaultHidden: false }); cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

/* ------------------------------ principalIdFor ----------------------------- */

describe('principalIdFor', () => {
  it('stores a user by object id', () => {
    expect(principalIdFor(USER)).toBe(USER.id);
  });

  it('stores a service principal by APPLICATION id, not its directory object id', () => {
    // recipient-auth.ts matches [claims.objectId, claims.appId]. A federated
    // SPN's object id differs in every tenant it is provisioned into, so the
    // object id found in OUR tenant would never match the partner's token.
    expect(principalIdFor(SPN)).toBe(SPN.appId);
    expect(principalIdFor(SPN)).not.toBe(SPN.id);
  });

  it('falls back to the object id when Graph returned no appId', () => {
    expect(principalIdFor({ ...SPN, appId: undefined })).toBe(SPN.id);
  });
});

/* ------------------------- RecipientPrincipalPicker ------------------------ */

function Recipients({ onChange }: { onChange: (n: SelectedPrincipal[]) => void }) {
  return <RecipientPrincipalPicker selected={[]} onChange={onChange} />;
}

async function searchAndPick(name: string) {
  const user = userEvent.setup();
  const box = screen.getByRole('textbox');
  await user.type(box, 'part');
  const hit = await screen.findByText(name, {}, { timeout: 3000 });
  await user.click(hit);
}

describe('RecipientPrincipalPicker', () => {
  it('is backed by the real Entra search endpoint, not a hard-coded list', async () => {
    const user = userEvent.setup();
    wrap(<RecipientPrincipalPicker selected={[]} onChange={() => {}} />);
    await user.type(screen.getByRole('textbox'), 'part');
    await waitFor(
      () => expect(graphCalls.some((u) => u.startsWith('/api/governance/identities/search'))).toBe(true),
      { timeout: 3000 },
    );
  });

  it('adds a picked user by object id', async () => {
    graphResults = [USER];
    const onChange = vi.fn();
    wrap(<Recipients onChange={onChange} />);
    await searchAndPick('Dana Guest');
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ principalId: USER.id, type: 'user' }),
    ]);
  });

  it('adds a picked service principal by application id', async () => {
    graphResults = [SPN];
    const onChange = vi.fn();
    const user = userEvent.setup();
    wrap(<Recipients onChange={onChange} />);
    await user.click(screen.getByRole('tab', { name: /Service principals/i }));
    await searchAndPick('Partner Loader');
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ principalId: SPN.appId, type: 'spn' }),
    ]);
  });

  it('refuses a group and points at the transitive-member expander', async () => {
    graphResults = [GROUP];
    const onChange = vi.fn();
    const user = userEvent.setup();
    wrap(<Recipients onChange={onChange} />);
    await user.click(screen.getByRole('tab', { name: /Groups/i }));
    await searchAndPick('Partner Analysts');
    // A group id appears as neither `oid` nor `appid` in a caller's token, so a
    // group-backed recipient would authenticate nobody — silently.
    expect(onChange).not.toHaveBeenCalled();
    expect(await screen.findByText(/can't be a recipient/i)).toBeInTheDocument();
    expect(screen.getByText(/Members" expander/i)).toBeInTheDocument();
  });

  it('renders each selected principal as a removable chip', async () => {
    const onChange = vi.fn();
    const selected: SelectedPrincipal[] = [
      { principalId: USER.id, displayName: 'Dana Guest', secondary: 'dana@partner.example', type: 'user' },
    ];
    const user = userEvent.setup();
    wrap(<RecipientPrincipalPicker selected={selected} onChange={onChange} />);
    expect(screen.getByText('Dana Guest')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Remove Dana Guest/i }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('does not add the same principal twice', async () => {
    graphResults = [USER];
    const onChange = vi.fn();
    const selected: SelectedPrincipal[] = [
      { principalId: USER.id, displayName: 'Dana Guest', type: 'user' },
    ];
    wrap(<RecipientPrincipalPicker selected={selected} onChange={onChange} />);
    await searchAndPick('Dana Guest');
    expect(onChange).not.toHaveBeenCalled();
  });
});

/* --------------------------- LakehouseTablePicker -------------------------- */

function stubCascade(tables: unknown[] = [
  { name: 'revenue', location: 'abfss://gold@stx.dfs.core.usgovcloudapi.net/lakehouses/sales/Tables/revenue', sizeBytes: 4096 },
]) {
  clientFetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/workspaces') return json([{ id: 'ws-1', displayName: 'Sales WS' }]);
    if (url.startsWith('/api/items/lakehouse')) return json({ ok: true, items: [{ id: 'lh-1', displayName: 'sales_lake' }] });
    if (url.startsWith('/api/marketplace/sharing/publishable-tables')) return json({ ok: true, tables });
    throw new Error(`unexpected ${url}`);
  });
}

async function driveCascade() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('combobox', { name: /Workspace/i }));
  await user.click(await screen.findByRole('option', { name: 'Sales WS' }));
  await user.click(await screen.findByRole('combobox', { name: /Lakehouse/i }));
  await user.click(await screen.findByRole('option', { name: 'sales_lake' }));
  await user.click(await screen.findByRole('combobox', { name: /Delta table/i }));
  return user;
}

describe('LakehouseTablePicker', () => {
  it('cascades Workspace -> Lakehouse -> Delta table over the real endpoints', async () => {
    stubCascade();
    wrap(<LakehouseTablePicker open selected={null} onSelect={() => {}} />);
    const user = await driveCascade();
    await user.click(await screen.findByRole('option', { name: /revenue/ }));

    const urls = clientFetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain('/api/workspaces');
    expect(urls).toContain('/api/items/lakehouse?workspaceId=ws-1');
    expect(urls).toContain('/api/marketplace/sharing/publishable-tables?lakehouseId=lh-1&workspaceId=ws-1');
  });

  it('emits the server-built abfss location and the source lakehouse name', async () => {
    stubCascade();
    const onSelect = vi.fn();
    wrap(<LakehouseTablePicker open selected={null} onSelect={onSelect} />);
    const user = await driveCascade();
    await user.click(await screen.findByRole('option', { name: /revenue/ }));

    expect(onSelect).toHaveBeenCalledWith({
      name: 'revenue',
      location: 'abfss://gold@stx.dfs.core.usgovcloudapi.net/lakehouses/sales/Tables/revenue',
      sizeBytes: 4096,
      lakehouseName: 'sales_lake',
    });
  });

  it('shows the exact Delta root that will be published', async () => {
    stubCascade();
    const picked: PickedDeltaTable = {
      name: 'revenue', lakehouseName: 'sales_lake',
      location: 'abfss://gold@stx.dfs.core.usgovcloudapi.net/lakehouses/sales/Tables/revenue',
    };
    wrap(<LakehouseTablePicker open selected={picked} onSelect={() => {}} />);
    expect(await screen.findByText(picked.location)).toBeInTheDocument();
  });

  it('offers no tables at all when the backend returns none — never a placeholder', async () => {
    stubCascade([]);
    wrap(<LakehouseTablePicker open selected={null} onSelect={() => {}} />);
    await driveCascade();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(await screen.findByText(/No Delta tables in this lakehouse/i)).toBeInTheDocument();
  });

  it('surfaces the backend honest gate verbatim, naming the env vars', async () => {
    clientFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/workspaces') return json([{ id: 'ws-1', displayName: 'Sales WS' }]);
      if (url.startsWith('/api/items/lakehouse')) return json({ ok: true, items: [{ id: 'lh-1', displayName: 'sales_lake' }] });
      return json({ ok: false, error: 'That lakehouse has no resolved ADLS Gen2 storage — set LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL …' });
    });
    wrap(<LakehouseTablePicker open selected={null} onSelect={() => {}} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: /Workspace/i }));
    await user.click(await screen.findByRole('option', { name: 'Sales WS' }));
    await user.click(await screen.findByRole('combobox', { name: /Lakehouse/i }));
    await user.click(await screen.findByRole('option', { name: 'sales_lake' }));
    const bar = await screen.findByText(/Can't list Delta tables/i);
    expect(within(bar.closest('[role="alert"], div')!).getByText(/LOOM_\{BRONZE,SILVER,GOLD,LANDING\}_URL/)).toBeInTheDocument();
  });
});
