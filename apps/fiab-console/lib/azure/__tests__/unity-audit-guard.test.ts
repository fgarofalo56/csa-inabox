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
  AUDITED_TRANSPORTS,
  OUTBOUND_BASELINE,
  CHOKEPOINT_FILES,
  KNOWN_UNAUDITED,
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
    expect(analyzeUnityChokepoint(s).join('\n'))
      .toMatch(/iceberg-catalog-client\.ts: \d+ outbound calls \(ratchet: 2\)/);
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
    // for a reason no one would guess from reading it: vitest's worker RPC has
    // a 60s deadline hardcoded in its bundled birpc, and a file that runs past
    // it fails the whole run with `Timeout calling "onTaskUpdate"` while every
    // test still passes. Measured across three CI runs, "one file >= 60000ms"
    // predicted the red/green outcome exactly (74.4s RED, 59.9s GREEN, 62.9s
    // RED) — see PR #2785. This file was the only such file in 1302.
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
    // Budget kept generous but no longer enormous: this is now a single
    // whole-tree scan (~2s), not nine. It stays well above that so a slow
    // runner is never mistaken for a hang, and far below the 60s RPC deadline
    // the old shape kept flirting with.
  }, 60_000);

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
 * case — see the note on the TRANSPORTS test above: a spec file that runs past
 * 60s fails the run on vitest's birpc `onTaskUpdate` deadline while every test
 * still passes (PR #2785). Independent planted files assert the same thing in
 * one scan as in N.
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

  it('covers all four transports from ONE table', () => {
    expect(AUDITED_TRANSPORTS.map((t: { fn: string }) => t.fn).sort())
      .toEqual(['acctFetch', 'dbxFetch', 'ucFetch', 'ucSql']);
    for (const t of AUDITED_TRANSPORTS as Array<{ file: string; fn: string; recorder: string; why: string }>) {
      expect(typeof t.why, `${t.fn} has no explanation`).toBe('string');
      expect(t.why.length).toBeGreaterThan(40);
    }
  });

  it('fails for EVERY transport whose finally stops recording (one scan, four attacks)', () => {
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
  // above: one scan, all three files. Not repeated here, because a whole-tree
  // scan is ~1.2s and this file has a 60s birpc cliff (see PR #2785).

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
