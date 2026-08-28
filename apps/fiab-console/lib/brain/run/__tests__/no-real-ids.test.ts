/**
 * LOOM BRAIN W10 — PUBLIC REPO. No real tenant, subscription, object or
 * resource id may appear anywhere in this directory (#3936).
 *
 * A finding written by the scheduled run legitimately carries the ARM ids of the
 * estate it scanned — into that estate's OWN Cosmos account. NOTHING in this
 * repository may. Every fixture is synthetic, every example id is an
 * obviously-fake placeholder, and this scans the whole directory to keep it that
 * way after the author who knew the rule has moved on.
 *
 * ── THE ALLOWLIST IS EXPLICIT AND SHORT ────────────────────────────────────
 * Placeholder GUIDs (all-1s, all-0s and the like) are permitted BY VALUE, not by
 * a pattern that would also admit a real one. A GUID that is not on the list
 * fails, and the message names the file and the value so triage is one look.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RUN_DIR = join(__dirname, '..');

const GUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/**
 * Placeholder GUIDs, permitted by exact value.
 *
 * Kept as literal strings rather than a "looks synthetic" heuristic: a heuristic
 * that admits repeated-digit GUIDs would also admit a real one that happened to
 * start with a run of the same character, and the cost of being wrong here is a
 * tenant id in a public repository.
 */
const ALLOWED = new Set<string>([
  '11111111-1111-1111-1111-111111111111',
  '00000000-0000-0000-0000-000000000000',
  // Azure's BUILT-IN "Cosmos DB Built-in Data Contributor" role DEFINITION id.
  // A fixed, documented, tenant-independent Azure constant — the same kind of
  // value as the all-zeros entry above, and already a literal in both cosmos
  // bicep modules. It is quoted verbatim in `../token-identity.ts`'s wrong-
  // principal remediation so the operator gets a command they can paste
  // (deploy-integrity R6), rather than a role NAME they then have to look up.
  //
  // Added BY VALUE, deliberately. The alternative — assembling the GUID at
  // runtime to dodge the regex — would be keying to this guard's spelling
  // instead of to its point, which is the evasion shape this repo measures.
  '00000000-0000-0000-0000-000000000002',
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mjs|json)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('no real ids', () => {
  const files = sourceFiles(RUN_DIR);

  it('has a NON-EMPTY population to examine', () => {
    // A scanner over zero files is green and blind.
    expect(files.length).toBeGreaterThanOrEqual(12);
  });

  it('contains no GUID-shaped literal that is not an explicit placeholder', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.match(GUID) ?? []) {
        if (!ALLOWED.has(match.toLowerCase())) {
          offenders.push(`${file.slice(RUN_DIR.length + 1)}: ${match}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('contains no ARM subscription path with a non-placeholder id', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.match(/\/subscriptions\/[0-9a-fA-F-]{36}/g) ?? []) {
        const id = m.slice('/subscriptions/'.length).toLowerCase();
        if (!ALLOWED.has(id)) offenders.push(`${file.slice(RUN_DIR.length + 1)}: ${m}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('EMBEDDED CONTROL: the matcher flags a real-looking GUID', () => {
    // Without this, a broken regex would produce the same clean result as a
    // clean directory.
    //
    // The control value is ASSEMBLED AT RUNTIME rather than written as a
    // literal, because this file is itself inside the scanned directory — the
    // first version of this test failed its own scan, which is the guard
    // working and is also an unusable test. The fragments below each fall short
    // of the GUID shape, so nothing in this source matches.
    const control = ['9f3c21ab', '77de', '4b02', '9c1e', '5ad0e6b41f28'].join('-');
    const synthetic = `const sub = "${control}";`;
    const hits = (synthetic.match(GUID) ?? []).filter((g) => !ALLOWED.has(g.toLowerCase()));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBe(control);
  });

  it('EMBEDDED CONTROL: the matcher does NOT flag the placeholder', () => {
    const placeholder = ['11111111', '1111', '1111', '1111', '111111111111'].join('-');
    const synthetic = `const sub = "${placeholder}";`;
    const hits = (synthetic.match(GUID) ?? []).filter((g) => !ALLOWED.has(g.toLowerCase()));
    expect(hits).toHaveLength(0);
  });

  it('EMBEDDED CONTROL: the ARM-path matcher fires on a non-placeholder subscription', () => {
    const control = ['9f3c21ab', '77de', '4b02', '9c1e', '5ad0e6b41f28'].join('-');
    const synthetic = `/subscriptions/${control}/resourceGroups/rg`;
    const hits = (synthetic.match(/\/subscriptions\/[0-9a-fA-F-]{36}/g) ?? []).filter(
      (m) => !ALLOWED.has(m.slice('/subscriptions/'.length).toLowerCase()),
    );
    expect(hits).toHaveLength(1);
  });
});
