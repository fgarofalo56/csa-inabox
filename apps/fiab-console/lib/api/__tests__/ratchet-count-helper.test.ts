/**
 * R3 — shared ratchet mechanic (`scripts/ci/_ratchet-count.mjs`) unit tests.
 *
 * The helper is consumed by check-route-toolkit.mjs today and by the X1 / I5 /
 * R17 / R19 / U11 / LIC0 guards later — these tests pin the reusable contract:
 * baseline round-trip with the F6 ownership header, per-key rise detection,
 * the touched-file (boy-scout) rule + exemptions + graceful skip, and the
 * `--update-baseline` regen (incl. the shrink-only grow warning).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore — plain .mjs helper module (no type declarations)
import { loadBaseline, writeBaseline, runRatchet } from '../../../../../scripts/ci/_ratchet-count.mjs';

const META = { owner: 'test-owner', why: 'because tests', unblock: 'run --update-baseline' };

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-test-'));
  file = path.join(dir, 'baseline.json');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('_ratchet-count baseline file', () => {
  it('round-trips entries sorted, with the ownership header (F6)', () => {
    writeBaseline(file, META, { 'b/route.ts': 2, 'a/route.ts': 1 });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Object.keys(raw.entries)).toEqual(['a/route.ts', 'b/route.ts']);
    expect(raw._owner).toBe('test-owner');
    expect(raw._why).toBe('because tests');
    expect(raw._unblock).toBe('run --update-baseline');
    const { meta, entries } = loadBaseline(file);
    expect(meta).toEqual(META);
    expect(entries).toEqual({ 'a/route.ts': 1, 'b/route.ts': 2 });
  });

  it('missing baseline file loads as empty (bootstrap)', () => {
    expect(loadBaseline(path.join(dir, 'nope.json'))).toEqual({ meta: null, entries: {} });
  });
});

describe('runRatchet check mode', () => {
  it('passes at the frozen baseline and when keys clear', () => {
    writeBaseline(file, META, { 'a.ts': 1, 'b.ts': 1 });
    expect(
      runRatchet({ name: 't', baselineFile: file, meta: META, current: { 'a.ts': 1, 'b.ts': 1 }, argv: [] }),
    ).toBe(0);
    // b.ts cleared — shrink passes without a regen
    expect(runRatchet({ name: 't', baselineFile: file, meta: META, current: { 'a.ts': 1 }, argv: [] })).toBe(0);
  });

  it('fails on a per-key rise and on a net-new key', () => {
    writeBaseline(file, META, { 'a.ts': 1 });
    expect(runRatchet({ name: 't', baselineFile: file, meta: META, current: { 'a.ts': 2 }, argv: [] })).toBe(1);
    expect(
      runRatchet({ name: 't', baselineFile: file, meta: META, current: { 'a.ts': 1, 'new.ts': 1 }, argv: [] }),
    ).toBe(1);
  });

  it('touched-file rule: fails a modified-but-not-cleared baseline key, honors exemptions, skips on null diff', () => {
    writeBaseline(file, META, { 'a.ts': 1, 'b.ts': 1 });
    const base = { name: 't', baselineFile: file, meta: META, current: { 'a.ts': 1, 'b.ts': 1 }, argv: [] };
    // a.ts modified but still hand-rolled → boy-scout FAIL
    expect(
      runRatchet({ ...base, touched: { files: new Set(['a.ts']), exempt: new Map(), message: () => 'fix it' } }),
    ).toBe(1);
    // exempted → pass
    expect(
      runRatchet({
        ...base,
        touched: { files: new Set(['a.ts']), exempt: new Map([['a.ts', 'reason']]), message: () => '' },
      }),
    ).toBe(0);
    // cleared in the same PR → pass
    expect(
      runRatchet({
        ...base,
        current: { 'b.ts': 1 },
        touched: { files: new Set(['a.ts']), exempt: new Map(), message: () => '' },
      }),
    ).toBe(0);
    // diff unavailable → touched rule skipped, not a spurious failure
    expect(runRatchet({ ...base, touched: { files: null, exempt: new Map(), message: () => '' } })).toBe(0);
  });

  it('--update-baseline regenerates (and warns on a grow)', () => {
    writeBaseline(file, META, { 'a.ts': 1 });
    const code = runRatchet({
      name: 't',
      baselineFile: file,
      meta: META,
      current: { 'a.ts': 1, 'b.ts': 1 },
      argv: ['--update-baseline'],
    });
    expect(code).toBe(0);
    expect(loadBaseline(file).entries).toEqual({ 'a.ts': 1, 'b.ts': 1 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('baseline GREW'));
  });
});
