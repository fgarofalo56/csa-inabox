/**
 * DucklakeCatalogEditor — silent-failure regression (FINISHLINE C14).
 *
 * `fetchCatalog` THROWS on !res.ok / json.ok !== true / transport failure, but
 * the editor rendered only `q.isLoading` plus the data branches — so a failed
 * GET /api/ducklake/catalog fell through to the literal string
 * "Reading the DuckLake catalog…" and stayed there forever, with no error and
 * no retry. That is the IDENTICAL defect apex A3 fixed in
 * `s3-gateway-editor.tsx` (pinned by `s3-gateway-error.test.tsx`); the fix was
 * never propagated to this sibling — a guard-adoption gap.
 *
 * These specs would FAIL against the pre-fix editor:
 *   - the first two assert the honest error branch exists at all;
 *   - the third is the sharp one: it asserts the editor does NOT claim to still
 *     be reading after the read has already failed. Deleting the `q.isError`
 *     guard from the "Reading the DuckLake catalog…" line makes it go red while
 *     the others stay green, so it pins the specific regression rather than
 *     just the presence of a MessageBar.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import { DucklakeCatalogEditor } from '../ducklake-catalog-editor';
import { makeItem, renderWithProviders } from './test-helpers';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Route /api/ducklake/catalog through `onCatalog`; everything else answers ok. */
function installFetch(onCatalog: () => Response | never) {
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
    const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
    if (url.includes('/api/ducklake/catalog')) return onCatalog() as any;
    // runtime-flags etc. — generic ok so useRuntimeFlag falls back to default ON.
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }) as any;
  });
}

function renderEditor() {
  return renderWithProviders(
    <DucklakeCatalogEditor item={makeItem('ducklake-catalog', 'DuckLake Catalog')} id="ducklake-fixture" />,
  );
}

describe('DucklakeCatalogEditor transport-failure honesty (C14)', () => {
  it('renders an error MessageBar with Retry when the catalog fetch rejects', async () => {
    installFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    renderEditor();

    await waitFor(() =>
      expect(screen.getByText('Could not read the DuckLake catalog')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // The toolbar (partial surface) stays up alongside the honest error.
    expect(screen.getByText('DuckLake catalog')).toBeInTheDocument();
  });

  it('renders the error branch for an HTTP failure too (fetchCatalog throws on !res.ok)', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ ok: false, error: 'ducklake store unreachable' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    );
    renderEditor();

    await waitFor(() =>
      expect(screen.getByText('Could not read the DuckLake catalog')).toBeInTheDocument(),
    );
    // The route's own message is surfaced, not swallowed into a generic string.
    expect(screen.getByText(/ducklake store unreachable/)).toBeInTheDocument();
  });

  it('does NOT keep claiming it is still reading once the read has failed', async () => {
    // This is the specific regression: the pre-fix editor rendered
    // `!isLoading && !data` -> "Reading the DuckLake catalog…" on the error
    // path, which asserts an in-progress read that is not in progress
    // (deploy-integrity.md R7 — an UNKNOWN reported as a not-yet).
    installFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    renderEditor();

    await waitFor(() =>
      expect(screen.getByText('Could not read the DuckLake catalog')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Reading the DuckLake catalog…')).not.toBeInTheDocument();
  });

  it('still renders real tables through PreviewTable on the success path', async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({
            ok: true,
            configured: true,
            catalog: 'loomlake',
            tables: [
              { schema: 'bronze', name: 'orders' },
              { schema: 'silver', name: 'customers' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    renderEditor();

    await waitFor(() => expect(screen.getByText('orders')).toBeInTheDocument());
    expect(screen.getByText('customers')).toBeInTheDocument();
    // Bound catalog identity is badged so the user knows WHICH catalog answered.
    expect(screen.getByText('loomlake')).toBeInTheDocument();
    // No error on the happy path.
    expect(screen.queryByText('Could not read the DuckLake catalog')).not.toBeInTheDocument();
  });

  it('renders the guided empty state (not an error) when the catalog is wired but empty', async () => {
    // ux-baseline G6: reachable-but-empty must never be red, and must not be
    // confused with unreachable.
    installFetch(
      () =>
        new Response(
          JSON.stringify({ ok: true, configured: true, catalog: 'loomlake', tables: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    renderEditor();

    await waitFor(() =>
      expect(screen.getByText('No tables in the DuckLake catalog yet')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Could not read the DuckLake catalog')).not.toBeInTheDocument();
  });

  it('distinguishes "did not answer" from "empty" when the route reports unreachable', async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({
            ok: true,
            configured: true,
            catalog: 'loomlake',
            tables: [],
            unreachable: 'connect ECONNREFUSED 10.0.0.4:5432',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    renderEditor();

    await waitFor(() =>
      expect(screen.getByText('The DuckLake catalog did not answer')).toBeInTheDocument(),
    );
    // The concrete reason is shown, not a generic phrase.
    expect(screen.getByText(/ECONNREFUSED/)).toBeInTheDocument();
    // And it must NOT be reported as "no tables yet".
    expect(screen.queryByText('No tables in the DuckLake catalog yet')).not.toBeInTheDocument();
  });
});
