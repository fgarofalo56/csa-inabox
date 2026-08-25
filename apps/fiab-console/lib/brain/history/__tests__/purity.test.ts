/**
 * THE PURITY GUARD for `lib/brain/history`.
 *
 * The value of this layer being pure is not tidiness. It is that every property
 * the feature claims — content-addressed dedupe, the diff classification, the
 * retention bound, the fail-closed integrity check — is proven with no Azure
 * tenant and no emulator, because the code that implements them cannot reach
 * Azure. Lose the purity and the proofs become integration tests that nobody
 * runs.
 *
 * It also keeps the layer importable from a client bundle: W8 (#3934) renders
 * "new edges", and a `node:crypto` or `@azure/*` import anywhere in the barrel
 * would break that surface at build time rather than here.
 *
 * TWO THINGS THIS GUARD DOES THAT MOST GUARDS DO NOT, because this repo has
 * repeatedly shipped guards that watch nothing:
 *
 *   1. IT ASSERTS ITS OWN POPULATION. A guard that globbed zero files would pass
 *      silently forever. The file count is asserted non-zero AND every module is
 *      asserted by name, so deleting one does not quietly shrink the watched set
 *      and adding one does not slip past unwatched.
 *
 *   2. IT CARRIES AN EMBEDDED CONTROL. Every forbidden-pattern matcher is run
 *      against a synthetic string that DOES violate it. Without that, a broken
 *      regex over a clean directory and a working regex over a clean directory
 *      produce identical output — zero hits — and the guard passes forever while
 *      watching nothing.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HISTORY_DIR = join(__dirname, '..');

/**
 * The ONE module allowed an Azure import.
 *
 * It is also deliberately NOT re-exported from `index.ts`, so importing the pure
 * layer cannot drag the SDK in transitively.
 */
const IMPURE_ALLOWED = 'cosmos-store.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const FORBIDDEN: readonly { name: string; re: RegExp; control: string }[] = [
  {
    name: 'Azure SDK import',
    re: /from\s+['"]@azure\//,
    control: "import { CosmosClient } from '@azure/cosmos';",
  },
  {
    name: 'network call',
    re: /\bfetch\s*\(|\baxios\b|from\s+['"]node:https?['"]/,
    control: 'const r = await fetch(url);',
  },
  {
    name: 'filesystem access',
    re: /from\s+['"]node:fs['"]|require\(['"]fs['"]\)/,
    control: "import { readFileSync } from 'node:fs';",
  },
  {
    name: 'process spawn',
    re: /from\s+['"]node:child_process['"]|\bspawnSync\s*\(|\bexecSync\s*\(/,
    control: "import { spawnSync } from 'node:child_process';",
  },
  {
    name: 'node:crypto import',
    // Not I/O, but it is what makes a module unimportable from an edge runtime
    // or a client bundle. `./sha256.ts` exists precisely so nothing here needs
    // it; if that file is ever "simplified" back to createHash, this fires.
    re: /from\s+['"]node:crypto['"]|require\(['"]crypto['"]\)/,
    control: "import { createHash } from 'node:crypto';",
  },
];

describe('lib/brain/history is pure', () => {
  const files = sourceFiles(HISTORY_DIR);

  it('watches a non-empty, NAMED set of modules', () => {
    expect(files.length).toBeGreaterThan(0);
    const names = files.map((f) => f.slice(HISTORY_DIR.length + 1).replace(/\\/g, '/')).sort();
    // Named explicitly. A new module added to this directory fails here until
    // it is listed, which is the point: the watched set cannot drift.
    expect(names).toEqual([
      'capture.ts',
      'cosmos-store.ts',
      'diff.ts',
      'digest.ts',
      'index.ts',
      'model.ts',
      'project.ts',
      'queries.ts',
      'retention.ts',
      'sha256.ts',
      'store.ts',
    ]);
  });

  it('every forbidden matcher actually matches its own violation (the control)', () => {
    for (const rule of FORBIDDEN) {
      expect(rule.re.test(rule.control), `matcher '${rule.name}' does not match its control`).toBe(
        true,
      );
    }
  });

  it('no pure module imports an Azure SDK, the network, the filesystem, a process or node:crypto', () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = file.slice(HISTORY_DIR.length + 1).replace(/\\/g, '/');
      if (rel === IMPURE_ALLOWED) continue;
      const text = readFileSync(file, 'utf8');
      for (const rule of FORBIDDEN) {
        if (rule.re.test(text)) violations.push(`${rel}: ${rule.name}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('the ONE impure module is impure for exactly one reason', () => {
    const text = readFileSync(join(HISTORY_DIR, IMPURE_ALLOWED), 'utf8');
    // It must import the Azure SDK — otherwise the exemption is dead and the
    // guard above is weaker than it looks for no benefit.
    expect(/from\s+['"]@azure\//.test(text)).toBe(true);
    // And it must not have picked up the others.
    for (const rule of FORBIDDEN) {
      if (rule.name === 'Azure SDK import') continue;
      expect(rule.re.test(text), `${IMPURE_ALLOWED} gained: ${rule.name}`).toBe(false);
    }
  });

  it('the public barrel does NOT re-export the Azure-touching module', () => {
    // A single `export * from './cosmos-store'` would pull @azure/cosmos into
    // every consumer of the pure layer, including a client component.
    const barrel = readFileSync(join(HISTORY_DIR, 'index.ts'), 'utf8');
    expect(barrel).not.toMatch(/from\s+['"]\.\/cosmos-store['"]/);
  });

  it('nothing here can mutate Azure — there is no ARM verb in the pure layer', () => {
    const mutating = /\b(beginCreateOrUpdate|beginDelete|createOrUpdate\s*\(|\.delete\s*\(\s*\)|PUT|PATCH)\b/;
    // Control first: the matcher must fire on a real mutation call.
    expect(mutating.test('await client.containerApps.beginCreateOrUpdate(rg, name, body);')).toBe(
      true,
    );
    const violations: string[] = [];
    for (const file of files) {
      const rel = file.slice(HISTORY_DIR.length + 1).replace(/\\/g, '/');
      if (rel === IMPURE_ALLOWED) continue;
      if (mutating.test(readFileSync(file, 'utf8'))) violations.push(rel);
    }
    expect(violations).toEqual([]);
  });
});
