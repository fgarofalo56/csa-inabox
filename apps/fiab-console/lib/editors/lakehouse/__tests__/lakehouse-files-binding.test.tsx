/**
 * #3904 — REGRESSION SPEC for the operator-reported P0.
 *
 * The live symptom, verbatim:
 *
 *     List failed
 *     The specified path does not exist.  RequestId:… Time:…
 *
 * The chain: the installer materialises a lakehouse at
 * `landing/lakehouses/<Name>/…` and stamps that container + root on the item.
 * The editor ignored the stamp and opened on `containers[0]` — which is
 * `bronze`, because `listContainers()` walks KNOWN_CONTAINERS in order — and
 * listed the CONTAINER root (`''`). So the very first request the Files browser
 * issued named the wrong container AND the wrong directory.
 *
 * THIS IS THE ASSERTION THAT WOULD HAVE CAUGHT IT: the editor's FIRST listing
 * must ask for the container and the root the item is actually bound to. It is
 * deliberately an assertion about the REQUEST, not about rendered text — the
 * rendered text was fine (an error MessageBar renders beautifully), and the
 * whole defect lived in the query string.
 *
 * Mutation check performed while writing this (see the PR body): reverting the
 * two resolution sites to `containers[0]` / `''` turns the first three cases
 * RED with `container=bronze` / `prefix=`.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { waitFor, cleanup } from '@testing-library/react';
import { renderWithProviders, installFetchMock, makeItem } from '../../__tests__/test-helpers';
import { LakehouseEditor } from '../lakehouse-editor-shell';

/** Container list in the order the BFF really returns it — bronze FIRST. */
const CONTAINERS = {
  ok: true,
  containers: [
    { name: 'bronze', url: 'https://acct.dfs.core.windows.net/bronze' },
    { name: 'silver', url: 'https://acct.dfs.core.windows.net/silver' },
    { name: 'gold', url: 'https://acct.dfs.core.windows.net/gold' },
    { name: 'landing', url: 'https://acct.dfs.core.windows.net/landing' },
  ],
};

const PATHS = {
  ok: true,
  paths: [
    { name: 'lakehouses/Contoso Sales/Files', isDirectory: true, size: 0 },
    { name: 'lakehouses/Contoso Sales/Tables', isDirectory: true, size: 0 },
  ],
};

function itemWith(secondaryIds: Record<string, unknown> | null) {
  return {
    id: 'lh-3904',
    workspaceId: 'ws-1',
    itemType: 'lakehouse',
    displayName: 'Contoso Sales',
    state: secondaryIds ? { provisioning: { status: 'created', secondaryIds } } : {},
  };
}

function mount(handlers: Record<string, (url: string, init?: RequestInit) => unknown>) {
  const mock = installFetchMock(handlers);
  renderWithProviders(
    <LakehouseEditor item={makeItem('lakehouse', 'Lakehouse')} id="lh-3904" />,
  );
  return mock;
}

/** Every `/api/lakehouse/paths` request the editor issued, in order. */
function pathCalls(calls: Array<{ url: string }>) {
  return calls
    .filter((c) => c.url.includes('/api/lakehouse/paths'))
    .map((c) => new URL(c.url, 'http://localhost').searchParams);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('#3904 — the Files browser binds to the item\'s own container and root', () => {
  it('first listing asks for landing + lakehouses/<Name>, NOT bronze + ""', async () => {
    const { calls } = mount({
      '/api/lakehouse/containers': () => CONTAINERS,
      '/api/lakehouse/paths': () => PATHS,
      '/api/cosmos-items/lakehouse/lh-3904': () => itemWith({
        backend: 'azure-native-adls',
        container: 'landing',
        rootPath: 'lakehouses/Contoso Sales',
      }),
    });

    await waitFor(() => expect(pathCalls(calls).length).toBeGreaterThan(0));
    const first = pathCalls(calls)[0];

    expect(first.get('container'), 'the item is bound to `landing`').toBe('landing');
    expect(first.get('prefix'), 'the lakehouse root, not the container root')
      .toBe('lakehouses/Contoso Sales');

    // And the wrong container is never listed at all — not even alongside.
    for (const p of pathCalls(calls)) {
      expect(p.get('container')).toBe('landing');
      expect(p.get('prefix')).not.toBe('');
    }
  });

  it('accepts the stamped abfss root as the binding', async () => {
    const { calls } = mount({
      '/api/lakehouse/containers': () => CONTAINERS,
      '/api/lakehouse/paths': () => PATHS,
      '/api/cosmos-items/lakehouse/lh-3904': () => itemWith({
        adlsRoot: 'abfss://gold@acct.dfs.core.windows.net/lakehouses/Contoso Sales',
      }),
    });

    await waitFor(() => expect(pathCalls(calls).length).toBeGreaterThan(0));
    const first = pathCalls(calls)[0];
    expect(first.get('container')).toBe('gold');
    expect(first.get('prefix')).toBe('lakehouses/Contoso Sales');
  });

  it('adopts the BFF\'s resolveLakehouseAbfss answer when the item carries no stamp', async () => {
    // No secondaryIds → the client must NOT guess. It asks the BFF, which runs
    // the one resolver (including its env-derived convention step), and adopts
    // whatever it answers.
    const { calls } = mount({
      '/api/lakehouse/containers': () => CONTAINERS,
      '/api/lakehouse/paths': (url) =>
        url.includes('lakehouseId=')
          ? { ...PATHS, ok: true, container: 'landing', root: 'lakehouses/Contoso Sales', prefix: 'lakehouses/Contoso Sales' }
          : PATHS,
      '/api/cosmos-items/lakehouse/lh-3904': () => itemWith(null),
    });

    await waitFor(() => expect(pathCalls(calls).length).toBeGreaterThan(0));
    const resolve = pathCalls(calls)[0];
    expect(resolve.get('lakehouseId'), 'the resolve call carries the item id').toBe('lh-3904');
    expect(resolve.get('workspaceId')).toBe('ws-1');
    expect(resolve.get('container'), 'the client does not name a container it did not resolve').toBeNull();

    // The BFF's answer is ADOPTED: every container-scoped call the editor makes
    // afterwards is scoped to `landing`. The settings fetch is the independent
    // witness — it fires off the active container, not off this response.
    await waitFor(() => {
      const settings = calls.filter((c) => c.url.includes('/api/lakehouse/settings'));
      expect(settings.length).toBeGreaterThan(0);
      expect(settings[0].url).toContain('container=landing');
    });
    for (const p of pathCalls(calls)) {
      expect(p.get('container')).not.toBe('bronze');
    }
  });

  it('still browses the container root when the lakehouse genuinely has no binding', async () => {
    // Honest gate from the BFF (no LOOM_*_URL configured for this item): the
    // editor must degrade to the pre-#3904 behaviour rather than dead-end.
    const { calls } = mount({
      '/api/lakehouse/containers': () => CONTAINERS,
      '/api/lakehouse/paths': (url) =>
        url.includes('lakehouseId=')
          ? { ok: true, container: null, root: null, prefix: '', paths: [], gate: 'No lakehouse storage is configured…' }
          : { ok: true, paths: [] },
      '/api/cosmos-items/lakehouse/lh-3904': () => itemWith(null),
    });

    await waitFor(() => {
      const listing = pathCalls(calls).filter((p) => p.get('container'));
      expect(listing.length).toBeGreaterThan(0);
      expect(listing[0].get('container')).toBe('bronze');
      expect(listing[0].get('prefix')).toBe('');
    });
  });
});
