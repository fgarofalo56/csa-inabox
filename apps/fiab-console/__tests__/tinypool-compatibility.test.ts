/**
 * Advisory floor for tinypool (CVE-2026-104848 / CVE-2026-104849, first patched
 * 2.1.2), re-aimed when vitest moved 3 -> 4 (#5357).
 *
 * History: vitest 3.2.7 pulled tinypool ^1.1.1, so a `vitest>tinypool: 2.1.2`
 * override forced the patched major and this file exercised its worker modes.
 * vitest 4 no longer depends on tinypool at all (measured: no `tinypool@` entry
 * in pnpm-lock.yaml), so the override was inert and was removed from BOTH
 * package.json and pnpm-workspace.yaml, and the worker-mode probes with it.
 *
 * What this still guards: if ANY package ever brings tinypool back into the
 * tree, it must be >= 2.1.2. Absent is a pass; vulnerable is a failure.
 * The positive control proves the lockfile parser reads this lockfile (a
 * parser pointed at nothing would also report "no tinypool").
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');

const cmp = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

describe('tinypool advisory floor (>= 2.1.2 if present at all)', () => {
  it('CONTROL: the lockfile parser sees vitest 4.1.11 (so "no tinypool" is a real absence)', () => {
    const versions = [...lock.matchAll(/^ {2}vitest@(\d+\.\d+\.\d+)[(:]/gm)].map((m) => m[1]);
    expect(versions.length).toBeGreaterThan(0);
    expect(versions).toContain('4.1.11');
  });

  it('no locked tinypool is below 2.1.2; the stale vitest>tinypool override is gone', () => {
    const versions = [...lock.matchAll(/^ {2}tinypool@(\d+\.\d+\.\d+)[(:]/gm)].map((m) => m[1]);
    const vulnerable = versions.filter((v) => cmp(v, '2.1.2') < 0);
    expect(vulnerable, `tinypool below 2.1.2 is locked: ${vulnerable.join(', ')}`).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(manifest.pnpm.overrides['vitest>tinypool']).toBeUndefined();
  });
});
