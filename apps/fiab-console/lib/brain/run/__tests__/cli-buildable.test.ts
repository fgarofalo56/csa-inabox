/**
 * LOOM BRAIN W10 — the CLI must stay COMPILABLE AND RUNNABLE (#3936).
 *
 * The scheduled scan runs OUTSIDE the console image: a plain Node process
 * compiled by `lib/brain/run/tsconfig.cli.json`, because the console Container
 * App is itself one of the things that may be STOPPED when the estate is paused.
 * A scheduler that could only run inside the thing it monitors cannot report
 * that the thing is down.
 *
 * ── THE PROPERTY THAT WILL ROT SILENTLY WITHOUT THIS TEST ─────────────────
 * `tsc` RESOLVES the console's `@/*` path mapping when typechecking but does NOT
 * rewrite the specifier on emit. So an `@/lib/x` import anywhere in the CLI's
 * dependency tree typechecks perfectly, passes `next build`, passes vitest — and
 * then fails at 04:11 UTC in a scheduled run with `Cannot find module '@/lib/x'`,
 * which reads like a broken install rather than like the source edit that caused
 * it.
 *
 * The CLI tsconfig omits `paths` so that edit is a COMPILE error. This test
 * asserts the closure it depends on: every module the CLI reaches transitively
 * is alias-free. It walks the import graph rather than checking the entrypoint,
 * because the failure is always three files down.
 *
 * MEASURED while building this lane: `lib/azure/fetch-with-timeout.ts` used to
 * import `@/lib/resilience/fault-injection`, which is why the CLI reached
 * `lib/azure/cloud-endpoints` (alias-free) and NOT `lib/azure/aca-managed-identity`
 * (which pulls in `fetch-with-timeout`). That specifier is now RELATIVE (#4040),
 * so the constraint has moved: the CLI may reach those modules, and this walk is
 * what keeps them alias-free.
 *
 * ── THE WALKER WAS BLIND TO THE ONE MODULE THAT BROKE (#3993 merge) ───────
 * Seeding only `cli.ts` follows STATIC imports, and the two history specifiers
 * are assembled at RUNTIME (`HISTORY_MODULE_SPECIFIER`,
 * `HISTORY_STORE_SPECIFIER`) precisely so tsc could not resolve them while W9
 * was unmerged. So `lib/brain/history/**` was never in this walk — and when W9
 * landed it brought TWO aliases into the emit closure:
 *
 *     lib/brain/history/cosmos-store.ts -> @/lib/azure/aca-managed-identity
 *     lib/azure/fetch-with-timeout.ts   -> @/lib/resilience/fault-injection
 *
 * …and this test stayed green over both. `history-wiring.test.ts` caught them
 * because it actually compiles the config, but the guard whose entire job is the
 * alias closure reported clean. The seeds below are therefore derived from the
 * exported specifiers rather than hard-coded, so a future runtime-resolved
 * import cannot fall outside the population the same way.
 *
 * ── RESOLVED, AND HOW (#4040) ────────────────────────────────────────────
 * Both hits above are now relative, plus a third this walker could not see at
 * all: `lib/resilience/fault-injection.ts:215` reached `@/lib/admin/audit-stream`
 * through a DYNAMIC import, and `tsc` resolves a literal dynamic specifier, so it
 * was a TS2307 as well. It became an injected audit sink wired by the gated chaos
 * route (`lib/resilience/__tests__/fault-audit-sink-wiring.test.ts` asserts the
 * audit still happens). Do NOT restore this guard to green in future by narrowing
 * the seeds — that returns it to reporting clean over a lane that cannot run.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HISTORY_MODULE_SPECIFIER } from '../azure/history-writer';
import { HISTORY_STORE_SPECIFIER } from '../cli';

const CONSOLE_ROOT = resolve(__dirname, '..', '..', '..', '..');
const ENTRY = join(CONSOLE_ROOT, 'lib', 'brain', 'run', 'cli.ts');

/**
 * The RUNTIME-RESOLVED seeds, derived from the specifiers the code actually
 * uses rather than restated here.
 *
 * `HISTORY_MODULE_SPECIFIER` is relative to the EMITTED
 * `lib/brain/run/azure/history-writer.js`; `HISTORY_STORE_SPECIFIER` to the
 * emitted `lib/brain/run/cli.js`. Both are resolved from their emitting source
 * file's directory, which is the same relative position in the source tree.
 */
const RUNTIME_SEEDS: readonly (readonly [from: string, spec: string])[] = [
  [join(CONSOLE_ROOT, 'lib', 'brain', 'run', 'azure', 'history-writer.ts'), HISTORY_MODULE_SPECIFIER],
  [ENTRY, HISTORY_STORE_SPECIFIER],
];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[\s\S]*?)\s+from\s+'([^']+)'/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s+'([^']+)'/g;
// LITERAL DYNAMIC imports count too, and this walker did not see them (#4040).
// `tsc` resolves `import('…')` when the specifier is a literal and emits a
// `require()` for it, so an alias there is a TS2307 at build time and a
// MODULE_NOT_FOUND at 04:11 UTC — identical consequence, and it was the third
// blocking specifier while this population held only the static two.
const DYNAMIC_IMPORT_RE = /\bimport\(\s*'([^']+)'\s*\)/g;

const ALIAS_RE = /^@\//;

function specifiersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT_RE)) out.push(m[1]);
  for (const m of text.matchAll(BARE_IMPORT_RE)) out.push(m[1]);
  for (const m of text.matchAll(DYNAMIC_IMPORT_RE)) out.push(m[1]);
  return out;
}

