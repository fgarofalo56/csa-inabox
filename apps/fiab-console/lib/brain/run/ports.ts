/**
 * LOOM BRAIN W10 — the PORTS the scan runs against, and their in-memory
 * implementations (#3936).
 *
 * PURE. Every side effect the scheduler has is behind one of the four
 * interfaces below, which is what makes `runBrainScan()` provable end-to-end
 * with fixtures and no Azure tenant. The production implementations live in
 * `./azure/*` and `./cosmos-finding-store.ts`, and they are the ONLY modules in
 * this directory permitted an Azure import; `./__tests__/purity.test.ts`
 * enforces that with an embedded control.
 *
 * ── THE IN-MEMORY IMPLEMENTATIONS ARE NOT MOCKS ────────────────────────────
 * They are real implementations of the same contracts. Dedupe, lifecycle
 * transitions, blind-detector handling and fail-closed behaviour are properties
 * of the ALGORITHM, not of Cosmos or of ARM, so proving them here proves them
 * without a tenant and without an emulator.
 */

import type { BrainGraphView, EdgeProvenance } from '../types';
import type { FindingRecord, ProbeResult, ScanRunRecord } from './model';

// ---------------------------------------------------------------------------
// §The estate probe — discovery + ARM power state
// ---------------------------------------------------------------------------

/**
 * Establishes WHAT exists and WHETHER it is running.
 *
 * Two reads on purpose, and they must not be collapsed. Resource Graph is the
 * right tool for DISCOVERY (what exists) and the WRONG tool for STATE (what is
 * serving) — measured 2026-08-22, a Synapse pool whose pause had already
 * succeeded kept reporting `Online` through ARG. So the implementation
 * discovers via ARG and then reads power state with a direct ARM GET per
 * resource, which is the only way to produce an `ArmPowerReading`.
 *
 * MUST NOT THROW for a reachability failure: a failure is DATA
 * ({@link ProbeResult.failures}) so the classifier can name it. An unexpected
 * defect may still throw, and should.
 */
export interface EstateProbe {
  probe(): Promise<ProbeResult>;
}

// ---------------------------------------------------------------------------
// §The graph source
// ---------------------------------------------------------------------------

export interface GraphSourceResult {
  readonly graph: BrainGraphView;
  /**
   * The provenances this runtime actually COLLECTED.
   *
   * REQUIRED, and not derivable from the graph: an edge count of zero cannot
   * distinguish "the extractor ran and found none" from "the extractor is not
   * present in this build". W9's history layer diffs only the provenances both
   * versions collected, and getting this wrong reports a whole provenance as
   * added or removed on the next capture.
   */
  readonly collectedProvenances: readonly EdgeProvenance[];
  /** Anything the source ESTABLISHED about its own limits. */
  readonly notes: readonly string[];
}

/** Builds the graph the detectors and the history capture both range over. */
export interface GraphSource {
  build(): Promise<GraphSourceResult>;
}

/** Wraps an already-built graph. Used by tests and by any in-process caller. */
export class StaticGraphSource implements GraphSource {
  constructor(
    private readonly graph: BrainGraphView,
    private readonly collectedProvenances: readonly EdgeProvenance[],
    private readonly notes: readonly string[] = [],
  ) {}

  async build(): Promise<GraphSourceResult> {
    return {
      graph: this.graph,
      collectedProvenances: this.collectedProvenances,
      notes: this.notes,
    };
  }
}

// ---------------------------------------------------------------------------
// §The graph history writer — W9's seam
// ---------------------------------------------------------------------------

/**
 * What a capture established. Mirrors W9's `CaptureResult` (#3935) exactly
 * enough for this lane to report it, and no more.
 */
export interface GraphVersionReceipt {
  /** `unchanged` means the graph did not SEMANTICALLY change — not a failure. */
  readonly status: 'created' | 'unchanged';
  readonly versionId: string;
  readonly nodes: number;
  readonly edges: number;
  /** Version ids retention deleted as part of this write. */
  readonly pruned: readonly string[];
  readonly notes: readonly string[];
}

export interface CaptureRequest {
  readonly graph: BrainGraphView;
  readonly estateId: string;
  readonly collectedProvenances: readonly EdgeProvenance[];
  /** What triggered the capture, e.g. 'workflow:loom-brain-scan'. */
  readonly source: string;
}

/**
 * Writes a graph version.
 *
 * A PORT rather than a direct import of `../history` because W9 (#3935) is in
 * flight on its own branch as this lane is written; the adapter in
 * `./azure/history-writer.ts` binds the two and is the ONLY place that names
 * W9's module. There is deliberately NO null implementation: a scan that could
 * not write a version FAILS, because a run that reports findings with no
 * `before` cannot ever say "an edge that should not have formed".
 */
export interface GraphHistoryWriter {
  capture(req: CaptureRequest): Promise<GraphVersionReceipt>;
}

/** An in-memory writer that records what it was asked to capture. */
export class InMemoryGraphHistoryWriter implements GraphHistoryWriter {
  readonly captures: CaptureRequest[] = [];
  private seq = 0;

  async capture(req: CaptureRequest): Promise<GraphVersionReceipt> {
    this.captures.push(req);
    this.seq += 1;
    return {
      status: 'created',
      versionId: `v${this.seq}`,
      nodes: req.graph.nodes.length,
      edges: req.graph.edges.length,
      pruned: [],
      notes: ['in-memory history writer — nothing was persisted.'],
    };
  }
}

