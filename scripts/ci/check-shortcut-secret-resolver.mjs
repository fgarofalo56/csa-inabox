#!/usr/bin/env node
/**
 * check-shortcut-secret-resolver — only the shortcut-secret resolver may use
 * the raw shortcut credential reads:
 *
 *   `getKeyVaultSecret`       from lib/azure/shortcut-credentials.ts
 *   `getShortcutSecretValue`  from lib/azure/kv-secrets-client.ts
 *
 * WHY: both read a Key Vault secret by NAME with the Console identity; neither
 * checks WHOSE credential it is. `lib/azure/shortcut-secret-resolver.ts` wraps
 * them with the Key Vault name grammar, the `shortcut-credential` purpose
 * policy (lib/azure/kv-secret-purpose.ts) and the ownership check, all before
 * the value is read. A second importer of either raw read is a read path with
 * none of that, so this guard fails the build on one — and on the resolver
 * RE-EXPORTING either symbol, which would hand the raw read to every importer
 * of the resolver without an import this scan can see.
 *
 * WHAT IT READS: every non-test .ts/.tsx under apps/fiab-console (not
 * node_modules/.next), parsed with the SAME import scanner the Unity audit guard
 * uses (`moduleImports` in check-unity-audit-chokepoint.mjs) — named, renamed
 * (`as`), namespace, dynamic `import()`/`require()`, and `export … from`
 * re-exports, by alias or relative specifier. For shortcut-credentials a
 * namespace/dynamic import counts as importing the symbol (it hands over every
 * export). kv-secrets-client is imported that way for OTHER exports
 * (`await import('./kv-secrets-client')` for `getKeyVaultSecretValue`), so for it
 * a namespace/dynamic import counts only when the file also names
 * `getShortcutSecretValue` outside comments. The two modules that DEFINE the
 * reads are skipped (shortcut-credentials.ts unread).
 *
 * LIMITS (inherited from that scanner, see its LIMITS block): a template-literal
 * specifier and the no-whitespace spelling (`import{x}from'…'`) are not seen, and
 * a `.ts`-suffixed specifier is not matched (tsc rejects it here without
 * `allowImportingTsExtensions`). Test files are out of scope — they import the
 * raw reads to mock them.
 *
 * SELF-CHECK: every run first scans embedded fixtures that MUST be flagged and
 * fixtures that must NOT be; a detector that has gone blind fails the run
 * instead of reporting a clean tree. The resolver must itself still import both
 * reads; if it stops, the run fails too, because "no importers" would then mean
 * the anchor moved, not that the tree is clean.
 *
 * Usage: node scripts/ci/check-shortcut-secret-resolver.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleImports, maskComments, SECURABLE_RAW } from './check-unity-audit-chokepoint.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const APP_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');

/** The one module allowed to import the raw reads (app-relative, POSIX). */
export const RESOLVER = 'lib/azure/shortcut-secret-resolver.ts';
/** The raw shortcut-credentials module (reused from the Unity guard, not re-typed). */
export const RAW_MODULE = SECURABLE_RAW;
/** The Key Vault client holding the shortcut-vault read. */
export const KV_CLIENT = 'lib/azure/kv-secrets-client.ts';

/**
 * Every guarded read. `starTakes`: does a namespace/dynamic import of the module
 * count, 'always' or only when the file names the symbol ('if-named').
 */
export const GUARDED = [
  { module: RAW_MODULE, symbol: 'getKeyVaultSecret', starTakes: 'always' },
  { module: KV_CLIENT, symbol: 'getShortcutSecretValue', starTakes: 'if-named' },
];
/** Back-compat name for the first guarded symbol. */
export const GUARDED_SYMBOL = GUARDED[0].symbol;

const GUARDED_NAMES = GUARDED.map((g) => g.symbol);

/** Test/spec/e2e sources — out of scope (they import the raw reads to mock them). */
export function isTestFile(rel) {
  return /(^|\/)__tests__\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || /^e2e\//.test(rel);
}

/** The guarded symbols `src` takes from `g.module`. */
function takes(src, g) {
  const names = moduleImports(src, g.module);
  if (names.includes(g.symbol)) return true;
  if (!names.includes('*')) return false;
  if (g.starTakes === 'always') return true;
  return new RegExp(`\\b${g.symbol}\\b`).test(maskComments(src));
}

/** Does the resolver re-export a guarded read? Returns the offending form, or null. */
export function resolverReexport(src) {
  const masked = maskComments(src);
  const sym = `(?:${GUARDED_NAMES.join('|')})`;
  const forms = [
    [new RegExp(`\\bexport\\s*(?:type\\s+)?\\{[^}]*\\b${sym}\\b[^}]*\\}`), 'export { … }'],
    [/\bexport\s*\*/, 'export *'],
    [new RegExp(`\\bexport\\s+default\\s+${sym}\\b`), 'export default'],
    [new RegExp(`\\bexport\\s+(?:const|let|var)\\s+[^=;]+=\\s*${sym}\\b`), 'export const alias'],
  ];
  for (const [re, label] of forms) if (re.test(masked)) return label;
  return null;
}

/**
 * Analyse app-relative sources. Returns failure strings; [] means clean.
 * @param {Map<string,string>} sources app-relative POSIX path -> source text
 */
