/**
 * Shortcut wizard, remote browse: the browse request names what the browse
 * route authorizes.
 *
 *   - S3 / GCS / Dataverse: `lakehouseId`, the shortcut registry key the
 *     credential was saved under (400 `item_required` without it).
 *   - ADLS: `itemId`, the lakehouse ITEM. ADLS shortcuts and browse share one
 *     container scope, resolved from the item; the registry key is not always
 *     the item id (the editor sends the bound container name there).
 *
 * The ADLS step offers the scope's locations (GET
 * /api/lakehouse/shortcuts/adls-scope?itemId=). A caller who is not a tenant
 * admin picks one of those and sees no storage-account list; a tenant admin
 * (`unrestricted`) also gets the account list and a free-text container, and
 * the tree lists only once the container has stopped changing.
 *
 * The REAL RemoteBrowseTree and the REAL dialog run; only `clientFetch` and the
 * credential form (which has its own tests) are replaced. The context's item id
 * (`item-lh-7`) differs from its registry key (`lh-7`), so every assertion below
 * can tell the two apart.
 *
 * WHAT BREAKS EACH LOAD-BEARING ASSERTION (assertion-design.md) is stated at
 * each test.
 */
import React, { useState } from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, waitFor, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const SCOPE = {
  unrestricted: false,
  locations: [
    { account: 'loomlake', container: 'landing', dfsHost: 'loomlake.dfs.core.windows.net', source: 'lake' },
    { account: 'partneracct', container: 'exports', dfsHost: 'partneracct.dfs.core.windows.net', source: 'lakehouse', lakehouseName: 'Partner' },
  ],
};
let scope: typeof SCOPE = SCOPE;

const { clientFetchMock } = vi.hoisted(() => ({
  clientFetchMock: vi.fn(async (_url: string, _init?: unknown): Promise<{ status: number; json: () => Promise<unknown> }> => ({
    status: 200,
    json: async () => ({ ok: true, data: { entries: [] } }),
  })),
}));
vi.mock('@/lib/client-fetch', () => ({ clientFetch: (url: string, init?: unknown) => clientFetchMock(url, init) }));

vi.mock('@/lib/components/onelake/shortcut-wizard', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/components/onelake/shortcut-wizard')>();
  return { ...real, ExternalCredsForm: () => null, SharePointBrowser: () => null };
});

import { ShortcutWizardDialog } from '../dialogs/shortcut-wizard-dialog';
import { LakehouseEditorContext } from '../lakehouse-editor-context';
import { RemoteBrowseTree } from '@/lib/components/onelake/shortcut-wizard';

beforeEach(() => {
  scope = SCOPE;
  clientFetchMock.mockClear();
  clientFetchMock.mockImplementation(async (url: string) => ({
    status: 200,
    json: async () => (String(url).startsWith('/api/lakehouse/shortcuts/adls-scope')
      ? { ok: true, data: scope }
      : { ok: true, data: { entries: [] } }),
  }));
});
afterEach(cleanup);

const urls = () => clientFetchMock.mock.calls.map((c) => String(c[0]));

/** The query string of every browse call made so far. */
const browseQueries = () =>
  urls()
    .filter((u) => u.startsWith('/api/lakehouse/shortcuts/browse?'))
    .map((u) => new URLSearchParams(u.slice(u.indexOf('?') + 1)));

const scopeQueries = () =>
  urls()
    .filter((u) => u.startsWith('/api/lakehouse/shortcuts/adls-scope?'))
    .map((u) => new URLSearchParams(u.slice(u.indexOf('?') + 1)));

function makeCtx(
  scType: 'dataverse' | 's3' | 'adls',
  extCreds: Record<string, string>,
  over: Record<string, unknown> = {},
) {
  const noop = vi.fn();
  return {
    scWizardOpen: true, setScWizardOpen: noop, scStep: 2, setScStep: noop,
    scType, setScType: noop,
    scAdlsMode: 'picker', setScAdlsMode: noop,
    scAcctHost: '', setScAcctHost: noop,
    storageAccts: [{ name: 'tenantacct', dfsHost: 'tenantacct.dfs.core.windows.net', isHns: true }], storageAcctsLoading: false,
    scAdlsContainer: '', setScAdlsContainer: noop, scAdlsPath: '', setScAdlsPath: noop,
    scInternalContainer: '', setScInternalContainer: noop, scInternalPath: '', setScInternalPath: noop, containers: [],
    scTargetUri: '', setScTargetUri: noop,
    scExtSas: '', setScExtSas: noop, scExtSasBusy: false, scExtSasErr: null, stashExternalSas: noop,
    scKvSecret: '', setScKvSecret: noop,
    extCreds, setExtCreds: noop,
    scSpSelection: null, setScSpSelection: noop,
    scKind: 'files', setScKind: noop,
    scParentPath: '', setScParentPath: noop,
    scName: 'ext', setScName: noop,
    scFormat: 'delta', setScFormat: noop,
    scTargetSchema: 'dbo', setScTargetSchema: noop,
    scSubmitError: null, scSubmitting: false, submitShortcut: noop,
    shortcutLakehouseId: 'lh-7', schemas: [], schemasEnabled: false,
    id: 'item-lh-7', isNewItem: false,
    ...over,
  } as any;
}

