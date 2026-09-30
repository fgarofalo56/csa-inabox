#!/usr/bin/env node
/**
 * check-shortcut-secret-resolver — only the shortcut-secret resolver may import
 * `getKeyVaultSecret` from `lib/azure/shortcut-credentials.ts`.
 *
 * WHY: `getKeyVaultSecret` resolves ANY Key Vault secret name with the Console
 * identity and applies no name policy. `lib/azure/shortcut-secret-resolver.ts`
 * wraps it with the `shortcut-credential` purpose policy
 * (lib/azure/kv-secret-purpose.ts) and an ownership check, both before the
 * vault call. A second importer of the raw function is a read path with
 * neither, so this guard fails the build on one.
 *
 * WHAT IT READS: every non-test .ts/.tsx under apps/fiab-console (not
 * node_modules/.next), parsed with the SAME import scanner the Unity audit guard
 * uses for this module (`moduleImports` in check-unity-audit-chokepoint.mjs) —
 * named, renamed (`as`), namespace, dynamic `import()`/`require()`, and
 * `export … from` re-exports, by alias or relative specifier. A namespace or
 * dynamic import counts as importing the symbol, because it hands over every
 * export. `shortcut-credentials.ts` itself is skipped: it defines the function.
 *
 * LIMITS (inherited from that scanner, see its LIMITS block): a template-literal
 * specifier and the no-whitespace spelling (`import{x}from'…'`) are not seen.
 * Test files are out of scope — they import the raw function to mock it.
 *
 * SELF-CHECK: every run first scans embedded fixtures that MUST be flagged and
 * fixtures that must NOT be; a detector that has gone blind fails the run
 * instead of reporting a clean tree. The resolver must itself still import the
 * function (it is the one sanctioned delegate); if it stops, the run fails too,
 * because "no importers" would then mean the anchor moved, not that the tree is
 * clean.
 *
 * Usage: node scripts/ci/check-shortcut-secret-resolver.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleImports, SECURABLE_RAW } from './check-unity-audit-chokepoint.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const APP_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');

/** The one module allowed to import the raw read (app-relative, POSIX). */
export const RESOLVER = 'lib/azure/shortcut-secret-resolver.ts';
/** The raw module (app-relative, POSIX) — reused from the Unity guard, not re-typed. */
export const RAW_MODULE = SECURABLE_RAW;
/** The raw, policy-free read. */
export const GUARDED_SYMBOL = 'getKeyVaultSecret';

/** True when `names` (from moduleImports) hands over the guarded symbol. */
function takesGuarded(names) {
  return names.includes(GUARDED_SYMBOL) || names.includes('*');
}

/** Test/spec/e2e sources — out of scope (they import the raw read to mock it). */
export function isTestFile(rel) {
  return /(^|\/)__tests__\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || /^e2e\//.test(rel);
}

/**
 * Analyse app-relative sources. Returns failure strings; [] means clean.
 * @param {Map<string,string>} sources app-relative POSIX path -> source text
 */
export function analyzeShortcutSecretImports(sources) {
  const failures = [];
  let resolverImports = false;
  for (const [rel, src] of sources) {
    if (rel === RAW_MODULE || isTestFile(rel)) continue;
    const names = moduleImports(src, RAW_MODULE);
    if (!takesGuarded(names)) continue;
    if (rel === RESOLVER) { resolverImports = true; continue; }
    failures.push(
      `${rel}: imports \`${GUARDED_SYMBOL}\` from ${RAW_MODULE} (${names.join(', ')}). ` +
        `Resolve shortcut credentials with \`resolveShortcutSecret(name, owner)\` from ${RESOLVER}, ` +
        'which applies the shortcut-credential purpose policy and the ownership check before any vault call.',
    );
  }
  if (!sources.has(RESOLVER)) {
    failures.push(`${RESOLVER}: missing — the sanctioned delegate for ${GUARDED_SYMBOL} no longer exists.`);
  } else if (!resolverImports) {
    failures.push(
      `${RESOLVER}: no longer imports \`${GUARDED_SYMBOL}\` from ${RAW_MODULE}. The guard's anchor moved; ` +
        'update RESOLVER/RAW_MODULE here rather than reading a clean scan as a clean tree.',
    );
  }
  return failures;
}

