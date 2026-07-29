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
  isClientComponent,
  readSources,
  CHOKEPOINT,
  DBX_CHOKEPOINT,
  RECORDER,
  SQL_EXIT_BASELINE,
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

describe('masking', () => {
  it('blanks comments and strings but preserves offsets', () => {
    const src = 'const a = "{{{"; // }}}\nconst b = 1;';
    const masked = maskCommentsAndStrings(src);
    expect(masked.length).toBe(src.length);
    expect(masked).not.toContain('{');
    expect(masked).not.toContain('}');
    expect(masked.slice(0, 9)).toBe('const a =');
  });
});