function mountExternalStep(
  scType: 'dataverse' | 's3' | 'adls',
  extCreds: Record<string, string>,
  over: Record<string, unknown> = {},
) {
  const ctx = makeCtx(scType, extCreds, over);
  render(
    <FluentProvider theme={webLightTheme}>
      <LakehouseEditorContext.Provider value={ctx}>
        <ShortcutWizardDialog />
      </LakehouseEditorContext.Provider>
    </FluentProvider>,
  );
  return ctx;
}

describe('shortcut wizard — S3 / GCS / Dataverse browse names the registry key', () => {
  it('Dataverse: the dialog\'s browse tree sends lakehouseId with the credential name', async () => {
    mountExternalStep('dataverse', { secretName: 'loom-sc-dataverse-lh-7-ext' });
    await waitFor(() => expect(browseQueries().length).toBeGreaterThan(0));
    const q = browseQueries()[0];
    expect(q.get('sourceType')).toBe('dataverse');
    expect(q.get('kvSecret')).toBe('loom-sc-dataverse-lh-7-ext');
    expect(q.get('lakehouseId')).toBe('lh-7');
  });

  it('S3: the dialog\'s browse tree sends lakehouseId with the bucket and region', async () => {
    mountExternalStep('s3', { secretName: 'loom-sc-s3-lh-7-ext', bucket: 'partner-bucket', region: 'us-west-2' });
    await waitFor(() => expect(browseQueries().length).toBeGreaterThan(0));
    const q = browseQueries()[0];
    expect(q.get('bucket')).toBe('partner-bucket');
    expect(q.get('region')).toBe('us-west-2');
    expect(q.get('lakehouseId')).toBe('lh-7');
  });

  it('the tree sends no lakehouseId or itemId key when it is given none, and the call still goes out', async () => {
    render(
      <FluentProvider theme={webLightTheme}>
        <RemoteBrowseTree sourceType="dataverse" kvSecret="loom-sc-dataverse-x" onSelect={() => {}} />
      </FluentProvider>,
    );
    await waitFor(() => expect(browseQueries().length).toBeGreaterThan(0));
    const q = browseQueries()[0];
    expect(q.get('kvSecret')).toBe('loom-sc-dataverse-x');
    expect(q.has('lakehouseId')).toBe(false);
    expect(q.has('itemId')).toBe(false);
  });
});

