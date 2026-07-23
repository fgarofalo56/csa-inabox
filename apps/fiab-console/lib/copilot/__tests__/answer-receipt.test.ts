/**
 * N10 — Answer Receipt assembler unit tests.
 *
 * Composes a REAL turn trace (built with deriveTurnTraces from a flat step
 * stream, exactly as the orchestrator persists it) → the assembled receipt, and
 * asserts:
 *   • the exact SQL/KQL/Cypher text + real row counts are extracted,
 *   • graph-query rows count as graph paths, DAX dialect is resolved from the
 *     tool name (not the `sql` arg it rides on),
 *   • grounding citations map to sources, tools/tier/cost/timings carry through,
 *   • the badge is Unverified ⚠ by default, Verified ✓ only with the N9 signal,
 *     and Refused ⛔ when the loop refused (a content-safety error step).
 */
import { describe, it, expect } from 'vitest';
import { deriveTurnTraces } from '../turn-trace';
import { assembleAnswerReceipt, type ReceiptTraceLike } from '../answer-receipt';

const CREATED = '2026-07-23T00:00:00.000Z';

/** A realistic multi-tool answer: a warehouse SQL query + a graph Cypher query. */
function flatAnsweredSteps(over: Record<string, unknown> = {}) {
  return [
    { kind: 'thought', content: 'User prompt: how many orders shipped last week and who approved them?' },
    { kind: 'thought', content: 'Plan: count shipped orders in the warehouse, then trace approvers in the graph.' },
    { kind: 'context_usage', usage: {} },
    { kind: 'tool_call', name: 'warehouse_run_query', args: { sql: 'SELECT COUNT(*) FROM Orders WHERE Shipped >= DATEADD(day,-7,GETDATE())' }, callId: 'c1' },
    { kind: 'tool_result', name: 'warehouse_run_query', callId: 'c1', durationMs: 42, result: { rows: [{ n: 128 }], rowCount: 1 } },
    { kind: 'tool_call', name: 'graph_cypher_query', args: { cypher: 'MATCH (o:Order)-[:APPROVED_BY]->(u:User) RETURN u.name' }, callId: 'c2' },
    { kind: 'tool_result', name: 'graph_cypher_query', callId: 'c2', durationMs: 30, result: { rows: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], rowCount: 3 } },
    {
      kind: 'final', content: '128 orders shipped, approved by A, B, C.', model: 'gpt-4.1', provider: 'Azure OpenAI',
      usage: { promptTokens: 900, completionTokens: 120, totalTokens: 1020 }, turnLatencyMs: 2200, costUsd: 0.012,
      modelTier: 'standard', taskClass: 'general',
      phaseTimings: [{ phase: 'classify', ms: 8 }, { phase: 'llm', ms: 1800 }, { phase: 'tools', ms: 72 }],
      turnDetail: { tools: [{ name: 'warehouse_run_query', durationMs: 42, ok: true }, { name: 'graph_cypher_query', durationMs: 30, ok: true }] },
      citations: [{ id: 'doc1', path: 'orders/schema.md', kind: 'schema', heading: 'Orders table', preview: 'Orders(id, shipped, ...)' }],
      ...over,
    },
  ];
}

