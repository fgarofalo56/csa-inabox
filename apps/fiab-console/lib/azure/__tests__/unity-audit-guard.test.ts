/**
 * ATTACK tests for the LU-3 audit choke-point guard.
 *
 * These are not happy-path tests. Each one reproduces a BYPASS — including the
 * two an adversarial reviewer DEMONSTRATED against the first version of the
 * guard (both exited 0) — and asserts the guard now fails on it. A guard that
 * appears to cover a path it does not is worse than no guard, so the guard
 * itself needs negative coverage.
 *
 * The analysis is a pure function over `{ relPath -> source }`, so the attacks
 * mutate an in-memory copy of the real tree: the same bytes CI reads, minus the
 * one edit an attacker would make.
 */
import { describe, it, expect } from 'vitest';
import {
  analyzeUnityChokepoint,
  callsSymbolInFinallyOf,
  maskCommentsAndStrings,
  maskComments,
  isClientComponent,
  readSources,
  countOutbound,
  hasTransport,
  referencesCatalogAddress,
  TRANSPORTS,
  CHOKEPOINT,
  DBX_CHOKEPOINT,
  RECORDER,
  SQL_EXIT_BASELINE,
  SQL_EXIT_BASELINES,
  SQL_CHOKEPOINT,
  ACCOUNT_CHOKEPOINT,
  SECURABLE_CHOKEPOINT,
  SECURABLE_RAW,
  SECURABLE_RAW_PUBLIC,
  securableRawImports,
  AUDITED_TRANSPORTS,
  OUTBOUND_BASELINE,
  CHOKEPOINT_FILES,
  KNOWN_UNAUDITED,
  MASK_BUDGET_BYTES,
  maskedBytes,
  resetMaskedBytes,
} from '../../../../../scripts/ci/check-unity-audit-chokepoint.mjs';

/**
 * The WHOLE tree the CLI reads — lib/ + app/ + scripts/ — not a hand-listed
 * handful.
 *
 * Round 2's version loaded 8 files by name, so `it('passes on the shipped
 * sources')` could not fail on a bypass anywhere else in the tree while
 * reading as though it could. Using the guard's own reader means every attack
 * below is mutated against the same bytes CI sees, and the pass assertion is
 * the real one.
 *
 * ## The budget this file has to respect (#2944, #2959, #2622-residual)
 *
 * Every attack below runs `analyzeUnityChokepoint` over ~5,470 real files, and
 * it does so as STRAIGHT-LINE SYNCHRONOUS CPU. That is the one shape vitest
 * cannot survive in quantity: a worker reports results with a birpc call whose
 * reply arrives as an IPC message, readable only when the event loop reaches its
 * poll phase — and a promise-chained run of synchronous tests never gets there.
 * Past 60 s of CUMULATIVE synchronous CPU in one file, birpc's hardcoded
 * deadline rejects and the WHOLE RUN fails with
 * `[vitest-worker]: Timeout calling "onTaskUpdate"` while all 45 tests PASS.
 *
 * Measured, single worker, idle main thread: 50 s of sync CPU is clean, 100 s
 * fails; 100 s of ASYNC waiting is clean. So the budget is this file's own
 * synchronous CPU, and neither sharding nor the fork cap can buy any of it back.
 *
 * That is not hypothetical here — this file WAS the whole problem: 31 whole-tree
 * scans, 108,699 ms on CI, the only file over 60 s out of 1,354 and 4.6x the next
 * slowest, which is what turned `loom-roll-and-validate` red at 537e1411 (#2949).
 * #2944/#2959 fixed it in the GUARD, by short-circuiting its two whole-tree loops
 * before they mask.
 *
 * ## WHAT THE NUMBERS ACTUALLY ARE NOW — measured 2026-08-08, bare node
 *
 *     readSources()                 597-748 ms   (once, cached below)
 *     one whole-tree scan           176-184 ms   <- NOT the ~2-3 s the older
 *                                                   comments in this file said
 *     31 scans + 34 copies + read       6.1 s    upper bound for this whole file
 *     headroom to the 60 s cliff       53.9 s    ~338 more scans would fit
 *
 * The prose that used to live here priced a scan at 1.2-3 s and told the next
 * author that "adding scans is what put this file over the cliff twice already".
 * After #2959 that is off by a factor of ~14, and it was load-bearing prose: the
 * ROUND 6 block below deliberately traded REAL-TREE coverage for a synthetic map
 * to dodge a cost that no longer exists. Both are corrected in this pass.
 *
 * ## The control that replaced the warning (#2622 residual)
 *
 * A comment saying "please do not add scans" is a CONVENTION, and this whole file
 * is built on the premise that a convention is not a choke point. The cost model
 * is now a RATCHET: `MASK_BUDGET_BYTES` caps the bytes one whole-tree scan may
 * hand to `maskSource`, asserted by 'stays inside the masking budget' below.
 * Bytes, not milliseconds — deterministic, and identical on a laptop and on a
 * shared CI runner.
 */
let CACHED: Map<string, string> | null = null;
function realSources(): Map<string, string> {
  // Read the tree ONCE (~2.5s); every attack gets its own mutable copy.
  CACHED ??= readSources() as Map<string, string>;
  return new Map(CACHED);
}

