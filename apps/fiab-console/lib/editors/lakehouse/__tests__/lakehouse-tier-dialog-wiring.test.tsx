/**
 * #4619 — the lakehouse editor hands its own item id to TierDialog, which the
 * tier route uses to item-scope the request (see
 * `lib/components/onelake/__tests__/tier-dialog.test.tsx` for what the dialog
 * does with it). Without the id, a non-admin's tier change is refused.
 *
 * TierDialog is replaced by a probe that records its props, so this pins the
 * WIRING only. Breaks if the shell stops passing `lakehouseId={id}`: the probe
 * would record `undefined` instead of `lh-wire-1`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { waitFor, cleanup } from '@testing-library/react';

const tierProps: Array<Record<string, unknown>> = [];
vi.mock('@/lib/components/onelake/tier-dialog', () => ({
  TierDialog: (props: Record<string, unknown>) => { tierProps.push(props); return null; },
}));

import { LakehouseEditor } from '../../lakehouse-editor';
import { makeItem, installFetchMock, renderWithProviders } from '../../__tests__/test-helpers';

afterEach(() => { cleanup(); vi.restoreAllMocks(); tierProps.length = 0; });

describe('LakehouseEditor → TierDialog wiring', () => {
  it('passes the lakehouse item id as lakehouseId', async () => {
    installFetchMock({
      '/api/lakehouse/containers': () => ({ ok: true, containers: [{ name: 'lakehouse-fixture', url: 'https://acct.dfs.core.windows.net/lakehouse-fixture' }] }),
      '/api/lakehouse/paths': () => ({ ok: true, paths: [] }),
      '/api/lakehouse/schemas': () => ({ ok: true, schemas: [] }),
    });
    renderWithProviders(<LakehouseEditor item={makeItem('lakehouse', 'Lakehouse')} id="lh-wire-1" />);
    await waitFor(() => expect(tierProps.length).toBeGreaterThan(0));
    // Every render of the dialog carries the id, not just the first.
    expect(tierProps.every((p) => p.lakehouseId === 'lh-wire-1')).toBe(true);
  });
});