/**
 * Embedded controls, run on every invocation. Returns failure strings when the
 * detector disagrees with a fixture whose answer is known.
 */
export function selfCheck() {
  const alias = `import { ${GUARDED_SYMBOL} } from '@/lib/azure/shortcut-credentials';\n`;
  const resolverSrc = `import { ${GUARDED_SYMBOL} } from './shortcut-credentials';\n`;
  const mustFlag = [
    ['app/api/x/route.ts', alias],
    ['lib/azure/renamed.ts', `import { ${GUARDED_SYMBOL} as read } from './shortcut-credentials';\n`],
    ['lib/editors/deep/ns.ts', "import * as creds from '../../azure/shortcut-credentials';\n"],
    ['lib/azure/dyn.ts', "export async function f() { return import('./shortcut-credentials'); }\n"],
    ['lib/azure/reexport.ts', `export { ${GUARDED_SYMBOL} } from './shortcut-credentials';\n`],
  ];
  const mustPass = [
    ['lib/azure/gate-only.ts', "import { keyVaultConfigGate } from './shortcut-credentials';\n"],
    ['lib/azure/comment.ts', `// import { ${GUARDED_SYMBOL} } from './shortcut-credentials';\nexport const a = 1;\n`],
    ['lib/azure/__tests__/mock.test.ts', alias],
  ];
  const out = [];
  for (const [rel, src] of mustFlag) {
    const f = analyzeShortcutSecretImports(new Map([[RESOLVER, resolverSrc], [rel, src]]));
    if (!f.some((m) => m.startsWith(`${rel}:`))) out.push(`self-check: fixture ${rel} was NOT flagged`);
  }
  for (const [rel, src] of mustPass) {
    const f = analyzeShortcutSecretImports(new Map([[RESOLVER, resolverSrc], [rel, src]]));
    if (f.length) out.push(`self-check: fixture ${rel} was flagged: ${f.join(' | ')}`);
  }
  const noAnchor = analyzeShortcutSecretImports(new Map([[RESOLVER, 'export const x = 1;\n']]));
  if (!noAnchor.some((m) => m.startsWith(`${RESOLVER}:`))) out.push('self-check: a resolver without the import was NOT flagged');
  return out;
}

const SKIP_DIRS = new Set(['node_modules', '.next', 'out', 'coverage', 'playwright-report', 'test-results']);

/** Read every in-scope source under APP_ROOT (app-relative POSIX keys). Skips the raw module unread. */
export function readSources(root = APP_ROOT) {
  const sources = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
        continue;
      }
      if (!/\.(ts|tsx|mts|cts)$/.test(e.name) || e.name.endsWith('.d.ts')) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (rel === RAW_MODULE || isTestFile(rel)) continue;
      sources.set(rel, fs.readFileSync(abs, 'utf8'));
    }
  };
  walk(root);
  return sources;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const blind = selfCheck();
  if (blind.length) {
    console.error('\n✗ shortcut-secret-resolver: the detector failed its embedded controls\n');
    for (const f of blind) console.error(`  - ${f}`);
    process.exit(1);
  }
  const sources = readSources();
  const failures = analyzeShortcutSecretImports(sources);
  if (failures.length) {
    console.error('\n✗ shortcut-secret-resolver FAILED\n');
    for (const f of failures) console.error(`  - ${f}`);
    console.error('');
    process.exit(1);
  }
  console.log(
    `✓ shortcut-secret-resolver: ${sources.size} source files scanned; ${GUARDED_SYMBOL} is imported only by ${RESOLVER} ` +
      '(embedded controls passed).',
  );
}
