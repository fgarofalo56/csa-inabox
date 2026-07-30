/**
 * ReDoS class — ROUND-2 SIBLINGS.
 *
 * Round 1 fixed `lib/thread/sql-guard.ts` (`/;+\s*$/`, measured 166 571 ms on a
 * 300k-`;` body) and 32 slug trims in `app/api/**`. It did NOT fix the same
 * shapes elsewhere: 19 more production copies of `/;+\s*$/` ran on
 * user-supplied SQL/KQL/DAX (including `POST /api/items/
 * databricks-sql-warehouse/[id]/ctas`, where the regex ran BEFORE the 64 KB
 * length check), and 26 quadratic slug/underscore trims survived in `lib/**`.
 *
 * These tests are per-CALL-SITE: they exercise the exported functions the
 * routes actually call, not just the shared helper, so a future paste-back of
 * the regex at any of these sites turns this file red.
 */
import { describe, it, expect } from 'vitest';
import { stripTrailingSemicolons, trimEdges } from '../../util/trim';
import { capSql } from '../../copilot/report-tools';
import { safeHubName, safeCgName } from '../eventstream-standup';
import { foundryAgentNameFor } from '../../copilot/connected-agents';
import { kqlName } from '../../governance/policy-code/compilers/adx';
import { percentPyFilename } from '../../notebook/py-roundtrip';
import { normalizeTableKey } from '../lakehouse-interop-model';
import { contentDisposition } from '../../api/content-disposition';

/** The exact regex every one of the 19 call sites used, for parity assertions. */
const OLD_SEMI = (s: string) => s.trim().replace(/;+\s*$/, '');

describe('stripTrailingSemicolons — parity with the regex it replaced', () => {
  for (const s of [
    'select 1',
    'select 1;',
    'select 1;;;',
    '  select 1;  ',
    'select 1 ; ;',
    ';',
    ';;;',
    '',
    'select ";" as c',
  ]) {
    it(`parity on ${JSON.stringify(s)}`, () => {
      expect(stripTrailingSemicolons(s)).toBe(OLD_SEMI(s));
    });
  }
  it('is null/undefined safe (the routes pass body fields straight in)', () => {
    expect(stripTrailingSemicolons(undefined as unknown as string)).toBe('');
    expect(stripTrailingSemicolons(null as unknown as string)).toBe('');
  });
});