// ---------------------------------------------------------------------------
// §The finding store
// ---------------------------------------------------------------------------

/**
 * Persistence for the backlog.
 *
 * Deliberately small, and deliberately NOT filtered: `list` returns EVERY
 * record for the estate, including `fixed` ones. A store that helpfully hid
 * fixed findings would make the next recurrence look like a brand-new finding,
 * which is P-REG defeated at the persistence layer rather than in the
 * lifecycle — the same bug, one layer down, where no type can catch it.
 */
export interface FindingStore {
  list(estateId: string): Promise<readonly FindingRecord[]>;
  /** Upsert. Implementations MUST preserve `fixed` records. */
  put(records: readonly FindingRecord[]): Promise<void>;
  recordRun(run: ScanRunRecord): Promise<void>;
  /**
   * The most recent run for this estate, WHATEVER its verdict.
   *
   * Used for operator-facing "when did this lane last run at all?" questions.
   * It is deliberately NOT the population basis — see {@link lastScannedRun}.
   */
  lastRun(estateId: string): Promise<ScanRunRecord | null>;
  /**
   * The most recent run that actually SCANNED — i.e. whose
   * `detectorPopulations` is non-null. `null` when there has never been one.
   *
   * THIS IS THE POPULATION BASIS, and the distinction is a blocker-grade one
   * (review of #4014). PAUSED and UNREACHABLE runs persist a null population, so
   * taking the basis from `lastRun` means ONE PAUSED NIGHT ERASES THE BASELINE:
   * measured `OK -> PAUSED -> went-blind OK` gave `populationRegression: null,
   * exit 0`, where the same sequence without the paused night gave exit 3.
   *
   * Under the standing estate-pause mandate that is not an edge case — PAUSED is
   * the NORMAL operating mode — so the P0 comparator this lane exists to provide
   * would have been switched off almost always.
   *
   * `null` is NO BASIS, not "no regression". The caller renders that distinction
   * rather than hiding it behind a green tick.
   */
  lastScannedRun(estateId: string): Promise<ScanRunRecord | null>;
  /**
   * How many runs back {@link lastScannedRun} is, counting itself as 1.
   *
   * `0` means NO scanned run was found inside the implementation's window — it
   * never means "one run ago". Both implementations agree on that (review of
   * #4014, N5: they did not, and the S5 staleness axis reads this on the PAUSED
   * path, which is precisely the case where they differed). The authoritative
   * "has anything EVER scanned?" is {@link lastScannedRun}, whose filter is in
   * the query and is therefore unbounded.
   *
   * Reported so an operator reading a comparison against a basis eleven nights
   * old is told so, rather than left to assume it was last night's.
   */
  scannedRunAgeRuns(estateId: string): Promise<number>;
}

/** An in-memory store. A real implementation of the contract, not a stub. */
export class InMemoryFindingStore implements FindingStore {
  private readonly byEstate = new Map<string, Map<string, FindingRecord>>();
  readonly runs: ScanRunRecord[] = [];

  private bucket(estateId: string): Map<string, FindingRecord> {
    const existing = this.byEstate.get(estateId);
    if (existing) return existing;
    const created = new Map<string, FindingRecord>();
    this.byEstate.set(estateId, created);
    return created;
  }

  async list(estateId: string): Promise<readonly FindingRecord[]> {
    return [...this.bucket(estateId).values()];
  }

  async put(records: readonly FindingRecord[]): Promise<void> {
    for (const r of records) this.bucket(r.estateId).set(r.fingerprint, r);
  }

  async recordRun(run: ScanRunRecord): Promise<void> {
    this.runs.push(run);
  }

  async lastRun(estateId: string): Promise<ScanRunRecord | null> {
    for (let i = this.runs.length - 1; i >= 0; i -= 1) {
      if (this.runs[i].estateId === estateId) return this.runs[i];
    }
    return null;
  }

  // `!= null` — LOOSE, and deliberately (#4120). `detectorPopulations` is
  // `T | null`: null is a value the PAUSED and UNREACHABLE paths write, absent
  // is not. A strict `!== null` treats an ABSENT field as a scanned population,
  // so a record whose key never made it through a migration is handed to
  // `detectPopulationRegression`, whose own `=== null` guard also passes, and
  // `.map` of `undefined` throws. The Cosmos store now rejects such a document
  // on read; this implementation is fed by tests and callers directly, so it
  // hardens the same edge rather than assuming the store is the only source.
  async lastScannedRun(estateId: string): Promise<ScanRunRecord | null> {
    for (let i = this.runs.length - 1; i >= 0; i -= 1) {
      const r = this.runs[i];
      if (r.estateId === estateId && r.detectorPopulations != null) return r;
    }
    return null;
  }

  async scannedRunAgeRuns(estateId: string): Promise<number> {
    let age = 0;
    for (let i = this.runs.length - 1; i >= 0; i -= 1) {
      const r = this.runs[i];
      if (r.estateId !== estateId) continue;
      age += 1;
      if (r.detectorPopulations != null) return age;
    }
    return 0;
  }
}

/** Seed an in-memory store. Test-facing convenience over `put`. */
export async function seedFindings(
  store: FindingStore,
  records: readonly FindingRecord[],
): Promise<void> {
  await store.put(records);
}
