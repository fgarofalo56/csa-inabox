/**
 * LOOM BRAIN W10 — PURITY, with an embedded control.
 *
 * The pure layer (`model`, `verdict`, `lifecycle`, `population`, `report`,
 * `ports`, `scan`, `index`) must not import an Azure SDK, `node:*`, or reach the
 * network. That is what makes every property this lane claims — the regression
 * transition, the suppression expiry, "absence is not a fix", the population
 * comparison — provable with fixtures and no tenant.
 *
 * ── WHY THE CONTROL IS NOT OPTIONAL ────────────────────────────────────────
 * A scanner over a CLEAN directory passes whether or not its matcher works. A
 * broken regex, a wrong path, an empty file list — every one of them produces a
 * confident green. This repo has shipped that failure repeatedly, so the same
 * matcher is run against a synthetic source string that DOES contain each
 * forbidden import, and it must flag every one. That is the guard proving it can
 * still see.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RUN_DIR = join(__dirname, '..');

/** Modules that ARE permitted an Azure import. Everything else is not. */
const IMPURE_ALLOWED = new Set(['cosmos-finding-store.ts', 'cli.ts']);

/** Sub-directories that are entirely the impure edge. */
const IMPURE_DIRS = new Set(['azure', '__tests__']);

const FORBIDDEN: readonly { readonly label: string; readonly re: RegExp }[] = [
  { label: '@azure/* SDK import', re: /from\s+'@azure\/[^']+'/ },
  { label: 'node: builtin import', re: /from\s+'node:[^']+'/ },
  { label: 'bare fetch call', re: /(?<![.\w])fetch\s*\(/ },
  { label: 'process.env read', re: /process\.env/ },
];

function pureFiles(): string[] {
  return readdirSync(RUN_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !IMPURE_ALLOWED.has(e.name))
    .map((e) => e.name);
}

describe('purity — the pure layer', () => {
  it('has a NON-EMPTY population to examine', () => {
    // A guard over zero files is green and blind. This is the population
    // contract applied to the guard itself (PRP §3.2).
    const files = pureFiles();
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(files).toContain('model.ts');
    expect(files).toContain('verdict.ts');
    expect(files).toContain('lifecycle.ts');
    expect(files).toContain('population.ts');
    expect(files).toContain('scan.ts');
  });

  it.each(pureFiles())('%s imports nothing impure', (name) => {
    const text = readFileSync(join(RUN_DIR, name), 'utf8');
    // Strip block and line comments — the headers in this directory legitimately
    // NAME the forbidden things while explaining why they are forbidden.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const f of FORBIDDEN) {
      expect(f.re.test(code), `${name} contains a ${f.label}`).toBe(false);
    }
  });

  it('the impure edge is exactly the two files + the azure/ directory', () => {
    const dirs = readdirSync(RUN_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const d of dirs) expect(IMPURE_DIRS.has(d)).toBe(true);
  });

  it('EMBEDDED CONTROL: the matcher flags every forbidden form', () => {
    // The env-var name below is deliberately NOT `LOOM_*`. This file is scanned
    // by `scripts/ci/check-env-sync.mjs`, which requires every LOOM_* read under
    // apps/fiab-console to be emitted by the platform bicep — and a synthetic
    // control string inside a test is not a real read. Using a LOOM_ name here
    // failed that guard on a value that does not exist anywhere.
    const synthetic = [
      "import { CosmosClient } from '@azure/cosmos';",
      "import { readFileSync } from 'node:fs';",
      'const r = await fetch(url);',
      'const e = process.env.EXAMPLE_CONTROL_VALUE;',
    ].join('\n');
    for (const f of FORBIDDEN) {
      expect(f.re.test(synthetic), `matcher for ${f.label} did NOT fire on the control`).toBe(true);
    }
  });

  it('EMBEDDED CONTROL: the matcher does NOT flag a clean module', () => {
    const clean = [
      "import type { Finding } from '../types';",
      "import { classifyEstate } from './verdict';",
      'export const x = 1;',
    ].join('\n');
    for (const f of FORBIDDEN) {
      expect(f.re.test(clean), `matcher for ${f.label} FALSE-POSITIVED on a clean module`).toBe(
        false,
      );
    }
  });
});
