/**
 * Pure browse logic for the ShortcutWizard's step 2. The component-level cases
 * (a picked lakehouse listed through its item, a refused container listing) are
 * in lib/editors/__tests__/storage-listing-non-admin.test.tsx; these pin each
 * branch of the helpers directly.
 */
import { describe, expect, it } from 'vitest';
import { shortcutBrowseCrumbs, shortcutBrowseOutcome, shortcutBrowseUrl } from '../shortcut-browse';

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

  // FAILS IF the 403 hint is added for a lakehouse listing, or dropped for a
  // container listing.
  it('adds the pick-a-lakehouse hint only to a refused container listing', () => {
    const refused = { ok: false, error: 'Admins only.' };
    expect(shortcutBrowseOutcome(403, refused, '', 'bronze', 'raw'))
      .toEqual({ kind: 'error', message: 'Admins only. Go back and pick a source lakehouse to browse its files instead.' });
    expect(shortcutBrowseOutcome(403, refused, 'lh-src', '', ''))
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
