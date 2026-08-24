/**
 * #3746 — the "Live" badge must not contradict the error bar beside it.
 *
 * `catalog.configured` means "LOOM_ICEBERG_CATALOG_URL is set". `catalog.error`
 * means "the last read of that catalog FAILED". The badge consulted only the
 * first, so a configured-but-unreachable catalog rendered a green filled
 * ✓ Live directly above the red "Catalog unreachable — HTTP 403" MessageBar.
 * The two branches never read each other's field.
 *
 * That is not cosmetic: this badge is the first thing federation/security
 * triage looks at, and it pointed away from a live 403.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import { renderWithProviders, installFetchMock } from '@/lib/editors/__tests__/test-helpers';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/catalog',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

import AdminCatalogPage from '../page';

const BASE = {
  ok: true,
  namespaces: ['gold'],
  tables: [] as unknown[],
  grants: [] as unknown[],
  snippets: [] as unknown[],
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('/admin/catalog — the endpoint badge states reachability, not config', () => {
  it('a CONFIGURED but UNREACHABLE catalog is never labelled Live', async () => {
    installFetchMock({
      '/api/catalog/iceberg/overview': () => ({
        ...BASE,
        catalog: {
          configured: true,
          uri: 'https://loom.test/api/catalog/iceberg',
          warehouse: 'loom',
          error: 'HTTP 403 from the Iceberg REST catalog.',
        },
      }),
    });
    renderWithProviders(<AdminCatalogPage />);

    // The error is surfaced (it always was)...
    await waitFor(() => expect(screen.getByText('Catalog unreachable')).toBeInTheDocument());
    // ...and the badge no longer says the opposite two lines above it.
    expect(screen.queryByText('Live')).toBeNull();
    expect(screen.getByText('Unreachable')).toBeInTheDocument();
    // Still not "Direct-metadata mode" — a URL IS configured; conflating
    // "unreachable" with "unconfigured" would be a different false claim.
    expect(screen.queryByText('Direct-metadata mode')).toBeNull();
  });

  it('POSITIVE CONTROL — configured AND reachable is still Live', async () => {
    installFetchMock({
      '/api/catalog/iceberg/overview': () => ({
        ...BASE,
        catalog: { configured: true, uri: 'https://loom.test/api/catalog/iceberg', warehouse: 'loom' },
      }),
    });
    renderWithProviders(<AdminCatalogPage />);

    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument());
    expect(screen.queryByText('Unreachable')).toBeNull();
    expect(screen.queryByText('Catalog unreachable')).toBeNull();
  });

  it('REGRESSION CONTROL — an UNCONFIGURED catalog keeps the direct-metadata state', async () => {
    installFetchMock({
      '/api/catalog/iceberg/overview': () => ({
        ...BASE,
        catalog: { configured: false, uri: '', warehouse: 'loom' },
      }),
    });
    renderWithProviders(<AdminCatalogPage />);

    await waitFor(() => expect(screen.getByText('Direct-metadata mode')).toBeInTheDocument());
    expect(screen.queryByText('Live')).toBeNull();
    expect(screen.queryByText('Unreachable')).toBeNull();
  });
});
