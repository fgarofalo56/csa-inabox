/**
 * LOOM BRAIN W10 — THE HISTORY WIRING (#3936, S1 from the review of #4014).
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * The OK path — the only path that produces findings — could not load W9's
 * history module, and would not have been able to after #3935 merged either.
 * Two independent breaks, both shipped, and NO gate saw either:
 *
 *   1. `tsconfig.cli.json` used `files: ["./cli.ts"]`, so tsc's emit closure
 *      followed STATIC imports only. Both history specifiers are assembled at
 *      RUNTIME (precisely so tsc cannot resolve them while #3935 is unmerged),
 *      so the module was never emitted: 34 .js files, none under
 *      `lib/brain/history/`.
 *   2. `cli.ts`'s store specifier was one directory too high — `../../history/`
 *      from `lib/brain/run/cli.js` is `lib/history/`, not `lib/brain/history/`.
 *      It had been copied from `azure/history-writer.ts`, which sits one level
 *      DEEPER and correctly needs two.
 *
 * Nothing caught it because nothing had it in its POPULATION: no test referenced
 * `makeHistoryStore` or `resolveHistoryModule`, `cli-buildable.test.ts` walks
 * static specifiers only, and the live Commercial receipt ran with the history
 * writer swapped for the in-memory one. Three gates, three different blind
 * spots, same defect.
 *
 * ── HOW THIS TEST AVOIDS BEING A FOURTH ────────────────────────────────────
 * It resolves the EXPORTED specifier constants against a stub tree that mirrors
 * the emitted layout byte for byte, using node's own resolver. It does not
 * restate the specifiers — a test that writes its own copy of the string under
 * test is a test of its own copy.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HISTORY_STORE_SPECIFIER } from '../cli';
import { HISTORY_MODULE_SPECIFIER, resolveHistoryModule } from '../azure/history-writer';

const CONSOLE_ROOT = resolve(__dirname, '..', '..', '..', '..');

/**
 * A stub tree mirroring the EMITTED layout:
 *
 *     lib/brain/run/cli.js
 *     lib/brain/run/azure/history-writer.js
 *     lib/brain/history/index.js
 *     lib/brain/history/cosmos-store.js
 */
const stub = mkdtempSync(join(tmpdir(), 'loom-brain-w10-'));
mkdirSync(join(stub, 'lib/brain/run/azure'), { recursive: true });
mkdirSync(join(stub, 'lib/brain/history'), { recursive: true });
writeFileSync(
  join(stub, 'lib/brain/history/index.js'),
  'module.exports = { captureGraphVersion: async () => ({}) };',
);
writeFileSync(
  join(stub, 'lib/brain/history/cosmos-store.js'),
  'module.exports = { CosmosGraphHistoryStore: class {} };',
);
writeFileSync(join(stub, 'lib/brain/run/cli.js'), '');
writeFileSync(join(stub, 'lib/brain/run/azure/history-writer.js'), '');

afterAll(() => rmSync(stub, { recursive: true, force: true }));

/** Resolve `spec` exactly as node would, from `fromFile` in the stub tree. */
function resolveFrom(fromFile: string, spec: string): string | null {
  const req = createRequire(join(stub, fromFile));
  try {
    return relative(stub, req.resolve(spec)).split('\\').join('/');
  } catch {
    return null;
  }
}

describe('history wiring — the runtime specifiers resolve to lib/brain/history', () => {
  it('the STORE specifier resolves from lib/brain/run/cli.js', () => {
    // This is the assertion that would have caught the shipped defect. The
    // wrong value (`../../history/cosmos-store`) resolves to `lib/history/` and
    // returns null here.
    expect(resolveFrom('lib/brain/run/cli.js', HISTORY_STORE_SPECIFIER)).toBe(
      'lib/brain/history/cosmos-store.js',
    );
  });

  it('the MODULE specifier resolves from lib/brain/run/azure/history-writer.js', () => {
    expect(resolveFrom('lib/brain/run/azure/history-writer.js', HISTORY_MODULE_SPECIFIER)).toBe(
      'lib/brain/history/index.js',
    );
  });

  it('CONTROL: the depths are DIFFERENT, so one prefix cannot serve both', () => {
    // The defect was a copy between two files at different depths. Asserting the
    // two specifiers are not equal turns that copy into a red test rather than
    // something a reviewer has to notice.
    expect(HISTORY_STORE_SPECIFIER).not.toBe(HISTORY_MODULE_SPECIFIER);
    expect(HISTORY_STORE_SPECIFIER.split('/').filter((p) => p === '..')).toHaveLength(1);
    expect(HISTORY_MODULE_SPECIFIER.split('/').filter((p) => p === '..')).toHaveLength(2);
  });

  it('CONTROL: the wrong prefix genuinely fails in this harness', () => {
    // Without this, a harness that resolved everything (or nothing) would give
    // the same green as a correct one.
    expect(resolveFrom('lib/brain/run/cli.js', '../../history/cosmos-store')).toBeNull();
    expect(resolveFrom('lib/brain/run/azure/history-writer.js', '../history/index')).toBeNull();
  });
});

