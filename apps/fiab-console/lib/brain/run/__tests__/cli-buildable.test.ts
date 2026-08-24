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
 * MEASURED while building this lane: `lib/azure/fetch-with-timeout.ts` imports
 * `@/lib/resilience/fault-injection`, which is exactly why the CLI reaches
 * `lib/azure/cloud-endpoints` (alias-free) and NOT `lib/azure/aca-managed-identity`
 * (which pulls in `fetch-with-timeout`). That is a real constraint on what this
 * lane may import, and it is invisible without this check.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CONSOLE_ROOT = resolve(__dirname, '..', '..', '..', '..');
const ENTRY = join(CONSOLE_ROOT, 'lib', 'brain', 'run', 'cli.ts');

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[\s\S]*?)\s+from\s+'([^']+)'/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s+'([^']+)'/g;

const ALIAS_RE = /^@\//;

function specifiersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT_RE)) out.push(m[1]);
  for (const m of text.matchAll(BARE_IMPORT_RE)) out.push(m[1]);
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
function walk(): { files: string[]; aliasHits: string[] } {
  const seen = new Set<string>();
  const queue = [ENTRY];
  const aliasHits: string[] = [];

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
  return { files: [...seen], aliasHits };
}

describe('the CLI dependency closure', () => {
  const { files, aliasHits } = walk();

  it('has a NON-EMPTY population to examine', () => {
    // A walker that resolved nothing would report zero alias hits and look
    // clean. The entrypoint alone imports eight modules.
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files.some((f) => f.endsWith('cli.ts'))).toBe(true);
    expect(files.some((f) => f.includes('cloud-endpoints'))).toBe(true);
    expect(files.some((f) => f.includes('wire-bindings'))).toBe(true);
    expect(files.some((f) => f.includes(join('brain', 'graph')))).toBe(true);
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
