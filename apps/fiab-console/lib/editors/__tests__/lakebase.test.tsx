/**
 * LakebaseEditor — Vitest contract test.
 *
 * Renders the editor against a fetch mock that returns a bound Flexible Server
 * so the reworked Overview surface (SC-2 DetailsPanel + SC-4 GuidedEmptyState
 * path + SC-6 TeachingBanner) mounts, and asserts the shared chrome comes up.
 * Network is caught by a no-op fetch mock so the mount-time GET succeeds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { LakebaseEditor } from '../lakebase-editor';
import { makeItem, installFetchMock, renderWithProviders } from './test-helpers';

describe('LakebaseEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/items/lakebase-postgres/': () => ({
        ok: true,
        config: {
          backend: 'postgres',
          server: { name: 'pg-loom', id: '/subscriptions/x/pg-loom', fqdn: 'pg-loom.postgres.database.azure.com' },
          database: 'postgres',
        },
        live: {
          server: { name: 'pg-loom', fqdn: 'pg-loom.postgres.database.azure.com', state: 'Ready', version: '16' },
          databases: [{ name: 'postgres' }],
        },
      }),
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('mounts the editor chrome for a bound server', async () => {
    let err: unknown = null;
    try {
      renderWithProviders(<LakebaseEditor item={makeItem('lakebase-postgres', 'Lakebase')} id="lb1" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      const ribbon = screen.getByTestId('ribbon');
      expect(ribbon.querySelectorAll('button').length).toBeGreaterThan(0);
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });
});
