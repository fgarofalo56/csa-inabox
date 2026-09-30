/**
 * node:test for scripts/ci/check-shortcut-secret-resolver.mjs.
 *
 * WHAT BREAKS EACH ASSERTION:
 *   - "flags a route importing the raw read": a detector that skips app/ files,
 *     or that only matches relative specifiers (the fixture uses the `@/` alias).
 *   - "flags a renamed / namespace / dynamic import": `takesGuarded` checking
 *     only the literal symbol name, or dropping the `'*'` arm.
 *   - "does not flag keyVaultConfigGate / tests / comments": over-matching —
 *     the real tree imports keyVaultConfigGate from the engine module.
 *   - "anchor": deleting the resolver-must-import check makes a resolver that
 *     stopped delegating read as a clean tree.
 *   - "real tree is clean" is the regression pin for THIS change; "real tree
 *     with a caller switched back" is its positive control — the SAME real
 *     sources with one real caller rewritten to the pre-change import. If that
 *     control stops failing, the clean result above means nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeShortcutSecretImports,
  selfCheck,
  readSources,
  RESOLVER,
} from '../check-shortcut-secret-resolver.mjs';

const RESOLVER_SRC = "import { getKeyVaultSecret } from './shortcut-credentials';\n";
const scan = (entries) => analyzeShortcutSecretImports(new Map([[RESOLVER, RESOLVER_SRC], ...entries]));

test('flags a route importing the raw read by alias', () => {
  const f = scan([['app/api/lakehouse/shortcuts/route.ts', "import { getKeyVaultSecret } from '@/lib/azure/shortcut-credentials';\n"]]);
  assert.equal(f.length, 1);
  assert.match(f[0], /^app\/api\/lakehouse\/shortcuts\/route\.ts: imports `getKeyVaultSecret`/);
});

test('flags renamed, namespace, dynamic and re-export forms', () => {
  const cases = [
    ['lib/azure/a.ts', "import { getKeyVaultSecret as g } from './shortcut-credentials';\n"],
    ['lib/azure/b.ts', "import * as c from './shortcut-credentials';\n"],
    ['lib/azure/c.ts', "const m = await import('./shortcut-credentials');\n"],
    ['lib/azure/d.ts', "export { getKeyVaultSecret } from './shortcut-credentials';\n"],
  ];
  for (const [rel, src] of cases) {
    const f = scan([[rel, src]]);
    assert.equal(f.length, 1, `${rel} should be flagged: ${src}`);
    assert.ok(f[0].startsWith(`${rel}:`));
  }
});

test('does not flag keyVaultConfigGate, test files, or a commented-out import', () => {
  assert.deepEqual(scan([['lib/azure/shortcut-engines.ts', "import { keyVaultConfigGate } from './shortcut-credentials';\n"]]), []);
  assert.deepEqual(scan([['lib/azure/__tests__/x.test.ts', "import { getKeyVaultSecret } from '../shortcut-credentials';\n"]]), []);
  assert.deepEqual(scan([['lib/azure/y.ts', "// import { getKeyVaultSecret } from './shortcut-credentials';\n"]]), []);
});

test('the resolver itself is the one sanctioned importer', () => {
  assert.deepEqual(analyzeShortcutSecretImports(new Map([[RESOLVER, RESOLVER_SRC]])), []);
});

test('anchor: a resolver that no longer imports the raw read fails the scan', () => {
  const f = analyzeShortcutSecretImports(new Map([[RESOLVER, 'export const x = 1;\n']]));
  assert.equal(f.length, 1);
  assert.match(f[0], /no longer imports `getKeyVaultSecret`/);
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

test('positive control: the real tree with one caller switched back to the raw read fails', () => {
  const sources = readSources();
  const rel = 'app/api/lakehouse/shortcuts/test/route.ts';
  const src = sources.get(rel);
  assert.ok(src, `${rel} not found`);
  const reverted = "import { getKeyVaultSecret } from '@/lib/azure/shortcut-credentials';\n" + src;
  sources.set(rel, reverted);
  const f = analyzeShortcutSecretImports(sources);
  assert.equal(f.length, 1);
  assert.ok(f[0].startsWith(`${rel}:`));
});
