/**
 * answer-receipts-store — read/write helpers for the loom-answer-receipts
 * container (N10). Split from `answer-receipts-model.ts` (pure shape + migrator)
 * so the model can be imported for its side effect by cosmos-client without a
 * cycle; the helpers here import the container getter from cosmos-client.
 *
 * Real Cosmos reads/writes only (no mock). Persistence is best-effort at the
 * call site: a receipt hiccup must never block or fail an answer.
 */

import { answerReceiptsContainer } from './cosmos-client';
import {
  ANSWER_RECEIPT_SCHEMA_VERSION,
  ANSWER_RECEIPT_TTL_SECONDS,
  type AnswerReceiptDoc,
} from './answer-receipts-model';
import type { AnswerReceipt } from '@/lib/copilot/answer-receipt';

/** Context needed to persist a receipt. */
export interface PersistReceiptContext {
  sessionId: string;
  userOid: string;
  tenantId?: string | null;
  surface?: string;
}

/** Stable, collision-resistant receipt id (surfaced inside the receipt). */
export function newReceiptId(sessionId: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `rcpt-${sessionId}-${Date.now()}-${rand}`;
}

/** Build the persisted wrapper doc for an assembled receipt (pure — testable). */
export function buildReceiptDoc(receipt: AnswerReceipt, ctx: PersistReceiptContext, id: string): AnswerReceiptDoc {
  const withId: AnswerReceipt = { ...receipt, id };
  return {
    id,
    sessionId: ctx.sessionId,
    schemaVersion: ANSWER_RECEIPT_SCHEMA_VERSION,
    userOid: ctx.userOid,
    tenantId: ctx.tenantId ?? undefined,
    surface: ctx.surface,
    createdAt: withId.createdAt,
    ttl: ANSWER_RECEIPT_TTL_SECONDS,
    verdict: withId.verdict,
    verified: withId.verified,
    refused: withId.refused,
    model: withId.model,
    modelTier: withId.modelTier,
    costUsd: withId.costUsd,
    queryCount: withId.queries.length,
    receipt: withId,
  };
}

/**
 * Persist one assembled receipt and return its doc id. The id is stamped BACK
 * onto the embedded `receipt.id` so a reader always sees the receipt's own
 * persisted id. Real Cosmos upsert (no mock).
 */
export async function persistAnswerReceipt(receipt: AnswerReceipt, ctx: PersistReceiptContext): Promise<string> {
  const id = newReceiptId(ctx.sessionId);
  const doc = buildReceiptDoc(receipt, ctx, id);
  const container = await answerReceiptsContainer();
  await container.items.upsert(doc);
  return id;
}

/** List a session's persisted receipts (single-partition), newest first. */
export async function listAnswerReceipts(sessionId: string): Promise<AnswerReceiptDoc[]> {
  const container = await answerReceiptsContainer();
  const { resources } = await container.items
    .query<AnswerReceiptDoc>({
      query: 'SELECT * FROM c WHERE c.sessionId = @s ORDER BY c.createdAt DESC',
      parameters: [{ name: '@s', value: sessionId }],
    })
    .fetchAll();
  return resources;
}