describe('unity-audit-chokepoint guard — the real tree', () => {
  it('passes on the shipped sources (lib/ + app/ + scripts/, every file)', () => {
    const s = realSources();
    // Guard against the assertion silently degrading to a handful of files again.
    expect(s.size).toBeGreaterThan(500);
    expect(s.has(CHOKEPOINT)).toBe(true);
    expect(analyzeUnityChokepoint(s)).toEqual([]);
  });

  it('pins an outbound ceiling on EVERY file it exempts from the no-bypass scan', () => {
    for (const r of [...CHOKEPOINT_FILES.keys(), ...KNOWN_UNAUDITED.keys()]) {
      expect(OUTBOUND_BASELINE.has(r), `${r} has no OUTBOUND_BASELINE entry`).toBe(true);
    }
  });

  /**
   * THE COST RATCHET (#2622 residual). Twice, a whole-tree loop asked an
   * expensive question before a cheap one, masked the entire tree, and pushed
   * this spec past vitest's 60 s birpc deadline — failing the run, and the roll,
   * with every test still passing (#2949 pinned the Commercial console that way).
   *
   * Both times the only defence afterwards was a comment telling the next author
   * not to add scans. This is that warning made mechanical.
   *
   * Measured with the pre-#2959 order restored in a scratch copy of the guard:
   * 99.12 MB masked and 2,259 ms per scan, versus 3.74 MB / 184 ms shipped — and
   * `analyzeUnityChokepoint` returned the IDENTICAL empty failure list in both.
   * That equality is the reason this assertion has to exist separately: a 26x
   * cost regression cannot be seen by any correctness check in this file.
   *
   * Counted in BYTES, not milliseconds, so it is deterministic and a slow shared
   * CI runner can never make it flaky.
   */
  it('stays inside the masking budget — one whole-tree scan (the 60s birpc cliff)', () => {
    const s = realSources();
    resetMaskedBytes();
    expect(analyzeUnityChokepoint(s)).toEqual([]);
    const used = maskedBytes();

    // Non-vacuity: a scan that masked NOTHING would pass a ceiling trivially,
    // and would mean the meter (or the scan) had stopped working.
    expect(used, 'the scan masked nothing — the meter is not wired').toBeGreaterThan(100_000);
    expect(
      used,
      `one whole-tree scan masked ${(used / 1e6).toFixed(2)} MB, over the ${(MASK_BUDGET_BYTES / 1e6).toFixed(1)} MB `
        + 'ratchet. Something now masks a file before deciding it is irrelevant — the exact defect that took this '
        + 'spec to 108.7s and turned loom-roll-and-validate red (#2949). Find the whole-tree loop you just made '
        + 'unconditional; do NOT raise this ceiling to go green.',
    ).toBeLessThanOrEqual(MASK_BUDGET_BYTES);
  });
});

describe('ATTACK: gut the finally, leave a decoy call (reviewer bypass #1)', () => {
  it('fails even though recordUnityAccess( still appears in the file', () => {
    const s = realSources();
    const src = s.get(CHOKEPOINT)!;
    // Exactly the demonstrated mutation: neuter the finally body (dropping every
    // success, failure AND denial) and plant one call in an unrelated helper far
    // below. The old substring check — indexOf('} finally {') then
    // slice(idx).includes('recordUnityAccess(') — was satisfied by the decoy.
    const gutted = src.replace(
      /\} finally \{[\s\S]*?\n  \}/,
      '} finally {\n    /* audit disabled */\n  }',
    );
    expect(gutted).not.toBe(src); // the mutation must have applied
    const withDecoy = `${gutted}\nfunction __decoy() { void recordUnityAccess({} as never); }\n`;
    s.set(CHOKEPOINT, withDecoy);

    expect(withDecoy).toContain('recordUnityAccess('); // the decoy is present…
    const failures = analyzeUnityChokepoint(s);
    // …and the guard still rejects it.
    expect(failures.join('\n')).toMatch(/not called from inside a `finally` block of ucFetch/);
  });

  it('is not satisfied by a mention of the recorder inside a comment', () => {
    const src = [
      'async function ucFetch(host: string, path: string) {',
      '  try { return await fetchWithTimeout(host + path); }',
      '  finally {',
      '    // recordUnityAccess({ ... }) used to live here',
      '  }',
      '}',
    ].join('\n');
    expect(callsSymbolInFinallyOf(src, 'ucFetch', 'recordUnityAccess')).toBe(false);
  });

  it('is not fooled by an inline object type in the parameter list', () => {
    // ucFetch's real signature is `ucFetch<T = any>(host, path, init?: { method?: ... })`.
    // Taking the first `{` after the name as the body start lands inside the
    // parameter type and makes the whole body invisible to the check.
    const src = [
      'async function ucFetch<T = any>(host: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {',
      '  try { return await fetchWithTimeout(host + path) as T; }',
      '  finally { void recordUnityAccess({ path } as never); }',
      '}',
    ].join('\n');
    expect(callsSymbolInFinallyOf(src, 'ucFetch', 'recordUnityAccess')).toBe(true);
  });
});