function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Walk the CLI's transitive import graph over first-party source. */
function walk(): { files: string[]; aliasHits: string[]; seeds: string[] } {
  const seen = new Set<string>();
  const aliasHits: string[] = [];
  const seeds: string[] = [ENTRY];

  // The runtime-resolved history modules are part of the emit closure and are
  // reached by NO static import, so they have to be seeded explicitly. A seed
  // that does not resolve is reported, not skipped: a silently-dropped seed
  // returns the walk to exactly the blind spot this exists to close.
  for (const [from, spec] of RUNTIME_SEEDS) {
    const resolved = resolveRelative(from, spec);
    if (resolved === null) {
      aliasHits.push(`UNRESOLVED RUNTIME SEED: ${relative(CONSOLE_ROOT, from)} -> ${spec}`);
      continue;
    }
    seeds.push(resolved);
  }

  const queue = [...seeds];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    // Strip comments: several headers in this tree legitimately QUOTE an alias
    // import while explaining why it is forbidden.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const spec of specifiersIn(code)) {
      if (ALIAS_RE.test(spec)) {
        aliasHits.push(`${relative(CONSOLE_ROOT, file)} -> ${spec}`);
        continue;
      }
      const next = resolveRelative(file, spec);
      if (next !== null) queue.push(next);
    }
  }
  return { files: [...seen], aliasHits, seeds };
}

describe('the CLI dependency closure', () => {
  const { files, aliasHits, seeds } = walk();

  it('has a NON-EMPTY population to examine', () => {
    // A walker that resolved nothing would report zero alias hits and look
    // clean. The entrypoint alone imports eight modules.
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files.some((f) => f.endsWith('cli.ts'))).toBe(true);
    expect(files.some((f) => f.includes('cloud-endpoints'))).toBe(true);
    expect(files.some((f) => f.includes('wire-bindings'))).toBe(true);
    expect(files.some((f) => f.includes(join('brain', 'graph')))).toBe(true);
  });

  it('THE POPULATION INCLUDES THE RUNTIME-RESOLVED HISTORY MODULES', () => {
    // Not an extra assertion — the correction. Both history specifiers resolved,
    // and the modules they reach are IN the walk. Without this the closure
    // reported clean while carrying two aliases (see the header).
    expect(seeds).toHaveLength(1 + RUNTIME_SEEDS.length);
    expect(files.some((f) => f.includes(join('brain', 'history', 'index')))).toBe(true);
    expect(files.some((f) => f.includes(join('brain', 'history', 'cosmos-store')))).toBe(true);
    // NOT `aca-managed-identity` / `fetch-with-timeout`: the walk stops AT an
    // alias and reports it rather than following it, so the modules on the far
    // side are deliberately absent from `files`. They show up in `aliasHits`.
  });

  it('contains NO `@/` alias import anywhere in the transitive closure', () => {
    expect(aliasHits).toEqual([]);
  });

  it('EMBEDDED CONTROL: the walker DOES flag an alias when one is present', () => {
    // Without this, a broken import regex would produce the same empty result as
    // a clean closure.
    const synthetic = "import { x } from '@/lib/resilience/fault-injection';";
    const specs = specifiersIn(synthetic);
    expect(specs).toEqual(['@/lib/resilience/fault-injection']);
    expect(specs.filter((s) => ALIAS_RE.test(s))).toHaveLength(1);
  });

  it('EMBEDDED CONTROL: the walker does not flag a relative import', () => {
    const specs = specifiersIn("import { y } from './verdict';");
    expect(specs.filter((s) => ALIAS_RE.test(s))).toHaveLength(0);
  });

  it('EMBEDDED CONTROL: a LITERAL DYNAMIC import is in the population (#4040)', () => {
    // This is the arm that was missing. `fault-injection.ts:215` reached
    // `@/lib/admin/audit-stream` through `await import('…')`, tsc resolved it,
    // and this walker saw nothing — so the closure reported clean over a
    // specifier that failed the build.
    const specs = specifiersIn("await import('@/lib/admin/audit-stream');");
    expect(specs).toEqual(['@/lib/admin/audit-stream']);
    expect(specs.filter((s) => ALIAS_RE.test(s))).toHaveLength(1);
  });

  it('the CLI tsconfig deliberately declares NO `paths` mapping', () => {
    const raw = readFileSync(join(CONSOLE_ROOT, 'lib', 'brain', 'run', 'tsconfig.cli.json'), 'utf8');
    const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
    const config = JSON.parse(stripped) as {
      compilerOptions: Record<string, unknown>;
      include?: string[];
      files?: string[];
    };
    expect(config.compilerOptions.paths).toBeUndefined();
    // CommonJS, because the console package has no `"type": "module"` and the
    // source uses extensionless relative specifiers.
    expect(config.compilerOptions.module).toBe('commonjs');
    // strict, because lib/brain/types.ts and lib/estate/pause-state.ts carry
    // build-checked type assertions that only hold under strict mode.
    expect(config.compilerOptions.strict).toBe(true);
    // `include`, NOT `files`. `files` follows STATIC imports only, which left
    // the runtime-resolved history module out of the emit closure entirely —
    // see `history-wiring.test.ts` for the full account.
    expect(config.files).toBeUndefined();
    expect(config.include).toContain('./cli.ts');
  });
});
