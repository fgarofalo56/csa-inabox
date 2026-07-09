/**
 * PREDICT batch-scoring — run-history model (FGC-18).
 *
 * Pure, side-effect-free helpers for the persisted run history of ML-model
 * batch-scoring jobs. The predict POST route records one entry per submission
 * on the Cosmos item (`state.predictHistory`), and the status poller marks it
 * terminal on completion. This module holds the shapes + the merge/sort logic so
 * both routes stay consistent and the logic is unit-testable in isolation.
 *
 * "Run history persisted" is the FGC-18 acceptance criterion — this makes the
 * persisted history real, sortable, and surfaced in the PredictWizard.
 */

export type PredictRunStatus = 'submitted' | 'running' | 'succeeded' | 'failed';

export interface PredictHistoryEntry {
  /** The runId returned to the client at submit time (stable key for this run). */
  runId: string;
  backend: 'aml' | 'synapse';
  /** Model version scored. */
  version: string;
  /** Input Delta path / table reference. */
  inputRef: string;
  /** Output (scored) Delta path / table reference. */
  outputRef: string;
  /** Number of model input features mapped. */
  featureCount: number;
  /** ISO timestamp when the job was submitted. */
  startedAt: string;
  /** ISO timestamp when the job reached a terminal state (set by the poller). */
  finishedAt?: string;
  status: PredictRunStatus;
  /** Rows scored (set on success when the receipt reports it). */
  rows?: number | null;
  /** Short error text (set on failure). */
  error?: string;
}

/** Cap on retained history entries (newest kept) to bound the item document. */
export const MAX_PREDICT_HISTORY = 25;

/** A predictHistory map as stored on the item (keyed by runId). */
export type PredictHistoryMap = Record<string, PredictHistoryEntry>;

/**
 * Property names that must never be used as a write target — assigning to any
 * of these mutates an object's prototype chain (prototype pollution) rather
 * than storing a run. runIds come from client-supplied job submissions, so a
 * crafted `__proto__` / `constructor` / `prototype` runId is untrusted input.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** True when `key` is safe to use as a run-history property name. */
function isSafeHistoryKey(key: string): boolean {
  return !FORBIDDEN_KEYS.has(key);
}

/**
 * Insert / replace a history entry, then prune to the newest MAX_PREDICT_HISTORY
 * by startedAt. Returns a NEW map (never mutates the input).
 */
export function upsertPredictHistory(
  existing: PredictHistoryMap | undefined,
  entry: PredictHistoryEntry,
): PredictHistoryMap {
  const next: PredictHistoryMap = { ...(existing || {}) };
  // Never let a crafted runId (`__proto__` etc.) write to a prototype slot.
  if (!isSafeHistoryKey(entry.runId)) return next;
  next[entry.runId] = entry;
  return pruneHistory(next);
}

/** Prune a history map to the newest MAX_PREDICT_HISTORY entries by startedAt. */
export function pruneHistory(map: PredictHistoryMap): PredictHistoryMap {
  const sorted = sortHistory(map);
  if (sorted.length <= MAX_PREDICT_HISTORY) return map;
  const keep = sorted.slice(0, MAX_PREDICT_HISTORY);
  const out: PredictHistoryMap = {};
  for (const e of keep) out[e.runId] = e;
  return out;
}

/**
 * Apply a terminal-status patch to the entry whose runId is `runId` OR whose
 * runId is a prefix of `runId` (Synapse appends `:<stmtId>` to the base runId
 * across poll phases, so the poller's runId is `base:stmt` while history is keyed
 * by `base`). Returns a NEW map; a no-match is a no-op returning the input.
 */
export function applyHistoryStatus(
  existing: PredictHistoryMap | undefined,
  runId: string,
  patch: Partial<Pick<PredictHistoryEntry, 'status' | 'rows' | 'error' | 'finishedAt' | 'outputRef'>>,
): PredictHistoryMap {
  const map = existing || {};
  const key = matchHistoryKey(map, runId);
  // `key` is null unless it is a safe, own property of `map` (matchHistoryKey
  // enforces both), so this write can never target a prototype-chain slot.
  if (!key || !isSafeHistoryKey(key)) return map;
  const next: PredictHistoryMap = { ...map };
  next[key] = { ...map[key], ...patch };
  return next;
}

/** Find the history key matching a poller runId (exact, or a prefix match). */
export function matchHistoryKey(map: PredictHistoryMap, runId: string): string | null {
  // Exact match: use hasOwnProperty (not truthiness) so an inherited slot such
  // as `__proto__` / `constructor` never reads as a "hit", and reject forbidden
  // keys outright — the returned key is later used as a write target.
  if (isSafeHistoryKey(runId) && Object.prototype.hasOwnProperty.call(map, runId)) return runId;
  // Longest prefix match — `synapse-spark:pool:session` is a prefix of
  // `synapse-spark:pool:session:stmt`. Object.keys yields only safe own keys.
  let best: string | null = null;
  for (const k of Object.keys(map)) {
    if (!isSafeHistoryKey(k)) continue;
    if (runId.startsWith(`${k}:`) && (best === null || k.length > best.length)) best = k;
  }
  return best;
}

/** Sort a history map to an array, newest submission first. */
export function sortHistory(map: PredictHistoryMap | undefined): PredictHistoryEntry[] {
  return Object.values(map || {}).sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}