describe('adversarial timing — the 19 sibling call sites', () => {
  /**
   * 50 000 is chosen deliberately. Measured on this box for `/;+\s*$/`:
   *   n=8 000 → 118 ms · 16 000 → 465 ms · 32 000 → 2 095 ms · 64 000 → 13 356 ms
   * (linear scan: 0 ms at every n). 50 000 is comfortably over the 1 s budget
   * with the regex — so reverting the fix fails this test in ~8 s rather than
   * hanging the worker for ~5 minutes, which is what a 300 k pump does and
   * which makes the mutation unobservable in CI.
   *
   * `/api/items/[type]/[id]/assist` caps its body at 64 KB — i.e. inside the
   * attacker's reach. `POST …/databricks-sql-warehouse/[id]/ctas` ran the regex
   * BEFORE its 64 KB check, so there was no cap at all.
   */
  const PUMP = ';'.repeat(50_000);

  it('stripTrailingSemicolons: 50k-semicolon run', () => {
    const started = Date.now();
    expect(stripTrailingSemicolons(PUMP)).toBe('');
    expect(stripTrailingSemicolons(`select 1${PUMP}x`)).toBe(`select 1${PUMP}x`);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('capSql (lib/copilot/report-tools — Copilot narrative tool)', () => {
    const started = Date.now();
    capSql(`${PUMP}x`);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('slug siblings — behaviour preserved, runs no longer retried', () => {
  it('safeHubName / safeCgName keep their output', () => {
    expect(safeHubName('My Hub!')).toBe('my-hub');
    expect(safeHubName('--a--b--')).toBe('a--b');
    expect(safeCgName('My Group!', 2)).toContain('my-group');
  });
  it('foundryAgentNameFor keeps its deterministic name', () => {
    expect(foundryAgentNameFor('abc123', 'data-agent')).toBe('loom-data-abc123');
    expect(foundryAgentNameFor('A B', 'operations-agent')).toBe('loom-ops-a-b');
  });
  it('percentPyFilename keeps its output', () => {
    expect(percentPyFilename('My Notebook')).toBe('My-Notebook.py');
  });
  it('timing: 50k separator runs through the real call sites', () => {
    // Same 50k rationale as above: the slug chain measured 1.35 s at n=50 000
    // with `/^-+|-+$/g`, so reverting any one of these sites fails here fast.
    //
    // The run must NOT start at index 0. With `/^-+|-+$/g` a leading run is
    // eaten in one step by the `^-+` alternative (linear); it is the
    // `-+$` alternative that retries the run from every offset. A pump of
    // `'-'.repeat(n) + 'x'` therefore does NOT reproduce the quadratic
    // behaviour — the first version of this test used exactly that and stayed
    // GREEN under the mutation, i.e. it was a test that measured nothing.
    const run = `x${'-'.repeat(50_000)}y`;
    const started = Date.now();
    safeHubName(run);
    safeCgName(run, 1);
    foundryAgentNameFor(run, 'data-agent');
    percentPyFilename(run);
    trimEdges(`x${'_'.repeat(50_000)}y`, '_');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('two-sided slash trim `/^\\/+|\\/+$/g` — 39 siblings converted', () => {
  it('normalizeTableKey keeps its behaviour', () => {
    expect(normalizeTableKey('/Tables/sales/')).toBe('sales');
    expect(normalizeTableKey('///dbo.orders///')).toBe('dbo.orders');
    expect(normalizeTableKey('../etc')).toBe('');
    expect(normalizeTableKey(undefined)).toBe('');
  });
  it('timing: a 50k slash run that is NOT at index 0', () => {
    // `table` reaches this from a request body (lakehouse interop routes).
    const started = Date.now();
    normalizeTableKey(`t${'/'.repeat(50_000)}y`);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('incomplete-sanitization siblings', () => {
  it('kqlName escapes CR/LF (a KQL literal is single-line)', () => {
    // A bare `.replace(/["\\]/g, '\\$&')` left the newline intact, so the
    // remainder of a `.alter table … policy` command started a new statement.
    expect(kqlName('ok_name')).toBe('ok_name');
    expect(kqlName('has space')).toBe('["has space"]');
    const evil = kqlName('t"\n.drop table x');
    expect(evil).not.toContain('\n');
    expect(evil).toContain('\\n');
    expect(evil).toContain('\\"');
  });

  it('contentDisposition drops CR/LF (a header value cannot carry them)', () => {
    // The sharpest single assertion, kept in its own `it` so the mutation
    // message names the header-injection case rather than the UTF-8 form.
    const v = contentDisposition('attachment', 'x\r\nx-loom-injected: 1');
    expect(v).not.toMatch(/[\r\n]/);
    expect(v).toContain('filename="xx-loom-injected_ 1"');
  });

  it('contentDisposition cannot emit a quote, a backslash or CR/LF', () => {
    // `path` on /api/aml/runs/[id]/artifact and `filename` on
    // /api/lakehouse/download are QUERY PARAMETERS.
    for (const hostile of [
      'a"b.csv',
      'a\\.csv',
      'trailing\\',
      'x\r\nx-injected: 1',
      '../../etc/passwd',
      'C:\\Windows\\win.ini',
      '\u0000null.csv',
    ]) {
      const v = contentDisposition('attachment', hostile);
      expect(v).not.toMatch(/[\r\n\0]/);
      // the only quotes are the two delimiting the ASCII fallback
      expect((v.match(/"/g) || []).length).toBe(2);
      expect(v.slice(v.indexOf('filename="') + 10, v.indexOf('";'))).not.toContain('\\');
      expect(v).toContain(`filename*=UTF-8''`);
    }
  });

  it('contentDisposition keeps a readable name and a UTF-8 form', () => {
    expect(contentDisposition('attachment', 'q1 report.csv')).toBe(
      `attachment; filename="q1 report.csv"; filename*=UTF-8''q1%20report.csv`,
    );
    const v = contentDisposition('inline', 'báz.png');
    expect(v).toContain('filename="b_z.png"');
    expect(v).toContain(`filename*=UTF-8''b%C3%A1z.png`);
  });
});
