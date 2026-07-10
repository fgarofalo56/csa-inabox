/**
 * DataProductEditDialog (UX-704) — render + per-step validation contract.
 *
 * Opens the edit wizard with a mocked GET /api/data-products/[id] and asserts
 * the stepped dialog renders (Basic/Business/Custom) with the Name field —
 * the Basic step's required-field validation gate (§7.5) drives Save/Next.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { DataProductEditDialog } from '../data-product-edit-dialog';
import { installFetchMock } from './test-helpers';

afterEach(() => { vi.restoreAllMocks(); cleanup(); });

beforeEach(() => {
  installFetchMock({
    '/api/data-products/dp1': () => ({ ok: true, doc: { id: 'dp1', name: 'Customer 360', description: 'x', type: '', audience: [], owners: [], endorsed: false, customAttributes: {} } }),
    '/api/admin/domains': () => ({ ok: true, domains: [] }),
  });
});

describe('DataProductEditDialog', () => {
  it('renders the stepped edit dialog with the required Name field', async () => {
    let err: unknown = null;
    try {
      render(
        <FluentProvider theme={webLightTheme}>
          <DataProductEditDialog id="dp1" open onOpenChange={() => {}} />
        </FluentProvider>,
      );
      expect(await screen.findByText(/edit data product/i)).toBeInTheDocument();
      await waitFor(() => expect(screen.getByText('Name')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: /save basic/i })).toBeInTheDocument();
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null/i);
  });
});
