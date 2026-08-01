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
  TRANSPORTS,
  CHOKEPOINT,
  DBX_CHOKEPOINT,
  RECORDER,
  SQL_EXIT_BASELINE,
  SQL_EXIT_BASELINES,
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
  it('fails when a new SQL exit is added to the catalog client', () => {
    const s = realSources();
    s.set(CHOKEPOINT, `${s.get(CHOKEPOINT)!}\nasync function sneak(w: string) { return executeStatement(w, 'DROP TABLE x'); }\n`);
    const failures = analyzeUnityChokepoint(s);
    expect(failures.join('\n')).toMatch(new RegExp(`executeStatement\\( exits \\(ratchet: ${SQL_EXIT_BASELINE}\\)`));
  });

  // Round 4, #8: the LU-3 audit try/finally pushed unity-catalog-client.ts over
  // its check-file-size ceiling, so the 165-line system-table block moved to
  // uc-system-tables.ts — carrying one executeStatement( out of a ratchet that
  // was scoped to ONE file. A refactor must not be able to narrow a ratchet.
  it('#19 — ratchets SQL exits in EVERY pinned file, not just the choke point', () => {
    const s = realSources();
    const moved = 'lib/azure/uc-system-tables.ts';
    expect(SQL_EXIT_BASELINES.has(moved), `${moved} is not pinned`).toBe(true);
    expect(s.has(moved)).toBe(true);
    s.set(moved, `${s.get(moved)!}\nexport async function sneak(w: string) { return executeStatement(w, 'DROP TABLE x'); }\n`);
    expect(analyzeUnityChokepoint(s).join('\n'))
      .toMatch(/uc-system-tables\.ts: \d+ executeStatement\( exits \(ratchet: \d+\)/);
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
    // realSources() re-reads the WHOLE source tree. Calling it inside the loop
    // did that once per transport and then scanned the result each time, which
    // is fine uninstrumented and times out at 30s under v8 coverage — the CI
    // failure that blocked the vitest-3 bump. The base map is identical every
    // iteration, so read it ONCE and clone (a Map copy, not a disk walk) for the
    // per-transport mutation. Same assertions, same coverage, no rescan.
    const base = realSources();
    for (const t of TRANSPORTS) {
      const s = new Map(base);
      s.set('lib/azure/rogue-transport.ts', [
        "const P = '/api/2.1/unity-catalog/permissions/table/a.b.c';",
        'export async function go(url: string, body: unknown) {',
        `  void P; ${t.sample}`,
        '}',
      ].join('\n'));
      expect(analyzeUnityChokepoint(s).join('\n'), `${t.id} walked past the scan`)
        .toMatch(/rogue-transport\.ts: references a Unity Catalog/);
    }
    // Explicit budget, not the 30s global default. This test scans the ENTIRE
    // source tree once per transport — genuinely large work, ~50s even
    // uninstrumented and ~3x that under v8 coverage. The global default was
    // calibrated for ordinary unit tests and timed out here in CI, blocking the
    // vitest-3 upgrade.
    //
    // This does NOT weaken the assertion: every transport is still checked
    // against the real tree and must be caught. It only stops a slow-but-correct
    // test being reported as a failure because a default did not anticipate it.
  }, 180_000);

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
