/**
 * LOOM BRAIN W10 — shared fixtures for the scheduler suites (#3936).
 *
 * ── EVERY FIXTURE CARRIES A CONTROL ────────────────────────────────────────
 * The estate graph is imported from the DETECTOR fixtures rather than rebuilt
 * here. A suite that constructs its subject differently from the one the
 * detectors are proven against is testing its own constructor: the scheduler
 * would be shown reconciling findings that no shipped detector actually
 * produces, and a detector change would not move a single assertion in this
 * directory.
 *
 * ── PUBLIC REPO ────────────────────────────────────────────────────────────
 * Every id here is synthetic and comes from the detector fixtures' obviously-fake
 * placeholders. `./no-real-ids.test.ts` scans this whole directory for
 * GUID-shaped literals and fails on one that is not the placeholder.
 */

import { armPowerReading, type ArmPowerReading, type EstatePowerState } from '../../../estate/pause-state';
import {
  FINDING_SCHEMA_VERSION,
  type FindingFingerprint,
  type FindingRecord,
  type ProbeFailure,
  type ProbeResult,
} from '../model';
import type { EstateProbe } from '../ports';
import {
  makePopulation,
  proposal,
  type BrainGraphView,
  type Finding,
  type NodeId,
  type Population,
} from '../../graph';

export const ESTATE = 'loom-example-estate';
export const CLOUD = 'AzureCloud';
export const ARM_API = '2024-03-01';

/** The synthetic ARM ids the detector fixtures use. Re-exported for readability. */
export {
  BROKER_ARM,
  BROKER_ID,
  CONSOLE_ARM,
  CONSOLE_ID,
  DIRECTLAKE_ARM,
  DIRECTLAKE_ID,
  buildEdgelessGraph,
  buildEstateScaleGraph,
  buildFixtureGraph,
} from '../../__tests__/detectors/fixtures';

import { BROKER_ARM, CONSOLE_ARM, DIRECTLAKE_ARM } from '../../__tests__/detectors/fixtures';

/** A branded ARM power reading. The ONLY way a PAUSED verdict can be produced. */
export function reading(resourceId: string, powerState: EstatePowerState): ArmPowerReading {
  return armPowerReading({
    resourceId,
    powerState,
    armApiVersion: ARM_API,
    readAt: '2026-08-24T04:11:00.000Z',
  });
}

/** Three apps, all Online — the running estate. */
export function runningReadings(): readonly ArmPowerReading[] {
  return [
    reading(CONSOLE_ARM, 'Online'),
    reading(BROKER_ARM, 'Online'),
    reading(DIRECTLAKE_ARM, 'Online'),
  ];
}

/** Three apps, every one definitively stopped — the PAUSED estate. */
export function pausedReadings(): readonly ArmPowerReading[] {
  return [
    reading(CONSOLE_ARM, 'Stopped'),
    reading(BROKER_ARM, 'Stopped'),
    reading(DIRECTLAKE_ARM, 'Deallocated'),
  ];
}

export function probeOf(
  readings: readonly ArmPowerReading[],
  failures: readonly ProbeFailure[] = [],
): ProbeResult {
  return {
    readings,
    failures,
    discovered: readings.length,
    scope: `${readings.length} Loom container app(s) in 1 subscription (synthetic fixture)`,
  };
}

/** A probe that returns a fixed result. */
export class StubProbe implements EstateProbe {
  calls = 0;
  constructor(private readonly result: ProbeResult) {}
  async probe(): Promise<ProbeResult> {
    this.calls += 1;
    return this.result;
  }
}

export const AUTH_FAILURE: ProbeFailure = {
  stage: 'discovery',
  target: 'Microsoft.ResourceGraph/resources',
  classification: 'auth',
  httpStatus: 403,
  detail: "AuthorizationFailed: the run identity has no Reader on the target subscription(s).",
};

export const NETWORK_FAILURE: ProbeFailure = {
  stage: 'discovery',
  target: 'Microsoft.ResourceGraph/resources',
  classification: 'network',
  httpStatus: null,
  detail: 'fetch failed: getaddrinfo ENOTFOUND (no HTTP exchange completed)',
};

// ---------------------------------------------------------------------------
// Findings and records
// ---------------------------------------------------------------------------

const POPULATION: Population = makePopulation({
  subject: 'nodes',
  nodes: [],
  edges: [],
  scope: 'synthetic fixture population',
});

