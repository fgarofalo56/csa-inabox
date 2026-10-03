/**
 * DataProductsMarketplace — request access.
 *
 * The server loads the requested data product and derives its access model and
 * grant scope (app/api/catalog/request-access). The card therefore:
 *   - states the role a self-serve product grants (`Self-serve · Read`), and
 *   - POSTs only the product id and the permission — nothing that shapes the
 *     grant (no accessModel, scopeType, scopeRef, itemType).
 *
 * The value that would break each assertion is named at its site.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { DataProductsMarketplace } from '../data-marketplace';
import { installFetchMock } from './test-helpers';

afterEach(() => { vi.restoreAllMocks(); cleanup(); });

let calls: Array<{ url: string; init?: RequestInit }>;

beforeEach(() => {
  ({ calls } = installFetchMock({
    '/api/data-products/search': () => ({
      ok: true,
      count: 1,
      facets: {},
      results: [{
        id: 'dp_self-1', displayName: 'Gold sales', description: 'Curated sales',
        domainName: 'Sales', productType: 'Lakehouse', owner: 'a@contoso.com', accessModel: 'self-serve',
      }],
    }),
    '/api/catalog/request-access': () => ({ ok: true, granted: true, permission: 'read', message: 'Read access granted.' }),
  }));
});

function mount() {
  render(
    <FluentProvider theme={webLightTheme}>
      <DataProductsMarketplace />
    </FluentProvider>,
  );
}

describe('DataProductsMarketplace — request access', () => {
  it('shows the role a self-serve product grants', async () => {
    // Breaks on: a badge that reads plain "Self-serve" (no role stated).
    mount();
    await waitFor(() => expect(screen.getByText('Gold sales')).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.getByText('Self-serve · Read')).toBeInTheDocument();
  });

  it('posts only the product id and the permission', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('Gold sales')).toBeInTheDocument(), { timeout: 5000 });
    fireEvent.click(screen.getAllByRole('button', { name: /^Request access$/ })[0]);
    const dlg = await screen.findByRole('dialog', {}, { timeout: 5000 });
    // Breaks on: the confirm button losing the role ("Submit request" for a
    // self-serve Read).
    fireEvent.click(within(dlg).getByRole('button', { name: 'Get Read access' }));

    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/catalog/request-access'))).toBe(true));
    const post = calls.find((c) => c.url.includes('/api/catalog/request-access'))!;
    // Breaks on: a body that still carries accessModel / scopeType / scopeRef /
    // itemType / assetName (extra keys), or that keeps the `dp_` prefix.
    expect(JSON.parse(String(post.init?.body))).toEqual({ assetId: 'self-1', permission: 'read' });
    expect(await within(dlg).findByText('Read access granted.')).toBeInTheDocument();
  });
});
