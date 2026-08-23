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
  it('mirrors adls-client KNOWN_CONTAINERS exactly', () => {
    // The client bundle cannot import adls-client (it pulls in the credential
    // chain), so the container list is duplicated in lakehouse-binding.ts. This
    // spec runs in node, CAN import the real one, and fails the moment the two
    // disagree — so a container added to the DLZ and not mirrored here is a red
    // test rather than a lakehouse the editor silently refuses to bind.
    for (const c of KNOWN_CONTAINERS) {
      expect(isClientKnownContainer(c), `${c} is served by the DLZ but unknown to the editor`).toBe(true);
    }
    // …and nothing beyond it. Enumerated rather than compared as a set so the
    // failure names the offender.
    for (const c of ['customer-owned', 'onelake', '', 'Bronze']) {
      expect(isClientKnownContainer(c), `${c} is not a DLZ container`).toBe(false);
    }
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
