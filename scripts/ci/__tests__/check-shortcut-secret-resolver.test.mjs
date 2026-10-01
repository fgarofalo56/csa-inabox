/**
 * node:test for scripts/ci/check-shortcut-secret-resolver.mjs.
 *
 * WHAT BREAKS EACH ASSERTION:
 *   - "flags a route importing a raw read": a detector that skips app/ files,
 *     only matches relative specifiers (the fixtures use the `@/` alias), or
 *     watches only one of the two guarded modules.
 *   - "flags renamed / namespace / dynamic / re-export forms": `takes` checking
 *     only the literal symbol name, or dropping the `'*'` arm.
 *   - "does not flag …": over-matching — the real tree imports keyVaultConfigGate
 *     from shortcut-credentials and `await import('./kv-secrets-client')` for
 *     OTHER reads (git-integration-client), which a star-always rule on
 *     kv-secrets-client would flag.
 *   - "resolver re-export": deleting `resolverReexport` — the resolver is the one
 *     file skipped by the import scan, so nothing else catches it.
 *   - "anchor": deleting the resolver-must-import checks makes a resolver that
 *     stopped delegating read as a clean tree.
 *   - "real tree is clean" is the regression pin; the two "positive control"
 *     tests are the SAME real sources with one real caller reverted to each raw
 *     read. If they stop failing, the clean result means nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeShortcutSecretImports,
  resolverReexport,
  selfCheck,
  readSources,
  RESOLVER,
  RESOLVER_FIXTURE,
} from '../check-shortcut-secret-resolver.mjs';

const scan = (entries) => analyzeShortcutSecretImports(new Map([[RESOLVER, RESOLVER_FIXTURE], ...entries]));

test('flags a route importing either raw read by alias', () => {
  const a = scan([['app/api/lakehouse/shortcuts/route.ts', "import { getKeyVaultSecret } from '@/lib/azure/shortcut-credentials';\n"]]);
  assert.equal(a.length, 1);
  assert.match(a[0], /^app\/api\/lakehouse\/shortcuts\/route\.ts: imports `getKeyVaultSecret`/);
  const b = scan([['app/api/lakehouse/shortcuts/browse/route.ts', "import { getShortcutSecretValue, shortcutKeyVaultConfigGate } from '@/lib/azure/kv-secrets-client';\n"]]);
  assert.equal(b.length, 1);
  assert.match(b[0], /imports `getShortcutSecretValue` from lib\/azure\/kv-secrets-client\.ts/);
});

test('flags renamed, namespace, dynamic and re-export forms', () => {
  const cases = [
    ['lib/azure/a.ts', "import { getKeyVaultSecret as g } from './shortcut-credentials';\n"],
    ['lib/azure/b.ts', "import * as c from './shortcut-credentials';\n"],
    ['lib/azure/c.ts', "const m = await import('./shortcut-credentials');\n"],
    ['lib/azure/d.ts', "export { getKeyVaultSecret } from './shortcut-credentials';\n"],
    ['lib/azure/e.ts', "import { getShortcutSecretValue as v } from './kv-secrets-client';\n"],
    ['lib/azure/f.ts', "const { getShortcutSecretValue } = await import('./kv-secrets-client');\n"],
    ['lib/azure/g.ts', "export { getShortcutSecretValue } from './kv-secrets-client';\n"],
  ];
  for (const [rel, src] of cases) {
    const f = scan([[rel, src]]);
    assert.equal(f.length, 1, `${rel} should be flagged: ${src}`);
    assert.ok(f[0].startsWith(`${rel}:`));
  }
});

test('does not flag other exports of either module, test files, or a commented-out import', () => {
  assert.deepEqual(scan([['lib/azure/shortcut-engines.ts', "import { keyVaultConfigGate } from './shortcut-credentials';\n"]]), []);
  assert.deepEqual(scan([['lib/azure/git.ts', "const { getKeyVaultSecretValue } = await import('./kv-secrets-client');\n"]]), []);
  assert.deepEqual(scan([['app/api/x/route.ts', "import { putShortcutSecret } from '@/lib/azure/kv-secrets-client';\n"]]), []);
  assert.deepEqual(scan([['lib/azure/__tests__/x.test.ts', "import { getKeyVaultSecret } from '../shortcut-credentials';\n"]]), []);
  assert.deepEqual(scan([['lib/azure/y.ts', "// import { getKeyVaultSecret } from './shortcut-credentials';\n"]]), []);
});

test('the resolver itself is the one sanctioned importer', () => {
  assert.deepEqual(analyzeShortcutSecretImports(new Map([[RESOLVER, RESOLVER_FIXTURE]])), []);
});

test('resolver re-export of a raw read fails the scan, in every form', () => {
  for (const tail of [
    'export { getKeyVaultSecret };\n',
    'export { getShortcutSecretValue as v };\n',
    "export * from './shortcut-credentials';\n",
    'export default getKeyVaultSecret;\n',
    'export const raw = getShortcutSecretValue;\n',
  ]) {
    assert.ok(resolverReexport(RESOLVER_FIXTURE + tail), `not detected: ${tail}`);
    const f = analyzeShortcutSecretImports(new Map([[RESOLVER, RESOLVER_FIXTURE + tail]]));
    assert.ok(f.some((m) => m.includes('re-exports')), `not failed: ${tail}`);
  }
  assert.equal(resolverReexport(RESOLVER_FIXTURE + 'export type { Foo };\n'), null);
  assert.equal(resolverReexport(RESOLVER_FIXTURE + '// export { getKeyVaultSecret };\n'), null);
});

test('anchor: a resolver that no longer imports a raw read fails the scan', () => {
  const f = analyzeShortcutSecretImports(new Map([[RESOLVER, "import { getKeyVaultSecret } from './shortcut-credentials';\n"]]));
  assert.equal(f.length, 1);
  assert.match(f[0], /no longer imports `getShortcutSecretValue`/);
  const missing = analyzeShortcutSecretImports(new Map());
  assert.match(missing[0], /missing/);
});

test('embedded controls pass', () => {
  assert.deepEqual(selfCheck(), []);
});

test('real tree is clean', () => {
  const sources = readSources();
  assert.ok(sources.size > 1000, `expected the real console tree, got ${sources.size} files`);
  assert.ok(sources.has(RESOLVER));
  assert.deepEqual(analyzeShortcutSecretImports(sources), []);
});

test('positive control: the real tree with the Test route switched back to getKeyVaultSecret fails', () => {
  const sources = readSources();
  const rel = 'app/api/lakehouse/shortcuts/test/route.ts';
  const src = sources.get(rel);
  assert.ok(src, `${rel} not found`);
  sources.set(rel, "import { getKeyVaultSecret } from '@/lib/azure/shortcut-credentials';\n" + src);
  const f = analyzeShortcutSecretImports(sources);
  assert.equal(f.length, 1);
  assert.ok(f[0].startsWith(`${rel}:`));
});

test('positive control: the real tree with browse switched back to getShortcutSecretValue fails', () => {
  const sources = readSources();
  const rel = 'app/api/lakehouse/shortcuts/browse/route.ts';
  const src = sources.get(rel);
  assert.ok(src, `${rel} not found`);
  sources.set(rel, "import { getShortcutSecretValue } from '@/lib/azure/kv-secrets-client';\n" + src);
  const f = analyzeShortcutSecretImports(sources);
  assert.equal(f.length, 1);
  assert.ok(f[0].startsWith(`${rel}:`));
});