describe('ATTACK: unaudited privilege grant on the Databricks path (reviewer bypass #2)', () => {
  it('fails when a NEW file PATCHes unity-catalog permissions directly', () => {
    const s = realSources();
    // The demonstrated payload: a grant of ALL_PRIVILEGES issued outside any
    // audited transport. The first guard only matched LOOM_UNITY_URL/ossUcBase(,
    // so this Databricks-side call — the backend ~every Commercial estate runs —
    // exited 0.
    s.set('lib/azure/rogue-grants.ts', [
      'export async function grantEverything(host: string, token: string) {',
      '  return fetch(`https://${host}/api/2.1/unity-catalog/permissions/table/sales.bronze.orders`, {',
      "    method: 'PATCH',",
      "    headers: { authorization: `Bearer ${token}` },",
      "    body: JSON.stringify({ changes: [{ principal: 'attacker@contoso.com', add: ['ALL_PRIVILEGES'] }] }),",
      '  });',
      '}',
    ].join('\n'));

    const failures = analyzeUnityChokepoint(s);
    expect(failures.join('\n')).toMatch(/rogue-grants\.ts: references a Unity Catalog address or REST path/);
  });

  it('fails when the raw fetch is appended to databricks-client.ts itself', () => {
    // databricks-client.ts IS allowlisted from the no-bypass scan (it holds
    // dbxFetch), so the outbound-call ratchet is what has to catch this.
    const s = realSources();
    s.set(DBX_CHOKEPOINT, `${s.get(DBX_CHOKEPOINT)!}\nexport async function rogue(host: string) {\n  return fetch(\`https://\${host}/api/2.1/unity-catalog/permissions/table/x.y.z\`, { method: 'PATCH' });\n}\n`);
    const failures = analyzeUnityChokepoint(s);
    expect(failures.join('\n')).toMatch(/databricks-client\.ts: \d+ outbound calls \(ratchet: 3\)/);
  });

  it('fails when dbxFetch stops recording', () => {
    const s = realSources();
    s.set(DBX_CHOKEPOINT, s.get(DBX_CHOKEPOINT)!.replace(/recordDatabricksUnityAccess\(\{ path,/, 'noop({ path,'));
    const failures = analyzeUnityChokepoint(s);
    expect(failures.join('\n')).toMatch(/not called from inside a `finally` block of dbxFetch/);
  });
});

describe('ATTACK: round-3 reviewer bypasses (all three exited 0 against round 2)', () => {
  it('#4 — fails on a .tsx SERVER component that PATCHes UC permissions', () => {
    const s = realSources();
    // Round 2 exempted every `.tsx` from the UC-REST-path arm on the theory that
    // "a .tsx component holds no credential". In the App Router a .tsx WITHOUT
    // 'use client' is a SERVER component with full Node-runtime credential
    // access. This is the reviewer's payload verbatim.
    s.set('app/admin/rogue/page.tsx', [
      'export default async function Page() {',
      "  await fetch('https://dbx.example.net/api/2.1/unity-catalog/permissions/table/a.b.c', { method: 'PATCH' });",
      '  return null;',
      '}',
    ].join('\n'));
    expect(analyzeUnityChokepoint(s).join('\n')).toMatch(/app\/admin\/rogue\/page\.tsx: references a Unity Catalog/);
  });

  it("#4 — but does NOT fire on a real 'use client' component that PRINTS the path", () => {
    // The exemption still has to exist: uc-dialogs.tsx documents which REST call
    // each action makes. Narrowing it from "extension" to "directive" must not
    // turn that into a false positive.
    const s = realSources();
    s.set('lib/editors/uc-help.tsx', [
      "'use client';",
      "import { useState } from 'react';",
      'export function Help() {',
      '  const [x] = useState(0);',
      "  void fetch('/api/databricks/unity-catalog/permissions');",
      "  return <code>PATCH /api/2.1/unity-catalog/permissions/table/{'{full_name}'}</code>;",
      '}',
    ].join('\n'));
    expect(analyzeUnityChokepoint(s)).toEqual([]);
    expect(isClientComponent("'use client';\nexport const a = 1;")).toBe(true);
    expect(isClientComponent("/** doc says 'use client' */\nexport const a = 1;")).toBe(false);
    expect(isClientComponent('export default async function Page() {}')).toBe(false);
  });

  it('#5 — fails when a DECLARED-GAP file grows a new un-audited catalog call', () => {
    const s = realSources();
    const gap = 'lib/azure/shortcut-credentials.ts';
    expect(KNOWN_UNAUDITED.has(gap)).toBe(true);
    // Round 2's check 4 did `if (KNOWN_UNAUDITED.has(r)) continue;` with no
    // per-file ceiling, so a declared file could grow ARBITRARY new privilege
    // mutations silently. The reviewer appended exactly this.
    s.set(gap, `${s.get(gap)!}\nexport async function rogue(h: string) {\n  return fetch(\`https://\${h}/api/2.1/unity-catalog/permissions/table/a.b.c\`, { method: 'PATCH' });\n}\n`);
    expect(analyzeUnityChokepoint(s).join('\n'))
      .toMatch(/shortcut-credentials\.ts: \d+ outbound calls \(ratchet: \d+\)/);
  });

  it('#5 — fails when an ALLOWLISTED file grows a second, un-recorded exit', () => {
    // MUST_AUDIT only requires the recorder symbol to appear ONCE anywhere in
    // the file, so iceberg-catalog-client.ts — allowlisted for
    // listNamespaceGrants — had its other outbound calls shielded too.
    const s = realSources();
    const f = 'lib/azure/iceberg-catalog-client.ts';
    s.set(f, `${s.get(f)!}\nexport async function rogue(h: string) {\n  return fetch(\`https://\${h}/api/2.1/unity-catalog/catalogs/sales\`, { method: 'DELETE' });\n}\n`);
    // The ceiling is READ from OUTBOUND_BASELINE rather than written here as a
    // literal. RC-12 moved this file's pin 2 -> 3 (a legitimately audited third
    // exit) and the hardcoded `(ratchet: 2)` turned this ATTACK test red — a
    // guard self-test that breaks when the guard is legitimately re-tuned trains
    // people to edit the test instead of reading it. The property under test is
    // "the mutation is CAUGHT", not "the ceiling is 2".
    const ratchet = OUTBOUND_BASELINE.get(f);
    expect(typeof ratchet).toBe('number');
    expect(analyzeUnityChokepoint(s).join('\n'))
      .toMatch(new RegExp(`iceberg-catalog-client\\.ts: \\d+ outbound calls \\(ratchet: ${ratchet}\\)`));
  });

  it('#5 — the ratchet is NON-VACUOUS: the unmutated tree passes at the same pin', () => {
    // The companion the assertion above needs. A pin set too high would let the
    // mutation through AND leave the attack test green if it only ever asserted
    // on a message shape, so prove the clean tree sits exactly at the ceiling.
    const failures = analyzeUnityChokepoint(realSources()).join('\n');
    expect(failures).not.toMatch(/iceberg-catalog-client\.ts: \d+ outbound calls/);
  });

  it('#5 — fails when a file is exempted WITHOUT pinning its outbound count', () => {
    const s = realSources();
    // Simulate a future allowlist entry added with a justification but no
    // ceiling: the exemption itself must not be grantable that way.
    const failures = analyzeUnityChokepoint(s, {
      outboundBaseline: new Map([[DBX_CHOKEPOINT, undefined]]),
    });
    expect(failures.join('\n')).toMatch(/databricks-client\.ts: exempted from the no-bypass scan but has no OUTBOUND_BASELINE entry/);
  });

  it('#6 — fails on an undici transport reaching UC', () => {
    const s = realSources();
    // REQUEST_RE matched only fetch/axios/http.request, so this exited 0.
    s.set('lib/azure/rogue3.ts', [
      "import { request } from 'undici';",
      'export async function grant(h: string) {',
      "  return request(`https://${h}/api/2.1/unity-catalog/permissions/table/a.b.c`, { method: 'PATCH' });",
      '}',
    ].join('\n'));
    expect(analyzeUnityChokepoint(s).join('\n')).toMatch(/rogue3\.ts: references a Unity Catalog/);
  });

  it('#6 — fails on a UC path assembled by concatenation', () => {
    const s = realSources();
    // `'/api/2.1/' + 'unity-catalog/permissions/...'` defeated the single-arm
    // UNITY_REST_PATH_RE. The second arm matches `unity-catalog/<uc-family>`.
    s.set('lib/azure/rogue4.ts', [
      'export async function grant(h: string) {',
      "  const p = '/api/2.1/' + 'unity-catalog/permissions/table/a.b.c';",
      "  return fetch(`https://${h}${p}`, { method: 'PATCH' });",
      '}',
    ].join('\n'));
    expect(analyzeUnityChokepoint(s).join('\n')).toMatch(/rogue4\.ts: references a Unity Catalog/);
  });

  it('#6 — does NOT fire on a Microsoft Learn documentation URL', () => {
    // The second arm requires a real UC REST family after `unity-catalog/`, so
    // `.../unity-catalog/manage-privileges/` in a docs link (lib/admin/self-audit.ts
    // carries one) is not mistaken for an API path.
    const s = realSources();
    s.set('lib/admin/rogue-docs.ts', [
      "export const DOCS = 'https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/manage-privileges/';",
      "export async function ping() { return fetch('https://example.test/health'); }",
    ].join('\n'));
    expect(analyzeUnityChokepoint(s)).toEqual([]);
  });
});

describe('ATTACK: quieter regressions', () => {
  // Round 4, #8: the LU-3 audit try/finally pushed unity-catalog-client.ts over
  // its check-file-size ceiling, so the 165-line system-table block moved to
  // uc-system-tables.ts — carrying one executeStatement( out of a ratchet that
  // was scoped to ONE file. A refactor must not be able to narrow a ratchet.
  //
  // Round 5 (#2622) widened this to EVERY pinned UC-governance file in one scan
  // — including `app/api/items/[type]/[id]/security/route.ts`, the ABAC
  // column-mask + row-filter wizard, which had TEN raw exits and no pin at all.
  it('#19 — ratchets SQL exits in EVERY pinned governance file, not just the choke point', () => {
    const s = realSources();
    const governance = [
      'lib/azure/uc-system-tables.ts',
      'lib/azure/unity-catalog-client.ts',
      'app/api/items/[type]/[id]/security/route.ts',
    ];
    for (const moved of governance) {
      expect(SQL_EXIT_BASELINES.has(moved), `${moved} is not pinned`).toBe(true);
      expect(s.has(moved), `${moved} is not in the scanned tree`).toBe(true);
      s.set(moved, `${s.get(moved)!}\nexport async function sneak(w: string) { return executeStatement(w, 'DROP TABLE x'); }\n`);
    }
    const found = analyzeUnityChokepoint(s).join('\n');
    for (const moved of governance) {
      expect(found, `${moved} grew a raw SQL exit without failing`)
        .toMatch(new RegExp(`${moved.replace(/[.[\]/]/g, '\\$&')}: \\d+ raw executeStatement\\( exits \\(ratchet: 0\\)`));
    }
  });

  it('#19 — fails when a pinned SQL-exit file disappears (a rename must move the ceiling)', () => {
    const s = realSources();
    s.delete('lib/azure/uc-system-tables.ts');
    expect(analyzeUnityChokepoint(s).join('\n'))
      .toMatch(/uc-system-tables\.ts: pinned in SQL_EXIT_BASELINES but not present/);
  });

  it('fails when a new file combines the Loom Unity address with a request', () => {
    const s = realSources();
    s.set('app/api/rogue/route.ts', [
      'export async function GET() {',
      '  return fetch(`${process.env.LOOM_UNITY_URL}/api/2.1/unity-catalog/catalogs`);',
      '}',
    ].join('\n'));
    expect(analyzeUnityChokepoint(s).join('\n')).toMatch(/app\/api\/rogue\/route\.ts/);
  });

  it('fails when the recorder stops writing the Cosmos sink', () => {
    const s = realSources();
    s.set(RECORDER, s.get(RECORDER)!.replaceAll('auditLogContainer', 'somethingElse'));
    expect(analyzeUnityChokepoint(s).join('\n')).toMatch(/no auditLogContainer usage/);
  });

  it('fails when the recorder stops classifying denials', () => {
    const s = realSources();
    s.set(RECORDER, s.get(RECORDER)!.replaceAll("'denied'", "'failure'"));
    expect(analyzeUnityChokepoint(s).join('\n')).toMatch(/the 'denied' outcome is gone/);
  });

  it('fails when an allowlisted caller silently drops its audit row', () => {
    const s = realSources();
    s.set('lib/admin/health-probes.ts', s.get('lib/admin/health-probes.ts')!.replaceAll('recordUnityAccess', 'noRecord'));
    expect(analyzeUnityChokepoint(s).join('\n')).toMatch(/health-probes\.ts: allowlisted/);
  });

  it('fails when a KNOWN_UNAUDITED entry goes stale', () => {
    const s = realSources();
    s.delete('lib/azure/shortcut-credentials.ts');
    expect(analyzeUnityChokepoint(s).join('\n')).toMatch(/listed in KNOWN_UNAUDITED but not present/);
  });
});

/**
 * ROUND 4. The adjudicator's finding: check 4 (the no-bypass scan) SKIPS every
 * exempted file, so on the allowlist and on the declared gaps the per-file
 * outbound ratchet is the ONLY control — and `countOutbound()` matched only
 * `fetchWithTimeout(` and a bare `fetch(`, a strictly narrower vocabulary than
 * the scan that had been waived. Each attack below exited 0 against round 3.
 */
describe('ATTACK: non-fetch transports inside an EXEMPTED file (round-4 adjudication)', () => {
  const GRANT_BODY = "JSON.stringify({ changes: [{ principal: 'attacker@contoso.com', add: ['ALL_PRIVILEGES'] }] })";

  it('#15 — fails on undici `request` appended to the allowlisted databricks-client', () => {
    const s = realSources();
    s.set(DBX_CHOKEPOINT, `${s.get(DBX_CHOKEPOINT)!}
import { request as r } from 'undici';
export async function rogueGrant(host: string, token: string, fq: string) {
  await r(\`https://\${host}/api/2.1/unity-catalog/permissions/table/\${fq}\`, {
    method: 'PATCH',
    headers: { authorization: \`Bearer \${token}\` },
    body: ${GRANT_BODY},
  });
}
`);
    expect(analyzeUnityChokepoint(s).join('\n'))
      .toMatch(/databricks-client\.ts: \d+ outbound calls \(ratchet: 3\)/);
  });

  it('#16 — fails on node `https.request` appended to the allowlisted databricks-client', () => {
    const s = realSources();
    s.set(DBX_CHOKEPOINT, `${s.get(DBX_CHOKEPOINT)!}
import * as nhttps from 'node:https';
export function rogueGrant2(host: string, fq: string) {
  const req = nhttps.request({ host, path: \`/api/2.1/unity-catalog/permissions/table/\${fq}\`, method: 'PATCH' });
  req.end(${GRANT_BODY});
}
`);
    expect(analyzeUnityChokepoint(s).join('\n'))
      .toMatch(/databricks-client\.ts: \d+ outbound calls \(ratchet: 3\)/);
  });

  it('#17 — fails on axios appended to the DECLARED-GAP shortcut-credentials', () => {
    const s = realSources();
    const gap = 'lib/azure/shortcut-credentials.ts';
    expect(KNOWN_UNAUDITED.has(gap)).toBe(true);
    s.set(gap, `${s.get(gap)!}
import axios from 'axios';
export async function rogueCred(host: string, token: string, name: string) {
  await axios.post(\`https://\${host}/api/2.1/unity-catalog/storage-credentials\`, { name }, {
    headers: { authorization: \`Bearer \${token}\` },
  });
}
`);
    expect(analyzeUnityChokepoint(s).join('\n'))
      .toMatch(/shortcut-credentials\.ts: \d+ outbound calls \(ratchet: 2\)/);
  });

  it('#18 — fails on a dynamic import() of an HTTP client in an exempted file', () => {
    const s = realSources();
    s.set(DBX_CHOKEPOINT, `${s.get(DBX_CHOKEPOINT)!}
export async function rogueGrant3(host: string, fq: string) {
  const { request: send } = await import('undici');
  await send(\`https://\${host}/api/2.1/unity-catalog/permissions/table/\${fq}\`, { method: 'PATCH' });
}
`);
    expect(analyzeUnityChokepoint(s).join('\n'))
      .toMatch(/databricks-client\.ts: \d+ outbound calls \(ratchet: 3\)/);
  });
});

/**
 * The CLASS fix, asserted directly: the ratchet and the no-bypass scan must not
 * be able to disagree about what a transport is. Both derive from TRANSPORTS,
 * and every entry ships a `sample`, so this holds for anything added later —
 * the invariant is what stops a future transport being pasted into one consumer
 * and not the other.
 */
describe('TRANSPORT VOCABULARY — one definition, two consumers', () => {
  it('has a sample for every entry', () => {
    expect(TRANSPORTS.length).toBeGreaterThan(5);
    for (const t of TRANSPORTS) {
      expect(typeof t.sample, `${t.id} has no sample`).toBe('string');
      expect(['code', 'module']).toContain(t.scope);
      expect(t.re.test(t.sample), `${t.id}: its own sample does not match its regex`).toBe(true);
    }
  });

  it('every transport is seen by BOTH hasTransport (check 4) and countOutbound (check 2)', () => {
    for (const t of TRANSPORTS) {
      const src = `export async function go(url: string, body: unknown) {\n  ${t.sample}\n}\n`;
      expect(hasTransport(src), `${t.id}: invisible to the no-bypass scan`).toBe(true);
      expect(countOutbound(src), `${t.id}: invisible to the outbound ratchet`).toBeGreaterThan(0);
    }
  });

  it('every transport, combined with a UC REST path, fails the guard in a NEW file', () => {
    // ONE scan for ALL transports, not one scan EACH.
    //
    // Two rounds of this test have now been too slow, and both times the cost
    // was a whole-tree pass sitting inside the transport loop:
    //   round 1  realSources() in the loop  -> re-READ the tree per transport
    //   round 2  analyzeUnityChokepoint()   -> re-SCANNED it per transport
    // Round 1 was hoisted and round 2 was not, so this still did 9 full scans
    // of ~4,000 files. That made this ~17s and the FILE ~63s, which mattered
    // for a reason no one would guess from reading it: a spec file that spends
    // more than 60s of CUMULATIVE SYNCHRONOUS CPU fails the whole run with
    // `Timeout calling "onTaskUpdate"` while every test still passes — vitest's
    // bundled birpc rejects a reply the blocked worker never got to read. See
    // the note on realSources() above for the measured mechanism (#2944), and
    // PR #2785 for the CI runs where "one file >= 60000ms" predicted the
    // red/green outcome exactly (74.4s RED, 59.9s GREEN, 62.9s RED).
    //
    // The transports are INDEPENDENT rogue files, so N scans of one rogue file
    // and one scan of N rogue files assert the same thing. analyzeUnityChokepoint
    // accumulates into a single array with no early return and no cap, so every
    // planted file still reports. Each transport keeps its own file name and its
    // own assertion, so a failure still names the transport that walked past.
    const s = realSources();
    TRANSPORTS.forEach((t, i) => {
      s.set(`lib/azure/rogue-transport-${i}.ts`, [
        "const P = '/api/2.1/unity-catalog/permissions/table/a.b.c';",
        'export async function go(url: string, body: unknown) {',
        `  void P; ${t.sample}`,
        '}',
      ].join('\n'));
    });
    const found = analyzeUnityChokepoint(s).join('\n');
    TRANSPORTS.forEach((t, i) => {
      expect(found, `${t.id} walked past the scan`)
        .toMatch(new RegExp(`rogue-transport-${i}\\.ts: references a Unity Catalog`));
    });
    // Budget: this is ONE whole-tree scan, measured at ~0.18 s (2026-08-08), so
    // 20 s is ~100x headroom — enough that a heavily loaded shared runner is
    // never mistaken for a hang, and tight enough to actually mean something.
    // It was 60 s, chosen when a scan was priced at ~2 s; that is a timeout the
    // birpc deadline would have hit first, i.e. it could never have fired.
    // The real protection against this file drifting back over the cliff is the
    // `MASK_BUDGET_BYTES` ratchet at the top, not this number.
  }, 20_000);

  it('does NOT count transport-shaped PROSE or a doc comment as a call', () => {
    // env-checks/data-plane.ts really says "present a valid LOOM_INTERNAL_TOKEN
    // on the request (in addition to a tenant-admin session)". Round 3 tested
    // the union against RAW source, so that string was request-shaped code.
    const prose = [
      "export const SPEC = { remediation: 'present a token on the request (in addition to a session)' };",
      "// historical: this used to fetch(url) and import { request } from 'undici'",
      "/** see fetch(…) and axios */",
    ].join('\n');
    expect(countOutbound(prose)).toBe(0);
    expect(hasTransport(prose)).toBe(false);
  });

  it('still counts a REAL import specifier, which only exists inside a string', () => {
    const real = ["import { request as r } from 'undici';", 'export const go = (u: string) => r(u);'].join('\n');
    expect(countOutbound(real)).toBeGreaterThan(0);
    expect(hasTransport(real)).toBe(true);
  });
});

describe('masking', () => {
  it('blanks comments and strings but preserves offsets', () => {
    const src = 'const a = "{{{"; // }}}\nconst b = 1;';
    const masked = maskCommentsAndStrings(src);
    expect(masked.length).toBe(src.length);
    expect(masked).not.toContain('{');
    expect(masked).not.toContain('}');
    expect(masked.slice(0, 9)).toBe('const a =');
  });

  it('maskComments keeps string bodies so a module specifier is still readable', () => {
    const src = "// from 'undici'\nimport { request } from 'undici';";
    const masked = maskComments(src);
    expect(masked.length).toBe(src.length);
    expect(masked.slice(0, 16).trim()).toBe(''); // the comment is gone…
    expect(masked).toContain("from 'undici'"); // …the real import is not.
  });
});

/**
 * ROUND 5 (issue #2622). Two declared gaps closed, and the check that used to be
 * written TWICE by hand (ucFetch, dbxFetch) is now driven off one table so a
 * third and fourth transport could not be added with a weaker assertion.
 *
 * Every attack below is ONE whole-tree scan for the whole block, not one per
 * case. Independent planted files assert the same thing in one scan as in N, so
 * grouping costs no coverage. (Originally a budget decision, when a spec file
 * past 60 s of synchronous CPU failed the run on vitest's birpc `onTaskUpdate`
 * deadline with every test still passing — PR #2785. Post-#2959 a scan is
 * ~0.18 s and this file's upper bound is 6.1 s, so the grouping now stands on
 * readability; `MASK_BUDGET_BYTES` is what holds the cost line.)
 */
describe('ROUND 5 — every audited transport must record from its finally', () => {
  /**
   * Reviewer bypass #1, applied generically: neuter every REAL call to the
   * recorder and plant one decoy outside any `finally`.
   *
   * `__disabled_recordX(` does not match `\brecordX\s*\(` (no word boundary
   * between `_` and a letter), so the transport genuinely stops recording — and
   * the decoy keeps the file's recorder-symbol COUNT non-zero, so check 5
   * (MUST_AUDIT, "the symbol appears somewhere") still passes. That is the
   * point: only the brace-accurate finally check can catch this.
   */
  function gutFinally(src: string, symbol: string): string {
    const neutered = src.split(`${symbol}(`).join(`__disabled_${symbol}(`);
    return `${neutered}\nfunction __decoy_${symbol}() { void ${symbol}({} as never); }\n`;
  }

  it('covers all five transports from ONE table', () => {
    expect(AUDITED_TRANSPORTS.map((t: { fn: string }) => t.fn).sort())
      .toEqual(['acctFetch', 'dbxFetch', 'ucFetch', 'ucSecurable', 'ucSql']);
    for (const t of AUDITED_TRANSPORTS as Array<{ file: string; fn: string; recorder: string; why: string }>) {
      expect(typeof t.why, `${t.fn} has no explanation`).toBe('string');
      expect(t.why.length).toBeGreaterThan(40);
    }
  });

  it('fails for EVERY transport whose finally stops recording (one scan, five attacks)', () => {
    const s = realSources();
    for (const t of AUDITED_TRANSPORTS as Array<{ file: string; recorder: string }>) {
      const src = s.get(t.file);
      expect(src, `${t.file} is not in the scanned tree`).toBeTruthy();
      const gutted = gutFinally(src!, t.recorder);
      expect(gutted).not.toBe(src); // the mutation must have applied
      s.set(t.file, gutted);
    }
    const found = analyzeUnityChokepoint(s).join('\n');
    for (const t of AUDITED_TRANSPORTS as Array<{ file: string; fn: string; recorder: string }>) {
      expect(found, `${t.fn} walked past the finally check`)
        .toMatch(new RegExp(`${t.recorder}\\( is not called from inside a \`finally\` block of ${t.fn}`));
      // …and the weaker "symbol appears in the file" check did NOT fire, which
      // is what makes this a real regression test for the finally match.
      expect(found).not.toMatch(new RegExp(`${t.file.replace(/[.[\]/]/g, '\\$&')}: allowlisted`));
    }
  });
});

describe('ROUND 5 — the SQL half is AUDITED, not merely ratcheted', () => {
  const GOVERNANCE_FILES = [
    'lib/azure/unity-catalog-client.ts',
    'lib/azure/uc-system-tables.ts',
    'app/api/items/[type]/[id]/security/route.ts',
  ];

  it('pins every UC-governance file at ZERO raw executeStatement( exits', () => {
    // A frozen non-zero count is not a trail — it only promises the hole will
    // not GROW. #2622 closed it: the only permitted raw exit in the repo is the
    // audited wrapper's own.
    for (const f of GOVERNANCE_FILES) {
      expect(SQL_EXIT_BASELINES.get(f), `${f} is not pinned at 0`).toBe(0);
    }
    expect(SQL_EXIT_BASELINES.get(SQL_CHOKEPOINT)).toBe(1);
    expect(SQL_EXIT_BASELINE).toBe(0); // the back-compat scalar tracks the client
    // The security route — the ABAC column-mask + row-filter wizard, 10 raw
    // exits — was never pinned at all before this round.
    expect(SQL_EXIT_BASELINES.has('app/api/items/[type]/[id]/security/route.ts')).toBe(true);
  });

  // The NEGATIVE half — a raw executeStatement( coming back to any of these
  // three — is `#19 — ratchets SQL exits in EVERY pinned governance file`
  // above: one scan, all three files. Kept there rather than duplicated here
  // because the payloads are independent, so one scan of N asserts exactly what
  // N scans of one would. (The original reason given was cost; a scan is ~0.18 s
  // as of 2026-08-08, so grouping is now a readability choice, not a budget one.)

  it('CONTROL — the SAME edit through the AUDITED wrapper passes', () => {
    // Without this, a ratchet that simply banned all SQL from these files would
    // look identical to a ratchet that bans the UN-AUDITED transport. The fix
    // has to leave the audited path open or it is not a fix, it is a ban.
    const s = realSources();
    for (const f of GOVERNANCE_FILES) {
      s.set(f, `${s.get(f)!}
export async function auditedDdl(warehouseId: string) {
  return ucSql(warehouseId, 'DROP POLICY \`p\` ON TABLE a.b.c', { target: 'a.b.c' });
}
`);
    }
    expect(analyzeUnityChokepoint(s)).toEqual([]);
  });
});

describe('ROUND 5 — the account plane was invisible to the address vocabulary', () => {
  it('is now allowlisted, pinned, and required to audit', () => {
    // It targets /api/2.0/accounts/{id}, which matches NEITHER address regex, so
    // check 4 could never have reported it and it was not even in
    // KNOWN_UNAUDITED. "The scan found nothing" was not "there is nothing".
    const s = realSources();
    const src = s.get(ACCOUNT_CHOKEPOINT)!;
    expect(src).toBeTruthy();
    expect(referencesCatalogAddress(ACCOUNT_CHOKEPOINT, src)).toBe(false);
    expect(hasTransport(src)).toBe(true);
    expect(CHOKEPOINT_FILES.has(ACCOUNT_CHOKEPOINT)).toBe(true);
    expect(OUTBOUND_BASELINE.get(ACCOUNT_CHOKEPOINT)).toBe(1);
  });

  it('fails when the account client grows a second un-audited outbound call', () => {
    const s = realSources();
    s.set(ACCOUNT_CHOKEPOINT, `${s.get(ACCOUNT_CHOKEPOINT)!}
export async function rogueAssign(host: string, token: string, ws: string, ms: string) {
  await fetch(\`https://\${host}/api/2.0/accounts/x/workspaces/\${ws}/metastore\`, {
    method: 'PUT', headers: { authorization: \`Bearer \${token}\` }, body: JSON.stringify({ metastore_id: ms }),
  });
}
`);
    expect(analyzeUnityChokepoint(s).join('\n'))
      .toMatch(/unity-catalog-account-client\.ts: \d+ outbound calls \(ratchet: 1\)/);
  });
});

/**
 * ROUND 6 (issue #2622, gap 1 — the LAST declared gap).
 *
 * `shortcut-credentials.ts` mints storage credentials and external locations
 * from its own private transport and cannot be instrumented in place (repo-level
 * credential-path read/write deny). Rounds 2–5 stopped there, twice. The fix is
 * an audited FACADE plus an IMPORT choke point — and the import choke point is
 * the half that matters, because a facade nobody is obliged to use is a comment.
 *
 * Every attack below is one whole-tree scan for the block. As of the #2622
 * residual pass the check-8 attack scans the REAL tree again rather than the
 * synthetic map it was cut down to — see the note inside it.
 */
describe('ROUND 6 — the securable IMPORT choke point (check 8)', () => {
  it('is wired: the facade is an audited transport and the raw module stays declared', () => {
    expect(AUDITED_TRANSPORTS.some((t: { file: string }) => t.file === SECURABLE_CHOKEPOINT)).toBe(true);
    // The entry is deliberately KEPT: no un-audited call PATH remains, but the
    // transport itself is still un-instrumented, and the honest statement of
    // that is the entry, not its removal.
    expect(KNOWN_UNAUDITED.has(SECURABLE_RAW)).toBe(true);
    // The allowlist is the two NON-catalog exports — stated in the affirmative,
    // so anything new in that unreadable file is denied by default.
    expect([...SECURABLE_RAW_PUBLIC].sort()).toEqual(['getKeyVaultSecret', 'keyVaultConfigGate']);
  });

  it('fails on the pre-#2622 import AND on every evasion a name scan invites', () => {
    // ## Why this scans the REAL tree (restored, #2622 residual)
    //
    // This block originally scanned a synthetic 6-file map. The stated reason was
    // cost: "this file already sits at the vitest birpc cliff — measured at 81s
    // …so adding scans is not free". That was true when it was written and is not
    // true now — #2959 took a whole-tree scan from ~2.3 s to ~0.18 s, and this
    // file's measured upper bound is 6.1 s against a 60 s deadline.
    //
    // So the trade is reversed: the real tree is affordable and strictly
    // stronger. The planted rogues below now have to be found among 5,470 real
    // files rather than 5, which is the configuration CI actually runs, and the
    // two NEGATIVE assertions (the legitimate `getKeyVaultSecret` /
    // `keyVaultConfigGate` imports must NOT be flagged) are now made against
    // every real importer in the repo instead of one hand-built file.
    //
    // `MASK_BUDGET_BYTES` is what keeps this honest from here: if a future change
    // makes a scan expensive again, the budget test above goes red immediately
    // instead of this file silently drifting back over the cliff.
    const s = realSources();
    const engines = 'lib/azure/shortcut-engines.ts';
    expect(s.has(engines)).toBe(true);

    // (0) THE REGRESSION — the EXACT import this PR replaced, prepended to the
    //     REAL file. If check 8 could not fail on this, the facade would be
    //     decorative: it would exist, and nothing would oblige anyone to route
    //     through it.
    s.set(engines, [
      'import {',
      '  getKeyVaultSecret,',
      '  keyVaultConfigGate,',
      '  ensureUcAwsStorageCredential,',
      '  ensureUcGcpStorageCredential,',
      '  ensureUcExternalLocation,',
      '  deleteUcExternalLocation,',
      '  deleteUcStorageCredential,',
      "} from './shortcut-credentials';",
      s.get(engines)!,
    ].join('\n'));
    // (a) a RENAMED named import — the EXPORTED name is what is matched.
    s.set('lib/azure/rogue-sec-a.ts',
      "import { ensureUcExternalLocation as mk } from './shortcut-credentials';\nexport const go = mk;\n");
    // (b) a NAMESPACE import — hands over EVERY export at once, so it can
    //     never be allowlisted by name.
    s.set('lib/azure/rogue-sec-b.ts',
      "import * as creds from './shortcut-credentials';\nexport const go = creds;\n");
    // (c) a DYNAMIC import — same, deferred.
    s.set('lib/azure/rogue-sec-c.ts',
      "export async function go() { const m = await import('./shortcut-credentials'); return m; }\n");
    // (d) a BRAND-NEW un-audited export added to the unreadable file and
    //     consumed elsewhere. A denylist of today's five would say NOTHING
    //     about this; the allowlist denies it by default. This is the whole
    //     reason check 8 is stated in the affirmative.
    s.set('app/api/rogue-sec/route.ts',
      "import { rotateUcStorageCredential } from '@/lib/azure/shortcut-credentials';\n"
      + 'export async function POST() { await rotateUcStorageCredential(); return new Response(); }\n');

    const found = analyzeUnityChokepoint(s).join('\n');
    for (const sym of [
      'ensureUcAwsStorageCredential',
      'ensureUcGcpStorageCredential',
      'ensureUcExternalLocation',
      'deleteUcExternalLocation',
      'deleteUcStorageCredential',
    ]) {
      expect(found, `${sym} walked past the import choke point`)
        .toMatch(new RegExp(`shortcut-engines\\.ts: imports \`${sym}\` from `));
    }
    // …and the two non-catalog exports are NOT flagged — asserted here against
    // EVERY real importer in the tree (the facade, and both lakehouse routes),
    // not just the one synthetic file that used to stand in for them.
    expect(found).not.toMatch(/imports `getKeyVaultSecret`/);
    expect(found).not.toMatch(/imports `keyVaultConfigGate`/);
    expect(found, 'a renamed import walked past').toMatch(/rogue-sec-a\.ts: imports `ensureUcExternalLocation`/);
    expect(found, 'a namespace import walked past').toMatch(/rogue-sec-b\.ts: imports `\*`/);
    expect(found, 'a dynamic import walked past').toMatch(/rogue-sec-c\.ts: imports `\*`/);
    expect(found, 'a NEW un-audited export walked past')
      .toMatch(/rogue-sec\/route\.ts: imports `rotateUcStorageCredential`/);
  });

  it('does NOT fire on the legitimate importers that ship today', () => {
    // No whole-tree scan: `securableRawImports` is pure, and the tree-wide PASS
    // (which now includes check 8) is asserted once at the top of this file.
    //
    // The routes really do import getKeyVaultSecret from that module and the
    // facade really does import all five. If either tripped, check 8 would be
    // unusable and would get disabled rather than fixed.
    const s = realSources();
    expect(securableRawImports(s.get(SECURABLE_CHOKEPOINT)!).sort()).toEqual([
      'deleteUcExternalLocation',
      'deleteUcStorageCredential',
      'ensureUcAwsStorageCredential',
      'ensureUcExternalLocation',
      'ensureUcGcpStorageCredential',
    ]);
    expect(securableRawImports(s.get('lib/azure/shortcut-engines.ts')!).sort())
      .toEqual(['getKeyVaultSecret', 'keyVaultConfigGate']);
    for (const route of ['app/api/lakehouse/shortcuts/route.ts', 'app/api/lakehouse/shortcuts/test/route.ts']) {
      for (const name of securableRawImports(s.get(route)!)) {
        expect(SECURABLE_RAW_PUBLIC.has(name), `${route} imports non-public ${name}`).toBe(true);
      }
    }
  });

  it('reads an import, not a mention of one in a comment', () => {
    expect(securableRawImports("// import { deleteUcStorageCredential } from './shortcut-credentials';")).toEqual([]);
    expect(securableRawImports("/** see './shortcut-credentials' */\nexport const a = 1;")).toEqual([]);
    // …but the real thing, whose specifier only exists inside a string, counts.
    expect(securableRawImports("import { deleteUcStorageCredential } from './shortcut-credentials';"))
      .toEqual(['deleteUcStorageCredential']);
    expect(securableRawImports("import { getKeyVaultSecret } from '@/lib/azure/shortcut-credentials';"))
      .toEqual(['getKeyVaultSecret']);
    expect(securableRawImports("import { getKeyVaultSecret } from '../shortcut-credentials';"))
      .toEqual(['getKeyVaultSecret']);
    // A different module named similarly must not be swept in.
    expect(securableRawImports("import { x } from './shortcut-engines';")).toEqual([]);
  });

  it('fails when the facade disappears while the raw module remains', () => {
    // Deleting the facade must not silently hand shortcut-engines back its
    // un-audited imports. Cheap: a 3-file synthetic tree, not the real one —
    // check 8 and the AUDITED_TRANSPORTS presence check are both pure over the
    // source map, so a whole-tree scan would prove nothing extra here.
    const failures = analyzeUnityChokepoint(new Map([
      [SECURABLE_RAW, 'export async function deleteUcStorageCredential() {}\n'],
    ])).join('\n');
    expect(failures).toMatch(/MISSING CHOKE POINT: lib\/azure\/uc-securable\.ts does not exist/);
  });
});
