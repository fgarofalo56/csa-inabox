/**
 * Shortcut wizard, remote browse: the browse request names the lakehouse the
 * shortcut is being created in. The browse route refuses a credentialed browse
 * (S3, GCS, Dataverse) that does not carry `lakehouseId` (400 `item_required`),
 * so a tree that omits it cannot browse at all.
 *
 * The REAL RemoteBrowseTree and the REAL dialog run; only `clientFetch` and the
 * credential form (which has its own tests) are replaced.
 *
 * WHAT BREAKS EACH LOAD-BEARING ASSERTION (assertion-design.md):
 *   - dialog → `lakehouseId=lh-7`: dropping `lakehouseId` from the object the
 *     tree's fetchLevel loops over to build the query, OR dropping
 *     `lakehouseId={shortcutLakehouseId}` at the dialog's external-source
 *     RemoteBrowseTree. Either leaves the query without the key and
 *     `get('lakehouseId')` returns null, not 'lh-7'.
 *   - the other parameters are asserted in the same URL, so a fixture that never
 *     reaches the browse call cannot pass (no browse URL → the find is undefined).
 *   - tree without the prop → no key: sending a placeholder (e.g. '' or
 *     'undefined') when the prop is absent.
 */
import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const { clientFetchMock } = vi.hoisted(() => ({
  clientFetchMock: vi.fn(async (_url: string, _init?: unknown) => ({
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

beforeEach(() => clientFetchMock.mockClear());
afterEach(cleanup);

/** The query string of every browse call made so far. */
const browseQueries = () =>
  clientFetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.startsWith('/api/lakehouse/shortcuts/browse?'))
    .map((u) => new URLSearchParams(u.slice(u.indexOf('?') + 1)));

function mountExternalStep(scType: 'dataverse' | 's3', extCreds: Record<string, string>) {
  const noop = vi.fn();
  const ctx: any = {
    scWizardOpen: true, setScWizardOpen: noop, scStep: 2, setScStep: noop,
    scType, setScType: noop,
    scAdlsMode: 'picker', setScAdlsMode: noop,
    scAcctHost: '', setScAcctHost: noop, storageAccts: [], storageAcctsLoading: false,
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
  };
  render(
    <FluentProvider theme={webLightTheme}>
      <LakehouseEditorContext.Provider value={ctx}>
        <ShortcutWizardDialog />
      </LakehouseEditorContext.Provider>
    </FluentProvider>,
  );
}

describe('shortcut wizard — the browse request names the lakehouse', () => {
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

  it('the tree sends no lakehouseId key when it is given none, and the call still goes out', async () => {
    render(
      <FluentProvider theme={webLightTheme}>
        <RemoteBrowseTree sourceType="dataverse" kvSecret="loom-sc-dataverse-x" onSelect={() => {}} />
      </FluentProvider>,
    );
    await waitFor(() => expect(browseQueries().length).toBeGreaterThan(0));
    const q = browseQueries()[0];
    expect(q.get('kvSecret')).toBe('loom-sc-dataverse-x');
    expect(q.has('lakehouseId')).toBe(false);
  });

  it('ADLS: the tree sends the account and container', async () => {
    // WHAT BREAKS IT: the query builder dropping `account` or `container` (the
    // Dataverse and S3 cases above never set either).
    render(
      <FluentProvider theme={webLightTheme}>
        <RemoteBrowseTree sourceType="adls" account="partneracct" container="exports" onSelect={() => {}} />
      </FluentProvider>,
    );
    await waitFor(() => expect(browseQueries().length).toBeGreaterThan(0));
    const q = browseQueries()[0];
    expect(q.get('sourceType')).toBe('adls');
    expect(q.get('account')).toBe('partneracct');
    expect(q.get('container')).toBe('exports');
  });
});
