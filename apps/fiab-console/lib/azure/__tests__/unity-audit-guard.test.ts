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
import fs from 'node:fs';
import path from 'node:path';
import {
  analyzeUnityChokepoint,
  callsSymbolInFinallyOf,
  maskCommentsAndStrings,
  CHOKEPOINT,
  DBX_CHOKEPOINT,
  RECORDER,
  SQL_EXIT_BASELINE,
} from '../../../../../scripts/ci/check-unity-audit-chokepoint.mjs';

const APP_ROOT = path.resolve(__dirname, '..', '..', '..');

/** The files the analysis actually reads, loaded from the real tree. */
function realSources(): Map<string, string> {
  const files = [
    CHOKEPOINT,
    DBX_CHOKEPOINT,
    RECORDER,
    'lib/azure/uc-backend.ts',
    'lib/admin/health-probes.ts',
    'lib/azure/dq-monitor-client.ts',
    'lib/azure/iceberg-catalog-client.ts',
    'lib/azure/shortcut-credentials.ts',
  ];
  const m = new Map<string, string>();
  for (const f of files) {
    const abs = path.join(APP_ROOT, f);
    if (fs.existsSync(abs)) m.set(f, fs.readFileSync(abs, 'utf8'));
  }
  return m;
}

describe('unity-audit-chokepoint guard — the real tree', () => {
  it('passes on the shipped sources', () => {
    expect(analyzeUnityChokepoint(realSources())).toEqual([]);
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
