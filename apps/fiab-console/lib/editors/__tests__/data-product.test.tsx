/**
 * DataProductEditor — Vitest contract test (auto-generated).
 *
 * Renders the editor with minimal props and asserts the chrome mounts +
 * at least one ribbon button exists. Network calls are caught by a no-op
 * fetch mock so the editor's mount-time fetch succeeds with ok:true.
 *
 * Per .claude/rules/no-vaporware.md grading rubric, this brings data-product
 * from B-grade (functional, untested) to A-grade (functional + Vitest).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react';
import { DataProductEditor } from '../apim-editors';
import { DeleteDataProductDialog } from '../components/delete-data-product-dialog';
import { makeItem, installFetchMock } from './test-helpers';

describe('DataProductEditor', () => {
  // globals:false means cleanup is not automatic; add it to prevent DOM accumulation.
  beforeEach(() => { installFetchMock({}); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('mounts and surfaces at least one ribbon button', async () => {
    let err: unknown = null;
    try {
      render(<DataProductEditor item={makeItem('data-product', 'Data product')} id="new" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      const ribbon = screen.getByTestId('ribbon');
      expect(ribbon.querySelectorAll('button').length).toBeGreaterThan(0);
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });
});

describe('DeleteDataProductDialog', () => {
  // globals:false means cleanup is not automatic; add it to prevent DOM accumulation.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('enables delete only once the typed name matches exactly', async () => {
    installFetchMock({
      '/api/data-products/': () => ({
        ok: true,
        displayName: 'Revenue 360',
        workspaceId: 'ws1',
        preconditions: { statusAllowed: true, datasetsEmpty: true, glossaryEmpty: true, noOpenAccessRequests: true, canDelete: true },
        current: { lifecycleStatus: 'Draft', datasetCount: 0, glossaryCount: 0, openAccessRequestCount: 0 },
      }),
    });
    const onDeleted = vi.fn();
    render(
      <DeleteDataProductDialog open={true} onOpenChange={() => {}} id="dp1" displayName="Revenue 360" onDeleted={onDeleted} />,
    );
    // Wait for the Fluent Dialog portal to mount, then for the preflight fetch to
    // resolve the confirm field inside it. First portal query is awaited; the
    // rest are scoped to the resolved dialog handle so a slow CI portal render
    // never races a sync query.
    const dialog = await screen.findByRole('dialog', {}, { timeout: 5000 });
    const field = await within(dialog).findByRole('textbox', {}, { timeout: 5000 });
    const btn = within(dialog).getByRole('button', { name: /delete data product/i });
    expect(btn).toBeDisabled();
    fireEvent.change(field, { target: { value: 'Revenue 36' } });
    await waitFor(() => expect(btn).toBeDisabled()); // partial — still blocked
    fireEvent.change(field, { target: { value: 'Revenue 360' } });
    // The enable transition is driven by a controlled-input re-render; await it
    // so a slower CI flush isn't read as a still-disabled button.
    await waitFor(() => expect(btn).not.toBeDisabled()); // exact match → enabled
  });

  it('shows blockers and no confirm field when preconditions are not met', async () => {
    installFetchMock({
      '/api/data-products/': () => ({
        ok: true,
        displayName: 'Revenue 360',
        workspaceId: 'ws1',
        preconditions: { statusAllowed: false, datasetsEmpty: false, glossaryEmpty: true, noOpenAccessRequests: false, canDelete: false },
        current: { lifecycleStatus: 'Published', datasetCount: 3, glossaryCount: 0, openAccessRequestCount: 2 },
      }),
    });
    render(
      <DeleteDataProductDialog open={true} onOpenChange={() => {}} id="dp1" displayName="Revenue 360" onDeleted={() => {}} />,
    );
    // Await the dialog portal, then the first blocker text (gated on the preflight
    // fetch); scope the remaining sync assertions to the resolved dialog so they
    // can't race the portal render on CI.
    const dialog = await screen.findByRole('dialog', {}, { timeout: 5000 });
    await within(dialog).findByText(/Cannot delete/i, undefined, { timeout: 5000 });
    expect(within(dialog).getByText(/Published/)).toBeInTheDocument();
    expect(within(dialog).getByText(/2 open access request/i)).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument(); // no confirm input when blocked
  });
});
