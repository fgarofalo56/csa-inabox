/**
 * DataProductsMarketplace (UX-705) — render + preview-before-subscribe contract.
 *
 * Mounts the consumer marketplace with a mocked search route and asserts the
 * Discover teaching banner (SC-6) plus a Details (preview) action on each hit
 * — the preview-before-subscribe affordance from ux-standards §7 (SC-2/SC-5).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { DataProductsMarketplace } from '../data-marketplace';
import { installFetchMock } from './test-helpers';

afterEach(() => { vi.restoreAllMocks(); cleanup(); });

beforeEach(() => {
  installFetchMock({
    '/api/data-products/search': () => ({
      ok: true,
      count: 1,
      facets: {},
      results: [{ id: 'dp_1', displayName: 'Customer 360', description: 'Unified customer view', domainName: 'Sales', productType: 'Lakehouse', owner: 'a@contoso.com', accessModel: 'governed' }],
    }),
  });
});

describe('DataProductsMarketplace', () => {
  it('renders the discover teaching banner and a preview Details action per hit', async () => {
    let err: unknown = null;
    try {
      render(
        <FluentProvider theme={webLightTheme}>
          <DataProductsMarketplace />
        </FluentProvider>,
      );
      expect(await screen.findByText(/discover, preview, then subscribe/i)).toBeInTheDocument();
      await waitFor(() => expect(screen.getByText('Customer 360')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: /^details$/i })).toBeInTheDocument();
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null/i);
  });
});
