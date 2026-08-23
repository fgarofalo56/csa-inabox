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
  bindingFromItemState, joinPrefix, relativeToRoot, containerRelativePath,
} from '../lakehouse-binding';

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
