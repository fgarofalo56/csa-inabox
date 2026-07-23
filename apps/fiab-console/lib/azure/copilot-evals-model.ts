/**
 * loom-copilot-evals — doc shapes + MIG1 versioned-migration registration (E2).
 *
 * The copilot-evaluator Function (azure-functions/copilot-evaluator) WRITES
 * these docs; the console (E5 /admin/copilot-quality) READS them through
 * `copilotEvalsContainer()` (cosmos-client), which wraps the container in
 * `withMigrations('loom-copilot-evals', …)` so every materialized doc passes
 * `migrateOnRead` — the MIG1 convention (lib/azure/cosmos-migrations.ts).
 *
 * CURRENT SCHEMA VERSION: 1 (every doc is stamped `schemaVersion: 1` at write).
 * A future breaking shape change bumps COPILOT_EVALS_SCHEMA_VERSION to N+1 and
 * registers its `fromVersion: N` migrator in
 * {@link registerCopilotEvalsMigrators} below (called at module scope — the
 * chain is live before any read materializes). Per MIG1 there is deliberately
 * NO v1 migrator today: registering an inert one would violate the
 * one-owner-per-step rule the first REAL migration needs.
 */
import { registerMigrator, type DocMigrator } from './cosmos-migrations';

export const COPILOT_EVALS_CONTAINER = 'loom-copilot-evals';
export const COPILOT_EVALS_SCHEMA_VERSION = 1;

/** Per-surface run rollup (retained indefinitely). */
export interface CopilotEvalRunDoc {
  id: string;
  /** PK — the Copilot surface ('help', 'lakehouse', …; '#ledger' for the judge ledger). */
  surface: string;
  runId: string;
  docType: 'eval-run';
  schemaVersion: number;
  corpusCommit: string;
  startedAt: string;
  finishedAt: string;
  /** The judge DEPLOYMENT name that scored the run ('none' = retrieval-only). */
  judgeModel: string;
  trigger: 'corpus' | 'nightly' | 'manual';
  totals: {
    questions: number;
    retrievalHitRate: number;
    mrrAvg: number;
    groundingAvg: number | null;
    answerAvg: number | null;
    passRate: number;
    judged: number;
    deferred: number;
    autoFailed: number;
  };
}

/** One scored question (ttl 180d — self-evicting per the E2 data model). */
export interface CopilotEvalResultDoc {
  id: string;
  surface: string;
  runId: string;
  docType: 'eval-result';
  schemaVersion: number;
  questionId: string;
  question: string;
  expectedChunks: string[];
  retrievedChunks: string[];
  retrievalHit: boolean;
  mrr: number;
  mentionPass: boolean;
  forbiddenHit: boolean;
  /** 'deferred' = daily judge cap reached (E3 treats deferred as no-change). */
  judgeStatus: 'scored' | 'deferred' | 'auto-fail' | 'error';
  judge?: { grounding: number; relevance: number; completeness: number; rationale: string };
  pass: boolean;
  answer: string;
  tier: string;
  latencyMs: number;
  backend?: string;
  ttl?: number;
}

/** SRCH1 — per-domain federated-search relevance run rollup (retained). PK 'search:<domain>'. */
export interface CopilotSearchRunDoc {
  id: string;
  surface: string; // 'search:<domain>'
  domain: string;
  runId: string;
  docType: 'search-run';
  schemaVersion: number;
  startedAt: string;
  finishedAt: string;
  trigger: 'corpus' | 'nightly' | 'manual';
  k: number;
  totals: { queries: number; hitRate: number; mrrAvg: number; ndcgAvg: number };
}

/** SRCH1 — one scored federated-search query (ttl 180d). */
export interface CopilotSearchResultDoc {
  id: string;
  surface: string; // 'search:<domain>'
  domain: string;
  runId: string;
  docType: 'search-result';
  schemaVersion: number;
  queryId: string;
  query: string;
  expectedResults: string[];
  retrieved: string[];
  hit: boolean;
  mrr: number;
  ndcg: number;
  matched: number;
  k: number;
  backend?: string;
  latencyMs: number;
  ttl?: number;
}

/** Daily judge-spend ledger (ttl 7d) — cross-replica daily-cap enforcement. */
export interface CopilotEvalJudgeLedgerDoc {
  id: string;
  surface: '#ledger';
  docType: 'judge-ledger';
  schemaVersion: number;
  day: string;
  count: number;
  ttl?: number;
}

/**
 * MIG1 registration point for this container's migrator chain. v1 is current —
 * the chain is empty. The FIRST breaking change adds:
 *
 *   const v1toV2: DocMigrator = (doc) => ({ ...doc, …, schemaVersion: 2 });
 *   registerMigrator(COPILOT_EVALS_CONTAINER, 1, v1toV2);
 *
 * plus the optional backfill script
 * `scripts/csa-loom/cosmos-backfill-loom-copilot-evals.mjs`.
 */
export function registerCopilotEvalsMigrators(): void {
  // v1 → (none yet). The registerMigrator reference keeps the wiring live for
  // the first real migration without registering an inert step (an inert
  // migrator would claim the one-owner-per-step v1 slot).
  const register: (containerId: string, fromVersion: number, migrate: DocMigrator) => void = registerMigrator;
  void register;
}

registerCopilotEvalsMigrators();
