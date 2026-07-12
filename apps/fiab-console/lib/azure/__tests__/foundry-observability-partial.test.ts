/**
 * Unit tests for assembleObservabilitySummary (foundry-client.ts) — the pure
 * assembler behind the AI Foundry Monitoring / "Application analytics" dashboard.
 *
 * Proves the perf/null fix: the four App Insights KQL sections are settled
 * INDEPENDENTLY, so a slow/failing (rejected) query degrades only its own
 * section (empty array + recorded reason + `partial:true`) instead of throwing
 * — and the mapper never dereferences a null/absent table. Per
 * .claude/rules/no-vaporware.md the partial state is surfaced honestly, not
 * filled with fake data.
 */
import { describe, it, expect, vi } from 'vitest';

// foundry-client pulls in @azure/identity at import time — stub it so the
// module loads without a live credential (we only exercise the pure assembler).
vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import { assembleObservabilitySummary } from '../foundry-client';

type Table = { cols: string[]; rows: any[][] };
const ok = (v: Table): PromiseSettledResult<Table> => ({ status: 'fulfilled', value: v });
const fail = (msg: string): PromiseSettledResult<Table> => ({ status: 'rejected', reason: new Error(msg) });

const totalsTable: Table = {
  cols: ['requests', 'dependencies', 'failures', 'inputTokens', 'outputTokens', 'p50Ms', 'p95Ms'],
  rows: [[120, 340, 5, 10_000, 8_000, 42, 310]],
};
const reqTable: Table = {
  cols: ['timestamp', 'count', 'failed'],
  rows: [['2026-07-12T00:00:00Z', 60, 2], ['2026-07-12T01:00:00Z', 60, 3]],
};
const tokTable: Table = {
  cols: ['timestamp', 'input', 'output'],
  rows: [['2026-07-12T00:00:00Z', 5000, 4000]],
};
const opTable: Table = {
  cols: ['op', 'count', 'p95', 'failed'],
  rows: [['chat.completions', 80, 290, 1]],
};

describe('assembleObservabilitySummary', () => {
  it('assembles a complete summary when every section resolves (no partial flag)', () => {
    const s = assembleObservabilitySummary(24, {
      totals: ok(totalsTable),
      requestsOverTime: ok(reqTable),
      tokensOverTime: ok(tokTable),
      byOperation: ok(opTable),
    });
    expect(s.hours).toBe(24);
    expect(s.totals.requests).toBe(120);
    expect(s.totals.p95Ms).toBe(310);
    expect(s.requestsOverTime).toHaveLength(2);
    expect(s.tokensOverTime[0]).toEqual({ t: '2026-07-12T00:00:00Z', input: 5000, output: 4000 });
    expect(s.byOperation[0]).toEqual({ operation: 'chat.completions', count: 80, p95Ms: 290, failed: 1 });
    expect(s.partial).toBeUndefined();
    expect(s.sectionErrors).toBeUndefined();
  });

  it('degrades a single failed section to empty + records the reason (partial), never throws', () => {
    const s = assembleObservabilitySummary(6, {
      totals: ok(totalsTable),
      requestsOverTime: fail('Request to appi timed out after 30000ms'),
      tokensOverTime: ok(tokTable),
      byOperation: ok(opTable),
    });
    // Surviving sections intact…
    expect(s.totals.requests).toBe(120);
    expect(s.tokensOverTime).toHaveLength(1);
    expect(s.byOperation).toHaveLength(1);
    // …failed section defaulted to [] (no crash, no fake data)…
    expect(s.requestsOverTime).toEqual([]);
    // …and the partial signal names the section that failed.
    expect(s.partial).toBe(true);
    expect(s.sectionErrors?.requestsOverTime).toContain('timed out');
    expect(s.sectionErrors?.totals).toBeUndefined();
  });

  it('handles ALL sections failing without throwing — every array empty, totals zeroed', () => {
    const s = assembleObservabilitySummary(168, {
      totals: fail('403'),
      requestsOverTime: fail('403'),
      tokensOverTime: fail('403'),
      byOperation: fail('403'),
    });
    expect(s.totals.requests).toBe(0);
    expect(s.totals.p95Ms).toBeUndefined();
    expect(s.requestsOverTime).toEqual([]);
    expect(s.byOperation).toEqual([]);
    expect(s.partial).toBe(true);
    expect(Object.keys(s.sectionErrors ?? {})).toHaveLength(4);
  });

  it('tolerates a fulfilled-but-empty table (no rows) without dereferencing null', () => {
    const s = assembleObservabilitySummary(24, {
      totals: ok({ cols: [], rows: [] }),
      requestsOverTime: ok({ cols: ['timestamp', 'count', 'failed'], rows: [] }),
      tokensOverTime: ok({ cols: [], rows: [] }),
      byOperation: ok({ cols: [], rows: [] }),
    });
    expect(s.totals.requests).toBe(0);
    expect(s.requestsOverTime).toEqual([]);
    expect(s.partial).toBeUndefined();
  });
});