describe('shortcut wizard — ADLS names the lakehouse item and offers the workspace\'s containers', () => {
  it('the tree sends the account, container and itemId', async () => {
    // WHAT BREAKS IT: the query builder dropping `account`, `container` or
    // `itemId` (the Dataverse and S3 cases above never set any of them).
    render(
      <FluentProvider theme={webLightTheme}>
        <RemoteBrowseTree sourceType="adls" account="partneracct" container="exports" itemId="item-lh-7" onSelect={() => {}} />
      </FluentProvider>,
    );
    await waitFor(() => expect(browseQueries().length).toBeGreaterThan(0));
    const q = browseQueries()[0];
    expect(q.get('sourceType')).toBe('adls');
    expect(q.get('account')).toBe('partneracct');
    expect(q.get('container')).toBe('exports');
    expect(q.get('itemId')).toBe('item-lh-7');
  });

  it('the dialog asks for the scope and browses with the ITEM id, not the registry key', async () => {
    // WHAT BREAKS IT: the dialog passing `shortcutLakehouseId` ('lh-7') as the
    // item id (both the scope and the browse would carry 'lh-7'), or putting the
    // registry key back on the ADLS tree (`lakehouseId` present). The account is
    // the host's first label, so 'partneracct' also pins that split.
    mountExternalStep('adls', {}, { scAcctHost: 'partneracct.dfs.core.windows.net', scAdlsContainer: 'exports' });
    await waitFor(() => expect(scopeQueries().length).toBe(1));
    expect(scopeQueries()[0].get('itemId')).toBe('item-lh-7');
    await waitFor(() => expect(browseQueries().length).toBeGreaterThan(0));
    const q = browseQueries()[0];
    expect(q.get('sourceType')).toBe('adls');
    expect(q.get('account')).toBe('partneracct');
    expect(q.get('container')).toBe('exports');
    expect(q.get('itemId')).toBe('item-lh-7');
    expect(q.has('lakehouseId')).toBe(false);
  });

  it('a new, unsaved item asks for no scope (there is no item to authorize yet)', async () => {
    // WHAT BREAKS IT: `itemId` derived without `isNewItem` — the scope request
    // would go out for an id the server has never stored and answer 404.
    mountExternalStep('adls', {}, { isNewItem: true, id: 'draft-1' });
    await screen.findByText(/No container is available to this workspace yet/);
    expect(scopeQueries()).toHaveLength(0);
  });

  it('a non-admin picks from the scope\'s locations and sees no storage-account list', async () => {
    // WHAT BREAKS IT: the picker ignoring the scope (no 'partneracct / exports'
    // option), the tenant account list shown to a non-admin ('Storage account'
    // field present, or the 'tenantacct' account offered), or the pick setting
    // the wrong host / container.
    const ctx = mountExternalStep('adls', {});
    await waitFor(() => expect(scopeQueries().length).toBe(1));
    const combo = await screen.findByRole('combobox', { name: /^Container/, hidden: true });
    expect(screen.queryByText('Storage account')).toBeNull();
    expect(screen.queryByPlaceholderText('landing')).toBeNull();

    fireEvent.click(combo);
    const options = (await screen.findAllByRole('option', { hidden: true })).map((o) => o.textContent);
    expect(options).toEqual(['loomlake / landingLake', 'partneracct / exportsPartner']);
    fireEvent.click(screen.getByRole('option', { name: /partneracct \/ exports/, hidden: true }));
    expect(ctx.setScAcctHost).toHaveBeenCalledWith('partneracct.dfs.core.windows.net');
    expect(ctx.setScAdlsContainer).toHaveBeenCalledWith('exports');
  });

  it('a tenant admin also gets the storage-account list and a free-text container', async () => {
    // WHAT BREAKS IT: hiding the account list from an admin (unrestricted), so a
    // tenant admin could no longer reach an account no lakehouse records.
    scope = { ...SCOPE, unrestricted: true };
    mountExternalStep('adls', {});
    await screen.findByText('Storage account');
    expect(screen.getByPlaceholderText('landing')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: /Container bound to this workspace/, hidden: true })).toBeTruthy();
  });

  it('a container typed key by key is browsed only after it stops changing', async () => {
    // WHAT BREAKS IT: a debounce that passes the value straight through (every
    // keystroke 'e', 'ex', … lists), or the tree reading `scAdlsContainer`
    // instead of the debounced value. The tree only mounts once the debounced
    // value is non-empty, so the second defect is invisible to one fast burst
    // of typing; the pause after 'ex' mounts the tree, and the raw-value tree
    // would then list 'exp', 'expo', 'expor', 'export' and 'exports' (6 browses),
    // where the debounced one lists 'ex' then 'exports' (2).
    scope = { ...SCOPE, unrestricted: true };
    function Stateful() {
      const [container, setContainer] = useState('');
      const ctx = makeCtx('adls', {}, {
        scAcctHost: 'tenantacct.dfs.core.windows.net', scAdlsContainer: container, setScAdlsContainer: setContainer,
      });
      return (
        <LakehouseEditorContext.Provider value={ctx}>
          <ShortcutWizardDialog />
        </LakehouseEditorContext.Provider>
      );
    }
    render(<FluentProvider theme={webLightTheme}><Stateful /></FluentProvider>);
    const user = userEvent.setup();
    const input = await screen.findByPlaceholderText('landing');
    await user.type(input, 'ex');
    await waitFor(() => expect(browseQueries().length).toBe(1));
    await user.type(input, 'ports');
    await waitFor(() => expect(browseQueries().map((q) => q.get('container')).at(-1)).toBe('exports'));
    await new Promise((r) => setTimeout(r, 600));
    expect(browseQueries().map((q) => q.get('container'))).toEqual(['ex', 'exports']);
  });
});