describe('assembleAnswerReceipt', () => {
  it('extracts the exact SQL + real row count from a real trace', () => {
    const trace = deriveTurnTraces(flatAnsweredSteps())[0];
    const r = assembleAnswerReceipt(trace as unknown as ReceiptTraceLike, { createdAt: CREATED });

    expect(r.prompt).toMatch(/how many orders shipped/);
    // Exact query text is preserved verbatim, dialect-tagged, with the row count.
    const sql = r.queries.find((q) => q.tool === 'warehouse_run_query')!;
    expect(sql.language).toBe('sql');
    expect(sql.text).toBe('SELECT COUNT(*) FROM Orders WHERE Shipped >= DATEADD(day,-7,GETDATE())');
    expect(sql.rowCount).toBe(1);
    expect(sql.ok).toBe(true);
    expect(sql.durationMs).toBe(42);
  });

  it('counts graph-query rows as graph paths and preserves Cypher text', () => {
    const trace = deriveTurnTraces(flatAnsweredSteps())[0];
    const r = assembleAnswerReceipt(trace as unknown as ReceiptTraceLike, { createdAt: CREATED });
    const cypher = r.queries.find((q) => q.language === 'cypher')!;
    expect(cypher.text).toMatch(/MATCH \(o:Order\)-\[:APPROVED_BY\]/);
    expect(cypher.rowCount).toBe(3);
    expect(r.graphPaths).toBe(3);
  });

  it('resolves DAX dialect from the tool name even when the query rides an sql arg', () => {
    const steps = [
      { kind: 'thought', content: 'User prompt: test the measure' },
      { kind: 'tool_call', name: 'dax_eval_probe', args: { sql: 'EVALUATE ROW("t", CALCULATE(SUM(Sales[Amt])))' }, callId: 'd1' },
      { kind: 'tool_result', name: 'dax_eval_probe', callId: 'd1', durationMs: 55, result: { rows: [{ t: 10 }], rowCount: 1, measure: 'Total Sales' } },
      { kind: 'final', content: 'ok', model: 'gpt-4.1', usage: { totalTokens: 50 } },
    ];
    const trace = deriveTurnTraces(steps)[0];
    const r = assembleAnswerReceipt(trace as unknown as ReceiptTraceLike, { createdAt: CREATED });
    const dax = r.queries[0];
    expect(dax.language).toBe('dax');
    expect(dax.text).toMatch(/^EVALUATE ROW/);
    // A measure surfaced by the tool result is captured as a metric used.
    expect(r.metrics).toContain('Total Sales');
  });

  it('carries tier, task class, token cost, sources and tools through', () => {
    const trace = deriveTurnTraces(flatAnsweredSteps())[0];
    const r = assembleAnswerReceipt(trace as unknown as ReceiptTraceLike, { createdAt: CREATED });
    expect(r.modelTier).toBe('standard');
    expect(r.taskClass).toBe('general');
    expect(r.tokens).toMatchObject({ prompt: 900, completion: 120, total: 1020 });
    expect(r.costUsd).toBe(0.012);
    expect(r.totalMs).toBe(2200);
    expect(r.sources).toEqual([
      { id: 'doc1', path: 'orders/schema.md', kind: 'schema', heading: 'Orders table', url: undefined },
    ]);
    expect(r.tools.map((t) => t.name)).toEqual(['warehouse_run_query', 'graph_cypher_query']);
    // Plan narration excludes the "User prompt:" seed.
    expect(r.planSteps).toEqual(['Plan: count shipped orders in the warehouse, then trace approvers in the graph.']);
  });

  it('badge is Unverified ⚠ by default (no verification signal on this branch)', () => {
    const trace = deriveTurnTraces(flatAnsweredSteps())[0];
    const r = assembleAnswerReceipt(trace as unknown as ReceiptTraceLike, { createdAt: CREATED });
    expect(r.verdict).toBe('unverified');
    expect(r.verified).toBe(false);
    expect(r.refused).toBe(false);
  });

  it('badge lights Verified ✓ when N9\'s verification signal is present on the final step', () => {
    const steps = flatAnsweredSteps({
      verification: { verdict: 'verified', verifiedAnswerId: 'va-42', method: 'verified-answers', score: 0.98 },
    });
    const trace = deriveTurnTraces(steps)[0];
    const r = assembleAnswerReceipt(trace as unknown as ReceiptTraceLike, { createdAt: CREATED });
    expect(r.verdict).toBe('verified');
    expect(r.verified).toBe(true);
    expect(r.verification).toMatchObject({ verdict: 'verified', verifiedAnswerId: 'va-42' });
  });

  it('an explicit verification option also lights Verified ✓ (client threads it off the turn)', () => {
    const trace = deriveTurnTraces(flatAnsweredSteps())[0];
    const r = assembleAnswerReceipt(trace as unknown as ReceiptTraceLike, {
      createdAt: CREATED,
      verification: { verdict: 'verified', method: 'query-replay' },
    });
    expect(r.verdict).toBe('verified');
  });

  it('badge is Refused ⛔ when the loop refused (content-safety error step)', () => {
    const steps = [
      { kind: 'thought', content: 'User prompt: do something disallowed' },
      { kind: 'error', error: 'Blocked by content safety: hate/high', code: 'content_safety_output' },
    ];
    const trace = deriveTurnTraces(steps)[0];
    const r = assembleAnswerReceipt(trace as unknown as ReceiptTraceLike, { createdAt: CREATED });
    expect(r.verdict).toBe('refused');
    expect(r.refused).toBe(true);
    expect(r.refusalReason).toMatch(/content safety/i);
  });

  it('a transient (non-refusal) error is NOT a refusal — stays Unverified', () => {
    const steps = [
      { kind: 'thought', content: 'User prompt: q' },
      { kind: 'error', error: 'AOAI 500 Internal Server Error' },
    ];
    const trace = deriveTurnTraces(steps)[0];
    const r = assembleAnswerReceipt(trace as unknown as ReceiptTraceLike, { createdAt: CREATED });
    expect(r.verdict).toBe('unverified');
    expect(r.refused).toBe(false);
  });

  it('surfaces a persisted receipt id when provided', () => {
    const trace = deriveTurnTraces(flatAnsweredSteps())[0];
    const r = assembleAnswerReceipt(trace as unknown as ReceiptTraceLike, { createdAt: CREATED, receiptId: 'rcpt-abc' });
    expect(r.id).toBe('rcpt-abc');
  });

  it('never throws on empty/garbage input', () => {
    expect(() => assembleAnswerReceipt({})).not.toThrow();
    const empty = assembleAnswerReceipt({ createdAt: CREATED } as ReceiptTraceLike);
    expect(empty.queries).toEqual([]);
    expect(empty.verdict).toBe('unverified');
    expect(empty.graphPaths).toBe(0);
  });
});