describe('history wiring — the CLI emit closure', () => {
  const raw = readFileSync(join(CONSOLE_ROOT, 'lib/brain/run/tsconfig.cli.json'), 'utf8');
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as {
    include?: string[];
    files?: string[];
    compilerOptions: Record<string, unknown>;
  };

  it('uses `include` covering lib/brain/history, NOT a static `files` list', () => {
    // `files` follows STATIC imports only. Both history specifiers are assembled
    // at runtime, so under `files` the module is never emitted and the OK path
    // dies with a module-not-found at 04:11 UTC.
    expect(config.files).toBeUndefined();
    expect(config.include).toBeDefined();
    expect(config.include).toContain('./cli.ts');
    expect(config.include?.some((g) => g.includes('history'))).toBe(true);
  });

  it('the history glob is relative to lib/brain/run and points at a real directory path', () => {
    const glob = config.include?.find((g) => g.includes('history')) ?? '';
    const base = glob.replace(/\/\*\*.*$/, '');
    const resolved = resolve(CONSOLE_ROOT, 'lib/brain/run', base);
    // W9 (#3935) is not on this branch, so the DIRECTORY may not exist yet. What
    // must be true today is that the glob points where W9 will land — otherwise
    // it silently keeps matching nothing forever.
    expect(relative(CONSOLE_ROOT, resolved).split('\\').join('/')).toBe('lib/brain/history');
  });

  it('excludes tests from the emitted CLI', () => {
    expect(config.exclude ?? []).toContain('**/__tests__/**');
  });
});

describe('history wiring — resolveHistoryModule fails CLOSED and says only what it knows', () => {
  it('throws when the module is absent', async () => {
    await expect(
      resolveHistoryModule(async () => {
        throw new Error("Cannot find module '../../history/index'");
      }),
    ).rejects.toThrow(/could not load the graph-history module/);
  });

  it('throws when the module resolves but has the wrong shape', async () => {
    await expect(resolveHistoryModule(async () => ({ somethingElse: 1 }))).rejects.toThrow(
      /does not export a callable/,
    );
  });

  it('R7: the message names BOTH candidate causes and asserts NEITHER', async () => {
    // The shipped message said the remediation was "land #3935 (W9 graph
    // history)". That is a cause the code never established, and it was WRONG —
    // the emit closure was the real defect, so it would have sent the next
    // investigation to the wrong PR.
    let message = '';
    try {
      await resolveHistoryModule(async () => {
        throw new Error('boom');
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('states ONLY what was established');
    expect(message).toContain('IS THE MODULE IN THE TREE?');
    expect(message).toContain('IS IT IN THE COMPILED OUTPUT?');
    // and it must NOT present one of them as THE remediation
    expect(message).not.toMatch(/Remediation: land #3935/);
  });

  it('returns the module when the shape is right', async () => {
    const mod = await resolveHistoryModule(async () => ({
      captureGraphVersion: async () => ({}),
    }));
    expect(typeof mod.captureGraphVersion).toBe('function');
  });
});

describe('history wiring — makeHistoryStore', () => {
  it('accepts a class export', async () => {
    const { makeHistoryStore } = await import('../cli');
    const store = await makeHistoryStore(async () => ({ CosmosGraphHistoryStore: class {} }));
    expect(store).toBeTypeOf('object');
  });

  it('accepts a factory export', async () => {
    const { makeHistoryStore } = await import('../cli');
    const store = await makeHistoryStore(async () => ({
      cosmosGraphHistoryStore: () => ({ marker: true }),
    }));
    expect(store).toEqual({ marker: true });
  });

  it('THROWS on any other shape — there is no fallback store', async () => {
    const { makeHistoryStore } = await import('../cli');
    await expect(makeHistoryStore(async () => ({ nope: 1 }))).rejects.toThrow(
      /REFUSES to continue without somewhere to write the graph version/,
    );
  });

  it('the failure message quotes the specifier it actually used', async () => {
    const { makeHistoryStore } = await import('../cli');
    let message = '';
    try {
      await makeHistoryStore(async () => ({}));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(HISTORY_STORE_SPECIFIER);
  });
});

/**
 * The decisive check: COMPILE the CLI and assert the emitted tree.
 *
 * Slow (a full tsc pass), so it is one test rather than several, and it asserts
 * the two properties the cheaper tests above cannot: that the config actually
 * compiles, and that `cli.js` lands where the workflow expects it.
 */
describe('history wiring — the CLI actually compiles and emits where the workflow looks', () => {
  it('emits lib/brain/run/cli.js under the configured outDir', () => {
    const out = join(CONSOLE_ROOT, 'temp', 'brain-scan-build');
    // `node_modules/typescript/bin/tsc` through `process.execPath`, NOT
    // `node_modules/.bin/tsc`: on Windows the latter is a `.cmd` shim and
    // `execFileSync` gets ENOENT on the extensionless name. Measured here.
    execFileSync(
      process.execPath,
      [
        join(CONSOLE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
        '-p',
        'lib/brain/run/tsconfig.cli.json',
      ],
      { cwd: CONSOLE_ROOT, stdio: 'pipe', encoding: 'utf8' },
    );
    const entry = join(out, 'lib', 'brain', 'run', 'cli.js');
    expect(existsSync(entry), `${entry} was not emitted`).toBe(true);
    // The workflow runs exactly this path; keep them in step.
    const wf = readFileSync(
      join(CONSOLE_ROOT, '..', '..', '.github', 'workflows', 'loom-brain-scan.yml'),
      'utf8',
    );
    expect(wf).toContain('temp/brain-scan-build/lib/brain/run/cli.js');
    expect(dirname(entry).endsWith(join('lib', 'brain', 'run'))).toBe(true);
  }, 180_000);
});
