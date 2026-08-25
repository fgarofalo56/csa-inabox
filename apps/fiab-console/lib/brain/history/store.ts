/**
 * LOOM BRAIN W9 — the STORE contract, and the in-memory implementation.
 *
 * Everything above this line in the history layer is pure. This module is the
 * seam: an interface narrow enough that the Cosmos implementation
 * (`./cosmos-store`) and the in-memory one below are interchangeable, and every
 * property the feature claims — dedupe, retention, fail-closed integrity — is
 * provable against the in-memory one with no Azure tenant.
 *
 * ── WHY THE INTERFACE SPLITS SUMMARIES FROM CONTENT ────────────────────────
 * `listSummaries` exists so that showing 50 versions does not load 50 graphs.
 * The Cosmos implementation projects the fields in the query; the in-memory one
 * strips them in code. If they were one method, the list endpoint would silently
 * pull megabytes per request and nobody would notice until the RU bill did.
 *
 * ── ORDERING IS PART OF THE CONTRACT ───────────────────────────────────────
 * Every list is CHRONOLOGICAL — oldest first, newest last. Stated on every
 * method, because "consecutive versions" and "prune the oldest" are both
 * ordering-sensitive and both fail catastrophically and quietly when the order
 * is reversed (the prune would delete the newest N).
 *
 * ── NO AZURE SDK HERE ──────────────────────────────────────────────────────
 * This module is pure. `./cosmos-store` is the ONLY module in this directory
 * permitted an Azure import, and `./__tests__/purity.test.ts` enforces that
 * with an embedded control.
 */

import type { GraphVersion, GraphVersionSummary } from './model';
import { DEFAULT_RETENTION_POLICY, type RetentionPolicy } from './retention';

/**
 * What the history layer needs from a persistence backend.
 *
 * Deliberately small. Nothing here filters, sorts by relevance or aggregates —
 * every query lives in `./queries` as a pure function over loaded versions, so
 * a backend cannot quietly change what a detector sees.
 */
export interface GraphHistoryStore {
  readonly policy: RetentionPolicy;
  /** Metadata for every retained version, CHRONOLOGICAL (oldest first). */
  listSummaries(estateId: string): Promise<readonly GraphVersionSummary[]>;
  /** The newest `n` versions with content, CHRONOLOGICAL (oldest first). */
  loadRecent(estateId: string, n: number): Promise<readonly GraphVersion[]>;
  /** One version with content, or `null` when this estate has no such id. */
  load(estateId: string, versionId: string): Promise<GraphVersion | null>;
  /** Write a new version. Implementations MUST write it atomically. */
  append(version: GraphVersion): Promise<void>;
  /** Delete one version. Used only by retention. */
  remove(estateId: string, versionId: string): Promise<void>;
  /**
   * Record that a capture produced an already-stored digest.
   *
   * The ONLY mutation of an existing version, and it touches only
   * `observedCount` / `lastObservedAt` — never the content, never `capturedAt`,
   * never the digest. A lost concurrent update UNDER-counts, which makes the
   * safe-prune predicate more conservative rather than less; that direction is
   * chosen deliberately, because the predicate's output is a deletion proposal.
   */
  observe(estateId: string, versionId: string, at: string): Promise<void>;
}

/** Strip the content from a version. The one place that projection is defined. */
export function toSummary(v: GraphVersion): GraphVersionSummary {
  return {
    id: v.id,
    estateId: v.estateId,
    capturedAt: v.capturedAt,
    formatVersion: v.formatVersion,
    digest: v.digest,
    counts: v.counts,
    collectedProvenances: v.collectedProvenances,
    source: v.source,
    observedCount: v.observedCount,
    lastObservedAt: v.lastObservedAt,
  };
}

function chronological(a: GraphVersion, b: GraphVersion): number {
  if (a.capturedAt < b.capturedAt) return -1;
  if (a.capturedAt > b.capturedAt) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * An in-memory store.
 *
 * NOT a mock. It is the real implementation of the same contract, and it is what
 * every property test in this directory runs against — dedupe, retention
 * bounds, fail-closed integrity and the consecutive-version predicate are
 * properties of the ALGORITHM, not of Cosmos, and proving them here means they
 * are proven without a tenant and without an emulator.
 *
 * It is also usable for real: a single-replica dev console gets a working
 * history with no Cosmos endpoint. It is not durable, and it says so.
 */
export class InMemoryGraphHistoryStore implements GraphHistoryStore {
  readonly policy: RetentionPolicy;
  private readonly byEstate = new Map<string, GraphVersion[]>();

  constructor(policy: RetentionPolicy = DEFAULT_RETENTION_POLICY) {
    this.policy = policy;
  }

  private bucket(estateId: string): GraphVersion[] {
    const existing = this.byEstate.get(estateId);
    if (existing) return existing;
    const created: GraphVersion[] = [];
    this.byEstate.set(estateId, created);
    return created;
  }

  async listSummaries(estateId: string): Promise<readonly GraphVersionSummary[]> {
    return [...this.bucket(estateId)].sort(chronological).map(toSummary);
  }

  async loadRecent(estateId: string, n: number): Promise<readonly GraphVersion[]> {
    if (n < 0) throw new RangeError(`loadRecent: n must be >= 0 (got ${n}).`);
    const all = [...this.bucket(estateId)].sort(chronological);
    return n === 0 ? [] : all.slice(Math.max(0, all.length - n));
  }

  async load(estateId: string, versionId: string): Promise<GraphVersion | null> {
    return this.bucket(estateId).find((v) => v.id === versionId) ?? null;
  }

  async append(version: GraphVersion): Promise<void> {
    const bucket = this.bucket(version.estateId);
    if (bucket.some((v) => v.id === version.id)) {
      // Same id means same instant AND same content digest prefix. Silently
      // overwriting would lose whichever version was already there; the caller
      // deduped on digest before getting here, so this is a real collision.
      throw new Error(
        `a version with id '${version.id}' already exists for estate '${version.estateId}'. ` +
          'Refusing to overwrite: a version is immutable once written.',
      );
    }
    bucket.push(version);
  }

  async remove(estateId: string, versionId: string): Promise<void> {
    const bucket = this.bucket(estateId);
    const at = bucket.findIndex((v) => v.id === versionId);
    if (at >= 0) bucket.splice(at, 1);
  }

  async observe(estateId: string, versionId: string, at: string): Promise<void> {
    const bucket = this.bucket(estateId);
    const idx = bucket.findIndex((v) => v.id === versionId);
    if (idx < 0) return;
    const current = bucket[idx];
    // Content, capturedAt and digest are carried over UNTOUCHED. Only the two
    // observation fields move.
    bucket[idx] = { ...current, observedCount: current.observedCount + 1, lastObservedAt: at };
  }
}
