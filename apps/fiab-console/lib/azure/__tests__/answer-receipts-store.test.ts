/**
 * N10 — answer-receipts-store: buildReceiptDoc + persistAnswerReceipt.
 *
 * buildReceiptDoc is pure — it stamps the MIG1 schemaVersion, the 90-day
 * governance TTL, the flattened queryable projections, and threads the doc id
 * back onto the embedded receipt. persistAnswerReceipt is asserted against a
 * fake Cosmos container (upsert) — no real Azure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/azure/cosmos-client', () => ({ answerReceiptsContainer: vi.fn() }));

import { buildReceiptDoc, persistAnswerReceipt } from '../answer-receipts-store';
import { ANSWER_RECEIPT_SCHEMA_VERSION, ANSWER_RECEIPT_TTL_SECONDS } from '../answer-receipts-model';
import { answerReceiptsContainer } from '@/lib/azure/cosmos-client';
import type { AnswerReceipt } from '@/lib/copilot/answer-receipt';

function receipt(over: Partial<AnswerReceipt> = {}): AnswerReceipt {
  return {
    prompt: 'p', planSteps: [], queries: [{ tool: 'warehouse_run_query', language: 'sql', text: 'SELECT 1', rowCount: 1, ok: true }],
    sources: [], graphPaths: 0, metrics: [], tools: [], phaseTimings: [], totalMs: 100,
    model: 'gpt-4.1', modelTier: 'standard', taskClass: 'general',
    tokens: { prompt: 10, completion: 5, total: 15 }, costUsd: 0.001,
    verdict: 'unverified', verified: false, refused: false,
    createdAt: '2026-07-23T00:00:00.000Z',
    ...over,
  };
}

describe('buildReceiptDoc', () => {
  it('stamps schemaVersion + 90-day TTL, flattens projections, and threads the id onto the receipt', () => {
    const doc = buildReceiptDoc(receipt(), { sessionId: 'sess-1', userOid: 'oid-1', tenantId: 'tid-1', surface: 'cross-item' }, 'rcpt-1');
    expect(doc.id).toBe('rcpt-1');
    expect(doc.sessionId).toBe('sess-1');
    expect(doc.schemaVersion).toBe(ANSWER_RECEIPT_SCHEMA_VERSION);
    expect(doc.ttl).toBe(ANSWER_RECEIPT_TTL_SECONDS);
    expect(doc.verdict).toBe('unverified');
    expect(doc.verified).toBe(false);
    expect(doc.model).toBe('gpt-4.1');
    expect(doc.modelTier).toBe('standard');
    expect(doc.costUsd).toBe(0.001);
    expect(doc.queryCount).toBe(1);
    // The embedded receipt carries its own persisted id.
    expect(doc.receipt.id).toBe('rcpt-1');
  });

  it('projects the verdict for a refused receipt', () => {
    const doc = buildReceiptDoc(receipt({ verdict: 'refused', refused: true }), { sessionId: 's', userOid: 'o' }, 'rcpt-2');
    expect(doc.verdict).toBe('refused');
    expect(doc.refused).toBe(true);
  });
});

describe('persistAnswerReceipt', () => {
  beforeEach(() => vi.mocked(answerReceiptsContainer).mockReset());

  it('upserts a wrapper doc and returns the receipt id', async () => {
    const upsert = vi.fn(async (d: unknown) => ({ resource: d }));
    vi.mocked(answerReceiptsContainer).mockResolvedValue({ items: { upsert } } as never);

    const id = await persistAnswerReceipt(receipt(), { sessionId: 'sess-9', userOid: 'oid-9' });
    expect(id).toMatch(/^rcpt-sess-9-/);
    expect(upsert).toHaveBeenCalledTimes(1);
    const written = upsert.mock.calls[0][0] as { id: string; sessionId: string; receipt: AnswerReceipt };
    expect(written.id).toBe(id);
    expect(written.sessionId).toBe('sess-9');
    expect(written.receipt.id).toBe(id);
  });
});
