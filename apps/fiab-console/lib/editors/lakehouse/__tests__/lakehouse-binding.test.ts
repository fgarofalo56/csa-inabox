/**
 * #3904 — the lakehouse → ADLS binding resolver, unit level.
 *
 * These pin the SHAPE of the record the editor reads. The live defect was not a
 * parsing bug — it was that nothing read this record at all — so the render
 * spec (lakehouse-files-binding.test.tsx) is the one that would have caught the
 * outage. These pin the pieces it stands on, including the two path-composition
 * helpers whose absence produced `landing/landing/lakehouses/…`.
 */
import { describe, it, expect } from 'vitest';
import {
  bindingFromItemState, joinPrefix, relativeToRoot, containerRelativePath, isClientKnownContainer,
  CLIENT_KNOWN_CONTAINERS,
} from '../lakehouse-binding';
import { KNOWN_CONTAINERS } from '@/lib/azure/adls-client';

const item = (secondaryIds: Record<string, unknown>) => ({
  id: 'lh-1',
  displayName: 'Contoso Sales',
  state: { provisioning: { status: 'created', secondaryIds } },
});

describe('bindingFromItemState', () => {
  it('reads the stamped abfss root (the provisioner\'s own record)', () => {
    expect(bindingFromItemState(item({
      backend: 'azure-native-adls',
      adlsRoot: 'abfss://landing@stloomdev.dfs.core.windows.net/lakehouses/Contoso Sales',
      container: 'landing',
      rootPath: 'lakehouses/Contoso Sales',
    }))).toEqual({ container: 'landing', root: 'lakehouses/Contoso Sales', source: 'adlsRoot' });
  });

  it('falls back to the recorded container + rootPath', () => {
    expect(bindingFromItemState(item({
      backend: 'azure-native-adls',
      container: 'landing',
      rootPath: '/lakehouses/Contoso Sales/',
    }))).toEqual({ container: 'landing', root: 'lakehouses/Contoso Sales', source: 'secondaryIds' });
  });

  it('is sovereign-cloud agnostic — the host is never interpreted', () => {
    expect(bindingFromItemState(item({
      adlsRoot: 'abfss://gold@stloomgov.dfs.core.usgovcloudapi.net/lakehouses/Fed',
    }))).toEqual({ container: 'gold', root: 'lakehouses/Fed', source: 'adlsRoot' });
  });

  it('returns null rather than GUESSING when nothing is stamped', () => {
    // The env-derived convention fallback is the SERVER's job
    // (resolveLakehouseAbfss step 3) — a second guess here would be the very
    // divergence #3904 is about.
    expect(bindingFromItemState(item({ backend: 'azure-native-adls' }))).toBeNull();
    expect(bindingFromItemState(item({ container: 'landing' }))).toBeNull();
    expect(bindingFromItemState(item({ rootPath: 'lakehouses/X' }))).toBeNull();
    expect(bindingFromItemState({ id: 'lh-1' })).toBeNull();
    expect(bindingFromItemState(undefined)).toBeNull();
  });

  it('ignores a malformed abfss and uses the recorded pair instead', () => {
    expect(bindingFromItemState(item({
      adlsRoot: 'abfss://not-a-real-uri',
      container: 'bronze',
      rootPath: 'lakehouses/Y',
    }))).toEqual({ container: 'bronze', root: 'lakehouses/Y', source: 'secondaryIds' });
  });

  it('defers to the SERVER for a container the DLZ does not serve', () => {
    // `resolveLakehouseAbfss` step 2 is gated on isKnownContainer, and its step
    // 2b handles a lakehouse on an external storage account. Resolving such a
    // container here would send the editor to `/api/lakehouse/paths?container=…`,
    // which rejects it — a raw "unknown container" instead of the server's
    // answer. Returning null routes it to the server, which CAN resolve it.
    expect(bindingFromItemState(item({
      container: 'customer-owned', rootPath: 'lakehouses/Z',
    }))).toBeNull();
    expect(bindingFromItemState(item({
      adlsRoot: 'abfss://customer-owned@theiraccount.dfs.core.windows.net/lakehouses/Z',
    }))).toBeNull();
  });
});