/** A population that is NOT blind — one node examined. */
export function nonBlindPopulation(scope = 'synthetic non-blind population'): Population {
  return {
    subject: 'nodes',
    examined: 3,
    edgesExamined: 2,
    scope,
    blind: false,
    byProvenance: { declared: 1, configured: 1, imports: 0, observed: 0, owns: 0 },
  };
}

/** A synthetic finding with a deterministic id, in the detector-kit shape. */
export function finding(args: {
  detector: string;
  subject: string;
  title?: string;
  severity?: Finding['severity'];
}): Finding {
  return {
    id: `${args.detector}#${args.subject}`,
    detector: args.detector,
    severity: args.severity ?? 'high',
    title: args.title ?? `${args.detector} on ${args.subject}`,
    summary: `synthetic finding produced by ${args.detector}`,
    subjects: [args.subject as NodeId],
    evidence: {
      nodes: [args.subject as NodeId],
      edges: [],
      query: `${args.detector}(graph)`,
      notes: ['synthetic fixture'],
    },
    population: nonBlindPopulation(),
    confidence: 'high',
    remediation: proposal('synthetic', 'no change proposed by a fixture'),
  };
}

/** Build a record in an arbitrary state, for seeding a store. */
export function record(args: {
  detector: string;
  subject: string;
  state: FindingRecord['state'];
  firstSeenRunId?: string;
  runId?: string;
  at?: string;
  fixedAt?: string;
  fixedByRunId?: string;
  regressionCount?: number;
  suppression?: { reason: string; owner: string; acceptedAt: string; expiresAt: string };
}): FindingRecord {
  const at = args.at ?? '2026-08-01T00:00:00.000Z';
  const runId = args.runId ?? 'run-0';
  const base = {
    schemaVersion: FINDING_SCHEMA_VERSION,
    fingerprint: `${args.detector}#${args.subject}` as FindingFingerprint,
    estateId: ESTATE,
    detector: args.detector,
    severity: 'high' as const,
    title: `${args.detector} on ${args.subject}`,
    summary: `synthetic finding produced by ${args.detector}`,
    subjects: [args.subject as NodeId],
    evidence: {
      nodes: [args.subject as NodeId],
      edges: [],
      query: `${args.detector}(graph)`,
      notes: ['synthetic fixture'],
    },
    population: POPULATION,
    confidence: 'high' as const,
    remediation: proposal('synthetic', 'no change proposed by a fixture'),
    firstSeenAt: at,
    firstSeenRunId: args.firstSeenRunId ?? runId,
    lastSeenAt: at,
    lastSeenRunId: runId,
    regressionCount: args.regressionCount ?? 0,
  };

  switch (args.state) {
    case 'new':
      return { ...base, state: 'new', regressionCount: 0 };
    case 'acknowledged':
      return {
        ...base,
        state: 'acknowledged',
        acknowledgedBy: 'fixture-owner',
        acknowledgedAt: at,
      };
    case 'accepted':
      return {
        ...base,
        state: 'accepted',
        suppression: args.suppression ?? {
          reason: 'accepted by a fixture',
          owner: 'fixture-owner',
          acceptedAt: at,
          expiresAt: '2026-12-31T00:00:00.000Z',
        },
      };
    case 'fixed':
      return {
        ...base,
        state: 'fixed',
        fixedAt: args.fixedAt ?? at,
        fixedByRunId: args.fixedByRunId ?? runId,
      };
    case 'regressed':
      return {
        ...base,
        state: 'regressed',
        priorState: 'fixed',
        fixedAt: args.fixedAt ?? at,
        fixedByRunId: args.fixedByRunId ?? runId,
        regressedAt: at,
        regressedByRunId: runId,
        regressionCount: args.regressionCount ?? 1,
      };
  }
}

/** A detector that reports exactly the findings it is given, non-blind. */
export function stubDetector(name: string, findings: readonly Finding[]) {
  return (_graph: BrainGraphView) => ({
    detector: name,
    findings,
    population: nonBlindPopulation(`${name} over a synthetic non-empty population`),
    skipped: [],
  });
}

/** A detector that ran but ranged over NOTHING. Green and blind. */
export function blindDetector(name: string) {
  return (_graph: BrainGraphView) => ({
    detector: name,
    findings: [],
    population: {
      subject: 'nodes' as const,
      examined: 0,
      edgesExamined: 0,
      scope: `${name} over an EMPTY population`,
      blind: true,
      byProvenance: { declared: 0, configured: 0, imports: 0, observed: 0, owns: 0 },
    },
    skipped: [],
  });
}
