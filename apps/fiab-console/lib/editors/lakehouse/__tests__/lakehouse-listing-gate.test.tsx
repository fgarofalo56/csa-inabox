/**
 * #3904 — the honest-gate surface, asserted where the user sees it.
 *
 * The route's classification is covered in paths-route-honest-errors.test.ts.
 * This covers the half that spec cannot see: that the PANE consumes it. Both
 * were shipped unguarded in the first cut — stripping the guided state
 * (`const guided = false; listing.remediation = undefined;`) left the suite
 * green across 10 files.
 *
 * The second case is the one that matters most. The first implementation
 * re-derived the class by regex-matching the English message
 * (`/not exist|Nothing is stored/i.test(listing.error)`), which is a second
 * method for one decision — the exact defect #3904 is about — and it mis-fired:
 * a container or prefix containing the words "not exist" turned a permission
 * failure into a friendly "nothing here yet". The pane now reads the server's
 * `kind` token, and the fixture below is built so that only a `kind`-driven
 * implementation can pass it.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import { renderWithProviders, installFetchMock, makeItem } from '../../__tests__/test-helpers';
import { LakehouseEditor } from '../lakehouse-editor-shell';

const ROOT = 'lakehouses/Contoso Sales';

const ITEM = {
  id: 'lh-3904', workspaceId: 'ws-1', itemType: 'lakehouse', displayName: 'Contoso Sales',
  state: { provisioning: { secondaryIds: { container: 'landing', rootPath: ROOT } } },
};

const REMEDIATION =
  'Azure Storage reports that landing/lakehouses/Contoso Sales does not exist. Loom established only '
  + 'that the listing returned 404 — not why the directory is absent.';

function mount(pathsBody: unknown) {
  const mock = installFetchMock({
    '/api/lakehouse/containers': () => ({
      ok: true,
      containers: [{ name: 'bronze', url: 'u' }, { name: 'landing', url: 'u' }],
    }),
    '/api/lakehouse/paths': () => pathsBody,
    '/api/cosmos-items/lakehouse/lh-3904': () => ITEM,
  });
  renderWithProviders(<LakehouseEditor item={makeItem('lakehouse', 'Lakehouse')} id="lh-3904" />);
  return mock;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('#3904 — a classified listing failure reaches the user as a fix, not a RequestId', () => {
  it('a not-found listing renders the GUIDED state with the remediation', async () => {
    mount({
      ok: false, kind: 'not-found', code: 'PathNotFound',
      error: `Nothing is stored at landing/${ROOT} yet.`, remediation: REMEDIATION,
    });

    // Guided, not red — a directory that does not exist yet is not an error
    // (ux-baseline.md §6: unconfigured states are guided, never red).
    await waitFor(() => expect(screen.getAllByText('Nothing here yet').length).toBeGreaterThan(0));
    expect(screen.queryByText('List failed')).toBeNull();
    // The remediation is SHOWN, not merely returned.
    expect(screen.getAllByText(/Loom established only that the listing returned 404/).length)
      .toBeGreaterThan(0);
  });

  it('a DENIED listing stays red even when its text contains "not exist"', async () => {
    // THE DISCRIMINATING FIXTURE. A regex over the message classifies this as
    // guided; only the `kind` token classifies it as the permission failure it
    // is. The wording here is realistic: the remediation names the path, and a
    // lakehouse root can legitimately contain those words.
    mount({
      ok: false, kind: 'denied', code: 'AuthorizationPermissionMismatch',
      error: 'Loom is not authorized to list landing/lakehouses/does not exist.',
      remediation: 'Grant the Console managed identity (UAMI) the Storage Blob Data Contributor role.',
    });

    await waitFor(() => expect(screen.getAllByText('List failed').length).toBeGreaterThan(0));
    expect(screen.queryByText('Nothing here yet')).toBeNull();
    expect(screen.getAllByText(/Storage Blob Data Contributor/).length).toBeGreaterThan(0);
  });

  it('never renders a storage RequestId, whatever the BFF said', async () => {
    // Belt and braces: the route is what strips this (and is tested there), but
    // the pane must not reintroduce it by rendering a raw field.
    mount({
      ok: false, kind: 'not-found', code: 'PathNotFound',
      error: `Nothing is stored at landing/${ROOT} yet.`, remediation: REMEDIATION,
    });
    await waitFor(() => expect(screen.getAllByText('Nothing here yet').length).toBeGreaterThan(0));
    expect(document.body.textContent).not.toContain('RequestId');
  });
});
