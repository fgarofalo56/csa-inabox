/**
 * NO REAL IDENTIFIER MAY LAND IN THIS REPOSITORY.
 *
 * #3935's storage constraint, verbatim: *"No real tenant / subscription / object
 * / resource ids in stored graphs — this is a public repo and anything persisted
 * may end up in a fixture."*
 *
 * A stored version legitimately carries the estate's own ARM ids: it lives in
 * that estate's Cosmos account, which is the customer's own store. The leak path
 * is the OTHER direction — someone exports a version to build a fixture, or
 * pastes one into a test, and a subscription GUID lands in a public repository
 * forever.
 *
 * So the rule enforced here is a rule about THIS DIRECTORY, and it is absolute
 * rather than heuristic: no 8-4-4-4-12 hex string, anywhere, with NO allowlist.
 *
 * ── WHY NO ALLOWLIST, GIVEN OTHER FIXTURES USE `11111111-…` ────────────────
 * An allowlist of "obviously synthetic" GUIDs is a judgement call made at review
 * time, and it turns a mechanical check into one that needs a human to be right
 * every time. An absolute rule needs a human to be right once — when writing a
 * placeholder. That is why the fixtures here use `sub-alpha` rather than a
 * synthetic GUID: it costs nothing and it makes the guard unarguable.
 *
 * The guard carries an EMBEDDED CONTROL: the pattern is run against a synthetic
 * GUID-shaped string and must match. A regex that had stopped matching would
 * otherwise produce the same clean output as a clean tree.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HISTORY_DIR = join(__dirname, '..');

/** 8-4-4-4-12 hex, case-insensitive, on a word boundary. */
const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** Long unbroken hex runs — a raw token, key or object id smuggled in as one word. */
const LONG_HEX = /\b[0-9a-f]{40,}\b/i;

function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...allFiles(full));
    else if (/\.(ts|tsx|json|md)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('no real identifiers in lib/brain/history', () => {
  // Includes __tests__ deliberately: the fixtures are the likeliest leak, and
  // excluding them would leave the guard watching the safest files only.
  const files = allFiles(HISTORY_DIR);

  it('watches a non-empty set that includes the fixtures', () => {
    expect(files.length).toBeGreaterThan(5);
    const rels = files.map((f) => f.slice(HISTORY_DIR.length + 1).replace(/\\/g, '/'));
    expect(rels).toContain('__tests__/fixtures.ts');
    expect(rels).toContain('model.ts');
  });

  it('the matchers match their own controls', () => {
    // Synthetic, constructed rather than written out, so this control cannot
    // itself be mistaken for a leaked value by a future reader or a scanner.
    const syntheticGuid = ['abcdef01', '2345', '6789', 'abcd', 'ef0123456789'].join('-');
    expect(GUID.test(syntheticGuid)).toBe(true);
    expect(GUID.test('sub-alpha')).toBe(false);
    expect(LONG_HEX.test('a'.repeat(64))).toBe(true);
    expect(LONG_HEX.test('deadbeef')).toBe(false);
  });

  it('contains no GUID-shaped literal anywhere', () => {
    const hits: string[] = [];
    for (const file of files) {
      const rel = file.slice(HISTORY_DIR.length + 1).replace(/\\/g, '/');
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (GUID.test(line)) hits.push(`${rel}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('contains no long unbroken hex run outside the sha256 vectors', () => {
    // The published NIST digests in `sha256.test.ts` are 64 hex chars by
    // definition and are public constants, not identifiers. Everything else is
    // in scope.
    const hits: string[] = [];
    for (const file of files) {
      const rel = file.slice(HISTORY_DIR.length + 1).replace(/\\/g, '/');
      if (rel === '__tests__/sha256.test.ts') continue;
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (LONG_HEX.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 60)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('the projection stores a value FINGERPRINT, never the value', () => {
    // The structural half of the same concern: an env var value can be a
    // connection string, so `VersionEdgeEvidence` must not carry one. If a
    // `rawValue` field is ever added back, this fires.
    const model = readFileSync(join(HISTORY_DIR, 'model.ts'), 'utf8');
    expect(model).toContain('rawValueDigest');
    expect(model).not.toMatch(/readonly\s+rawValue\s*:/);
    const project = readFileSync(join(HISTORY_DIR, 'project.ts'), 'utf8');
    expect(project).toContain('shortDigest');
  });
});
