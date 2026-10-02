/**
 * Foundry dataset editor: what a caller without access to the dataset item sees.
 *
 * The dataset routes answer 404 with `dataset_item_not_found` when the caller
 * cannot read a dataset item with this id (item-to-asset mapping pending,
 * #4826). The editor shows an explanation with the issue link, not a bare
 * error; any other failure keeps the ordinary error bar.
 *
 * Each test names the change that turns it red:
 *   - the notice and its link render for the code: the editor showing the raw
 *     404 text instead, or the code constant drifting from the route's (the
 *     response here is built from the ROUTE's constant).
 *   - another 404 keeps the error bar: every failure turned into the notice.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { DATASET_ITEM_NOT_FOUND } from '@/app/api/items/dataset/_lib/dataset-item-scope';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

function installFetch(detail: { status: number; body: unknown }) {
  vi.spyOn(global, 'fetch').mockImplementation((async (input: any) => {
    const u = typeof input === 'string' ? input : String(input?.url ?? input);
    const { status, body } = u.includes('/api/items/dataset/ds-1') ? detail : { status: 200, body: { ok: true } };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as any);
}

async function open() {
  const { DatasetEditor } = await import('../foundry-sub-editors');
  const { makeItem } = await import('./test-helpers');
  render(<FluentProvider theme={webLightTheme}><DatasetEditor item={makeItem('dataset', 'Data asset')} id="ds-1" /></FluentProvider>);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('DatasetEditor — dataset item access', () => {
  it('explains the pending item-to-asset mapping, with the issue link', async () => {
    installFetch({ status: 404, body: { ok: false, code: DATASET_ITEM_NOT_FOUND, error: 'No dataset item you can read has this id.' } });
    await open();
    expect(await screen.findByText('This data asset opens through a Loom dataset item', {}, { timeout: 5000 })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'issue #4826' });
    expect(link.getAttribute('href')).toBe('https://github.com/fgarofalo56/csa-inabox/issues/4826');
    expect(screen.queryByText('No dataset item you can read has this id.')).toBeNull();
  });

  it('keeps the ordinary error bar for any other failure', async () => {
    installFetch({ status: 404, body: { ok: false, error: 'not found' } });
    await open();
    expect(await screen.findByText('not found', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText('This data asset opens through a Loom dataset item')).toBeNull();
  });
});
