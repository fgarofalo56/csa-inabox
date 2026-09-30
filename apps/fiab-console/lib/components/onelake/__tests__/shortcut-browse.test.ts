/**
 * Pure browse logic for the ShortcutWizard's step 2. The component-level cases
 * (a picked lakehouse listed through its item, a refused container listing) are
 * in lib/editors/__tests__/storage-listing-non-admin.test.tsx; these pin each
 * branch of the helpers directly.
 */
import { describe, expect, it } from 'vitest';
import {
  SHORTCUT_CONTAINER_REFUSED, shortcutBrowseCrumbs, shortcutBrowseOutcome, shortcutBrowseUrl,
} from '../shortcut-browse';

describe('shortcutBrowseUrl', () => {
  // FAILS IF a picked lakehouse is listed by container (the admin-only form),
  // or the prefix is dropped or left unencoded.
  it('scopes to the lakehouse when one is picked, else to the container', () => {
    expect(shortcutBrowseUrl('lh 1', 'bronze', 'a b/c')).toBe('/api/lakehouse/paths?lakehouseId=lh%201&prefix=a%20b%2Fc');
    expect(shortcutBrowseUrl('', 'bronze', 'raw')).toBe('/api/lakehouse/paths?container=bronze&prefix=raw');
  });
});

describe('shortcutBrowseOutcome', () => {
  const PATHS = [{ name: 'lakehouses/Sales/Files', isDirectory: true, size: 0 }];

  // FAILS IF a lakehouse answer does not hand back the resolved container and
  // root (`gold` differs from the `bronze` argument, so only adoption yields it).
  it('adopts the container and root a lakehouse listing resolved', () => {
    expect(shortcutBrowseOutcome(200, { ok: true, container: 'gold', root: 'lakehouses/Sales', paths: PATHS }, 'lh-src', 'bronze', ''))
      .toEqual({ kind: 'entries', paths: PATHS, resolved: { container: 'gold', root: 'lakehouses/Sales' } });
  });

  // FAILS IF a container listing reports a `resolved` pair, which would move
  // the wizard's container to whatever the body carried.
  it('a container listing returns rows only', () => {
    expect(shortcutBrowseOutcome(200, { ok: true, container: 'gold', paths: PATHS }, '', 'bronze', ''))
      .toEqual({ kind: 'entries', paths: PATHS });
  });

  // FAILS IF an ok lakehouse answer with no container is shown as an empty
  // folder instead of the route's gate text.
  it('an ok lakehouse answer with no storage shows the gate', () => {
    expect(shortcutBrowseOutcome(200, { ok: true, gate: 'No storage yet for Sales.' }, 'lh-src', '', ''))
      .toEqual({ kind: 'error', message: 'No storage yet for Sales.' });
  });

  // FAILS IF a refused container listing shows the route's text (its
  // "Open the lakehouse" step would then sit beside, or replace, the wizard's
  // "Go back and pick" step), or if a refused lakehouse listing loses the
  // route's text in favour of the container one.
  it('a refused container listing shows only the wizard instruction', () => {
    const refused = { ok: false, error: 'Admins only. Open the lakehouse and browse from its editor.' };
    const out = shortcutBrowseOutcome(403, refused, '', 'bronze', 'raw');
    expect(out).toEqual({ kind: 'error', message: SHORTCUT_CONTAINER_REFUSED });
    expect(SHORTCUT_CONTAINER_REFUSED).toMatch(/Go back and pick a source lakehouse/);
    expect(SHORTCUT_CONTAINER_REFUSED).not.toMatch(/Open the lakehouse/);
    expect(shortcutBrowseOutcome(403, { ok: false, error: 'Admins only.' }, 'lh-src', '', ''))
      .toEqual({ kind: 'error', message: 'Admins only.' });
    expect(shortcutBrowseOutcome(500, {}, '', 'bronze', 'raw'))
      .toEqual({ kind: 'error', message: 'Could not list bronze/raw (HTTP 500).' });
  });
});

describe('shortcutBrowseCrumbs', () => {
  // FAILS IF a lakehouse listing's crumbs restart at the container (the first
  // crumb's prefix would be '' and the root segments would appear as crumbs).
  it('starts a lakehouse listing at its root', () => {
    expect(shortcutBrowseCrumbs('lakehouses/Sales/Files/raw', 'lakehouses/Sales', true, 'Sales')).toEqual([
      { label: 'Sales', prefix: 'lakehouses/Sales' },
      { label: 'Files', prefix: 'lakehouses/Sales/Files' },
      { label: 'raw', prefix: 'lakehouses/Sales/Files/raw' },
    ]);
  });

  // FAILS IF a container listing is given a non-empty base.
  it('starts a container listing at the container', () => {
    expect(shortcutBrowseCrumbs('raw/sales', null, false, 'bronze')).toEqual([
      { label: 'bronze', prefix: '' },
      { label: 'raw', prefix: 'raw' },
      { label: 'sales', prefix: 'raw/sales' },
    ]);
  });
});
