/**
 * loom-answer-receipts — persisted Answer-Receipt doc shape + MIG1 migrator
 * registration (N10).
 *
 * The Copilot orchestrator ASSEMBLES an {@link AnswerReceipt} for every agentic
 * answer (lib/copilot/answer-receipt.ts) and persists it here as the governance
 * audit trail: the exact SQL/KQL/Cypher executed, row counts, grounding sources,
 * model tier, token cost, and the Verified/Unverified/Refused verdict. The
 * console (ReceiptPanel in the Copilot dock) renders the same assembled receipt
 * live; this container is the durable, TTL'd record a CDO/ISSO reviews later —
 * and, in an IL5 / air-gapped boundary, IS the compliance artifact.
 *
 * PK /sessionId so "every receipt for this conversation" is a single-partition
 * read and each receipt is a point-read by (id, sessionId). TTL-enabled with a
 * default 90-day window (each doc carries its own `ttl`) so the trail self-evicts
 * and never grows unbounded — the container's defaultTtl: -1 turns TTL ON without
 * imposing a blanket expiry on any doc that omits `ttl`.
 *
 * CURRENT SCHEMA VERSION: 1 (every doc is stamped `schemaVersion: 1` at write).
 * A future breaking shape change bumps ANSWER_RECEIPT_SCHEMA_VERSION to N+1 and
 * registers its `fromVersion: N` migrator in
 * {@link registerAnswerReceiptMigrators} (called at module scope — the chain is
 * live before any read materializes). Per MIG1 there is deliberately NO v1
 * migrator today: registering an inert one would claim the one-owner-per-step v1
 * slot the first REAL migration needs.
 *
 * This module is pure shape + migrator registration (no cosmos-client import) so
 * it is safe to import for its side effect from cosmos-client without a cycle.
 * The real read/write helpers live in `answer-receipts-store.ts`.
 */

import { registerMigrator, type DocMigrator } from './cosmos-migrations';
import type { AnswerReceipt } from '@/lib/copilot/answer-receipt';

export const ANSWER_RECEIPTS_CONTAINER = 'loom-answer-receipts';
export const ANSWER_RECEIPT_SCHEMA_VERSION = 1;
/** Governance-audit retention window for a persisted receipt (90 days, seconds). */
export const ANSWER_RECEIPT_TTL_SECONDS = 90 * 24 * 3600;

/** The persisted wrapper around one assembled {@link AnswerReceipt}. */
export interface AnswerReceiptDoc {
  /** Unique receipt id (also surfaced inside `receipt.id`). */
  id: string;
  /** PK — the Copilot session the answer belongs to. */
  sessionId: string;
  schemaVersion: number;
  /** Who asked (Entra oid). */
  userOid: string;
  /** Caller's tenant, when known. */
  tenantId?: string;
  /** The Copilot surface/persona tag ('cross-item', 'warehouse', …). */
  surface?: string;
  createdAt: string;
  /** Self-eviction window (seconds) — the governance retention TTL. */
  ttl: number;
  // ── Flattened, queryable projections of the embedded receipt ──────────────
  verdict: AnswerReceipt['verdict'];
  verified: boolean;
  refused: boolean;
  model?: string;
  modelTier?: string;
  costUsd?: number;
  queryCount: number;
  // ── The full assembled receipt (the audit payload) ────────────────────────
  receipt: AnswerReceipt;
}

/**
 * MIG1 registration point for this container's migrator chain. v1 is current —
 * the chain is empty. The FIRST breaking change adds:
 *
 *   const v1toV2: DocMigrator = (doc) => ({ ...doc, …, schemaVersion: 2 });
 *   registerMigrator(ANSWER_RECEIPTS_CONTAINER, 1, v1toV2);
 *
 * plus the optional backfill script
 * `scripts/csa-loom/cosmos-backfill-loom-answer-receipts.mjs`.
 */
export function registerAnswerReceiptMigrators(): void {
  // v1 → (none yet). The registerMigrator reference keeps the wiring live for
  // the first real migration without registering an inert step (an inert
  // migrator would claim the one-owner-per-step v1 slot).
  const register: (containerId: string, fromVersion: number, migrate: DocMigrator) => void = registerMigrator;
  void register;
}

registerAnswerReceiptMigrators();