export function analyzeShortcutSecretImports(sources) {
  const failures = [];
  const resolverTakes = new Set();
  for (const [rel, src] of sources) {
    if (isTestFile(rel)) continue;
    for (const g of GUARDED) {
      if (rel === g.module || rel === RAW_MODULE) continue;
      if (!takes(src, g)) continue;
      if (rel === RESOLVER) { resolverTakes.add(g.symbol); continue; }
      failures.push(
        `${rel}: imports \`${g.symbol}\` from ${g.module}. ` +
          `Resolve shortcut credentials with \`resolveShortcutSecret(name, owner)\` from ${RESOLVER}, ` +
          'which applies the name grammar, the shortcut-credential purpose policy and the ownership check before any read.',
      );
    }
  }
  if (!sources.has(RESOLVER)) {
    failures.push(`${RESOLVER}: missing — the sanctioned delegate for the shortcut credential reads no longer exists.`);
  } else {
    for (const g of GUARDED) {
      if (!resolverTakes.has(g.symbol)) {
        failures.push(
          `${RESOLVER}: no longer imports \`${g.symbol}\` from ${g.module}. The guard's anchor moved; ` +
            'update GUARDED here rather than reading a clean scan as a clean tree.',
        );
      }
    }
    const reexport = resolverReexport(sources.get(RESOLVER));
    if (reexport) {
      failures.push(
        `${RESOLVER}: re-exports a raw shortcut credential read (${reexport}). Every importer of the resolver ` +
          'would then hold the unchecked read; export only resolveShortcutSecret / assertShortcutSecretUsable.',
      );
    }
  }
  return failures;
}

/** A resolver source that takes both reads and exports neither. */
export const RESOLVER_FIXTURE =
  "import { getKeyVaultSecret } from './shortcut-credentials';\n" +
  "import { getShortcutSecretValue } from './kv-secrets-client';\n" +
  'export async function resolveShortcutSecret() { return getKeyVaultSecret(""); }\n';

/**
 * Embedded controls, run on every invocation. Returns failure strings when the
 * detector disagrees with a fixture whose answer is known.
 */
export function selfCheck() {
  const alias = "import { getKeyVaultSecret } from '@/lib/azure/shortcut-credentials';\n";
  const mustFlag = [
    ['app/api/x/route.ts', alias],
    ['lib/azure/renamed.ts', "import { getKeyVaultSecret as read } from './shortcut-credentials';\n"],
    ['lib/editors/deep/ns.ts', "import * as creds from '../../azure/shortcut-credentials';\n"],
    ['lib/azure/dyn.ts', "export async function f() { return import('./shortcut-credentials'); }\n"],
    ['lib/azure/reexport.ts', "export { getKeyVaultSecret } from './shortcut-credentials';\n"],
    ['app/api/y/route.ts', "import { getShortcutSecretValue } from '@/lib/azure/kv-secrets-client';\n"],
    ['lib/azure/dyn-kv.ts', "const { getShortcutSecretValue } = await import('./kv-secrets-client');\n"],
  ];
  const mustPass = [
    ['lib/azure/gate-only.ts', "import { keyVaultConfigGate } from './shortcut-credentials';\n"],
    ['lib/azure/comment.ts', "// import { getKeyVaultSecret } from './shortcut-credentials';\nexport const a = 1;\n"],
    ['lib/azure/__tests__/mock.test.ts', alias],
    ['lib/azure/other-kv.ts', "const { getKeyVaultSecretValue } = await import('./kv-secrets-client');\n"],
    ['app/api/z/route.ts', "import { putShortcutSecret, shortcutKeyVaultConfigGate } from '@/lib/azure/kv-secrets-client';\n"],
  ];
  const out = [];
  for (const [rel, src] of mustFlag) {
    const f = analyzeShortcutSecretImports(new Map([[RESOLVER, RESOLVER_FIXTURE], [rel, src]]));
    if (!f.some((m) => m.startsWith(`${rel}:`))) out.push(`self-check: fixture ${rel} was NOT flagged`);
  }
  for (const [rel, src] of mustPass) {
    const f = analyzeShortcutSecretImports(new Map([[RESOLVER, RESOLVER_FIXTURE], [rel, src]]));
    if (f.length) out.push(`self-check: fixture ${rel} was flagged: ${f.join(' | ')}`);
  }
  const noAnchor = analyzeShortcutSecretImports(new Map([[RESOLVER, 'export const x = 1;\n']]));
  if (!noAnchor.some((m) => m.startsWith(`${RESOLVER}:`))) out.push('self-check: a resolver without the imports was NOT flagged');
  const reexp = analyzeShortcutSecretImports(new Map([[RESOLVER, `${RESOLVER_FIXTURE}export { getKeyVaultSecret };\n`]]));
  if (!reexp.some((m) => m.includes('re-exports'))) out.push('self-check: a resolver re-export was NOT flagged');
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
    `✓ shortcut-secret-resolver: ${sources.size} source files scanned; ${GUARDED_NAMES.join(' and ')} are imported only by ` +
      `${RESOLVER}, which does not re-export them (embedded controls passed).`,
  );
}