describe('isClientKnownContainer — drift guard', () => {
  it('mirrors adls-client KNOWN_CONTAINERS exactly, in BOTH directions', () => {
    // The client bundle cannot import adls-client (it pulls in the credential
    // chain), so the container list is duplicated in lakehouse-binding.ts. This
    // spec runs in node, CAN import the real one, and fails the moment the two
    // disagree.
    //
    // #3921 — the first version of this guard was ONE-directional: a loop over
    // the real list, plus a hard-coded negative list of four names standing in
    // for "and nothing beyond it". A mirror SUPERSET therefore passed green,
    // and that is the direction that matters. If the editor offers a container
    // the DLZ does not serve, `/api/lakehouse/paths` answers `404 unknown
    // container: …` through `apiError` rather than `classifyListFailure`, and
    // the user lands on a raw "List failed" with no remediation — the exact
    // dead-end #3904 reported. (The subset direction degrades gracefully: a
    // container the editor does not know about simply is not offered.)
    // Enumerating "names that must not appear" can never be complete, so both
    // directions are compared as sets instead.
    const real = KNOWN_CONTAINERS as readonly string[];
    const mirror = CLIENT_KNOWN_CONTAINERS as readonly string[];

    // Neither list may be EMPTY. A set comparison over two empty lists is
    // vacuously true and would report a green guard that measures nothing.
    expect(real.length, 'adls-client KNOWN_CONTAINERS is empty').toBeGreaterThan(0);
    expect(mirror.length, 'the editor container mirror is empty').toBeGreaterThan(0);

    // →  nothing the DLZ serves is missing from the mirror (a lakehouse the
    //    editor would silently refuse to bind). Enumerated, not compared, so
    //    the failure names the offender.
    for (const c of real) {
      expect(isClientKnownContainer(c), `${c} is served by the DLZ but unknown to the editor`).toBe(true);
    }

    // ←  and nothing beyond it: every mirrored name is really served. Named
    //    the same way, for the same reason.
    for (const c of mirror) {
      expect(real.includes(c), `${c} is offered by the editor but NOT served by the DLZ`).toBe(true);
    }

    // Belt-and-braces over both loops, and the assertion that carries the two
    // SIZES into the failure message — a mirror that drifted by a duplicate or
    // by count alone shows up here even if every individual name passed above.
    expect(
      [...mirror].sort(),
      `editor mirror (${mirror.length} entries) vs adls-client KNOWN_CONTAINERS (${real.length} entries)`,
    ).toEqual([...real].sort());
  });

  it('pins the PREDICATE, not the list: exact, case-sensitive names only', () => {
    // Deliberately NOT a drift guard — the set comparison above is. These pin
    // two behaviours of `isClientKnownContainer` itself that a set comparison
    // cannot express: ADLS container names are lowercase, and the empty string
    // (the old container-root default that produced #3904) is not a container.
    expect(isClientKnownContainer(''), 'the empty string is not a container').toBe(false);
    expect(isClientKnownContainer('Bronze'), 'container matching is case-sensitive').toBe(false);
  });
});

describe('joinPrefix', () => {
  it('anchors a relative path under the lakehouse root', () => {
    expect(joinPrefix('lakehouses/Foo', 'Tables')).toBe('lakehouses/Foo/Tables');
  });
  it('degrades to the container-relative path when unbound', () => {
    expect(joinPrefix('', 'Tables')).toBe('Tables');
  });
  it('tolerates stray slashes on either side', () => {
    expect(joinPrefix('/lakehouses/Foo/', '/Tables/')).toBe('lakehouses/Foo/Tables');
  });
  it('returns the root itself for an empty relative path', () => {
    expect(joinPrefix('lakehouses/Foo', '')).toBe('lakehouses/Foo');
  });
});

describe('relativeToRoot', () => {
  it('hides the root from breadcrumbs', () => {
    expect(relativeToRoot('lakehouses/Foo', 'lakehouses/Foo/Tables/dim')).toBe('Tables/dim');
    expect(relativeToRoot('lakehouses/Foo', 'lakehouses/Foo')).toBe('');
  });
  it('leaves a path OUTSIDE the root untouched — never claims it is inside', () => {
    expect(relativeToRoot('lakehouses/Foo', 'lakehouses/Foobar/Tables')).toBe('lakehouses/Foobar/Tables');
    expect(relativeToRoot('lakehouses/Foo', 'other/place')).toBe('other/place');
  });
  it('is a no-op when unbound', () => {
    expect(relativeToRoot('', 'Tables/dim')).toBe('Tables/dim');
  });
});

describe('containerRelativePath', () => {
  it('strips the container the catalog scan prefixes onto adlsPath', () => {
    // scanLakehouseTables returns `<container>/<root>/Tables/<name>`, while
    // /api/lakehouse/{preview,history} take container + a CONTAINER-RELATIVE
    // path — passing adlsPath straight through asked for landing/landing/…
    expect(containerRelativePath('landing', 'landing/lakehouses/Foo/Tables/dim'))
      .toBe('lakehouses/Foo/Tables/dim');
  });
  it('leaves an already-relative path alone', () => {
    expect(containerRelativePath('landing', 'lakehouses/Foo/Tables/dim'))
      .toBe('lakehouses/Foo/Tables/dim');
  });
  it('does not strip a container name that is merely a prefix of a folder', () => {
    expect(containerRelativePath('gold', 'goldfish/Tables/dim')).toBe('goldfish/Tables/dim');
  });
  it('tolerates a null container', () => {
    expect(containerRelativePath(null, 'Tables/dim')).toBe('Tables/dim');
  });
});
