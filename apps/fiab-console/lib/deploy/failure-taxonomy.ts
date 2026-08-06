/**
 * failure-taxonomy.ts — deployment failure CLASSIFICATION (deploy-integrity.md R6/R7).
 *
 * WHY THIS EXISTS
 *
 *   Before this module the repo classified deployment failures in exactly two
 *   places, both by hand, both incomplete:
 *
 *     full-app-deploy-commercial.yml roll()   `grep -qi 'OperationInProgress'`
 *                                             — correct, and the model here.
 *     full-app-deploy-commercial.yml build    `for attempt in 1 2 3` with NO
 *                                             classification at all — so the
 *                                             QuotaExceeded observed on run
 *                                             31022950740 was retried three
 *                                             times over 90s and then reported
 *                                             as "$APP ACR build failed after 3
 *                                             attempts", a sentence that never
 *                                             contains the word quota.
 *
 *   Everything else fell to `apps/fiab-setup-orchestrator`'s
 *   `error=str(exc)` — a stringified exception, which R6 names explicitly as
 *   forbidden.
 *
 * THE TWO INVARIANTS THIS MODULE ENFORCES
 *
 *   R6  Retry ONLY what is genuinely transient, with a bounded budget, and
 *       FAIL CLOSED when the budget is gone. A retry that cannot fail is
 *       forbidden — so `retryable` is a property of the CLASS, never of the
 *       call site, and `unknown` is not retryable.
 *
 *   R7  Never assert a cause you did not establish. Every diagnosis carries
 *       `evidence[]` — the literal signal strings found in the input and the
 *       line each was found on. A diagnosis may only claim what is in there.
 *       When nothing matches, the class is `unknown`, `evidence` is empty, and
 *       the rendered message says so in those words. `unknown` is NOT `defect`
 *       and is NOT a pass.
 *
 * THE TABLE LIVES IN ONE FILE, NOT TWO.
 *
 *   The design called for a Node "twin" of this table plus a guard that
 *   byte-compares them. A twin that CAN drift plus a guard that must notice is
 *   strictly worse than one table that cannot drift — this repo's dominant
 *   defect class is a control reading green while the two things it compares
 *   have diverged (csa_loom_gates_that_measure_nothing). So
 *   `scripts/ci/deploy-classify.mjs` reads THE SAME `failure-taxonomy.json`
 *   from disk, and `scripts/ci/check-deploy-failure-handling.mjs` proves it
 *   still resolves. The JSON lives under apps/fiab-console because the console
 *   image build context is apps/fiab-console
 *   (csa_loom_console_build_context_gotcha) — the CI script reaches UP to it,
 *   never the reverse.
 *
 * Tests: apps/fiab-console/lib/deploy/__tests__/failure-taxonomy.test.ts
 *        scripts/ci/__tests__/deploy-classify.test.mjs (same table, Node side)
 */

import taxonomy from './failure-taxonomy.json';

export type FailureClass =
  | 'transient'
  | 'eventual-consistency'
  | 'registration'
  | 'permission'
  | 'quota'
  | 'config'
  | 'defect'
  | 'unknown';

export type RemediationKind = 'platform-will-fix' | 'operator-action' | 'not-remediable';

/** One literal signal string, and the line of input it was actually found on. */
export interface FailureEvidence {
  /** The signal string from the taxonomy that matched (lower-cased). */
  signal: string;
  /** The input line it matched on, trimmed and length-capped. Verbatim otherwise. */
  line: string;
}

export interface FailureDiagnosis {
  class: FailureClass;
  /** Taxonomy signal id, e.g. `quota.exceeded`. `null` only for `unknown`. */
  signalId: string | null;
  label: string;
  summary: string;
  /** Whether the retry harness may retry this class. `unknown` is always false. */
  retryable: boolean;
  /** `registration` only: retryable AFTER the platform performs the remediation. */
  retryableAfterRemediation: boolean;
  /**
   * R7 anchor. Every claim the rendered message makes must be traceable to an
   * entry here. Empty ⇒ nothing was established ⇒ the message says exactly that.
   */
  evidence: FailureEvidence[];
  remediationKind: RemediationKind | null;
  remediation: string | null;
  /** Exact command shape when the operator (not the platform) must act. */
  grantHint?: string;
  portalPath?: string;
  /** Distinct process exit code per class, so a caller can branch without parsing. */
  exitCode: number;
  defaultMaxAttempts: number;
  defaultBackoffSeconds: number;
}

interface RawSignal {
  id: string;
  class: string;
  anyOf?: string[];
  allOf?: string[];
  not?: string[];
  observed: string;
  remediationKind: string;
  remediation: string;
  grantHint?: string;
  portalPath?: string;
}

interface RawClass {
  retryable: boolean;
  retryableAfterRemediation?: boolean;
  label: string;
  summary: string;
  defaultMaxAttempts: number;
  defaultBackoffSeconds: number;
  exitCode: number;
}

const CLASSES = taxonomy.classes as unknown as Record<string, RawClass>;
const SIGNALS = taxonomy.signals as unknown as RawSignal[];
const PRECEDENCE = taxonomy.classPrecedence as unknown as string[];

/** Longest line we quote back as evidence. Keeps a 10 MB ARM blob out of a log line. */
const EVIDENCE_LINE_CAP = 400;

/** The class every unmatched failure falls to. NOT a pass, NOT `defect`. */
export const UNKNOWN_CLASS: FailureClass = 'unknown';

export function isRetryableClass(cls: FailureClass): boolean {
  return CLASSES[cls]?.retryable === true;
}

export function classExitCode(cls: FailureClass): number {
  return CLASSES[cls]?.exitCode ?? CLASSES.unknown.exitCode;
}

export function allFailureClasses(): FailureClass[] {
  return Object.keys(CLASSES) as FailureClass[];
}

/**
 * Rank a signal for precedence. Lower wins.
 *
 * `classPrecedence` lists NON-RETRYABLE classes first on purpose: when one
 * stderr carries signals from several classes, the dangerous direction of a
 * misclassification is calling a permanent failure transient, because that
 * burns the whole retry budget and then reports "failed after N attempts"
 * without ever naming the real cause. Ties therefore resolve toward FAIL FAST.
 * Within one class, declaration order in the JSON breaks the tie.
 */
function signalRank(sig: RawSignal, indexInFile: number): number {
  const classIdx = PRECEDENCE.indexOf(sig.class);
  // A signal whose class is absent from classPrecedence would silently sort
  // FIRST with -1 and outrank `defect`. Sort it last instead and let
  // check-deploy-failure-handling.mjs fail the build for the missing entry.
  const safeIdx = classIdx === -1 ? PRECEDENCE.length : classIdx;
  return safeIdx * 10_000 + indexInFile;
}

function findLineContaining(lines: string[], lowerLines: string[], needle: string): string {
  const idx = lowerLines.findIndex((l) => l.includes(needle));
  const raw = idx === -1 ? '' : lines[idx].trim();
  return raw.length > EVIDENCE_LINE_CAP ? `${raw.slice(0, EVIDENCE_LINE_CAP)}…` : raw;
}

/**
 * Classify a deployment / build / roll failure from whatever the tool wrote to
 * stderr (or an `az deployment operation list` JSON blob).
 *
 * Never throws. An empty or unreadable input is `unknown`, which fails closed.
 */
export function classifyDeployFailure(text: string | null | undefined): FailureDiagnosis {
  const raw = typeof text === 'string' ? text : '';
  const lower = raw.toLowerCase();
  const lines = raw.split(/\r?\n/);
  const lowerLines = lines.map((l) => l.toLowerCase());

  const matches: { sig: RawSignal; rank: number; evidence: FailureEvidence[] }[] = [];

  SIGNALS.forEach((sig, i) => {
    if (sig.not?.some((n) => lower.includes(n))) return;
    if (sig.allOf && !sig.allOf.every((a) => lower.includes(a))) return;

    const hitAny = (sig.anyOf ?? []).filter((a) => lower.includes(a));
    if ((sig.anyOf?.length ?? 0) > 0 && hitAny.length === 0) return;
    // A signal with neither anyOf nor allOf would match EVERYTHING. Refuse it
    // here rather than let it swallow the taxonomy; the CI guard fails the
    // build for it separately.
    if (!sig.anyOf?.length && !sig.allOf?.length) return;

    const hits = [...hitAny, ...(sig.allOf ?? [])];
    matches.push({
      sig,
      rank: signalRank(sig, i),
      evidence: hits.map((h) => ({ signal: h, line: findLineContaining(lines, lowerLines, h) })),
    });
  });

  if (matches.length === 0) return unknownDiagnosis();

  matches.sort((a, b) => a.rank - b.rank);
  const winner = matches[0];
  const cls = winner.sig.class as FailureClass;
  const meta = CLASSES[cls];

  if (!meta) return unknownDiagnosis();

  return {
    class: cls,
    signalId: winner.sig.id,
    label: meta.label,
    summary: meta.summary,
    retryable: meta.retryable === true,
    retryableAfterRemediation: meta.retryableAfterRemediation === true,
    evidence: winner.evidence,
    remediationKind: winner.sig.remediationKind as RemediationKind,
    remediation: winner.sig.remediation,
    ...(winner.sig.grantHint ? { grantHint: winner.sig.grantHint } : {}),
    ...(winner.sig.portalPath ? { portalPath: winner.sig.portalPath } : {}),
    exitCode: meta.exitCode,
    defaultMaxAttempts: meta.defaultMaxAttempts,
    defaultBackoffSeconds: meta.defaultBackoffSeconds,
  };
}

function unknownDiagnosis(): FailureDiagnosis {
  const meta = CLASSES.unknown;
  return {
    class: 'unknown',
    signalId: null,
    label: meta.label,
    summary: meta.summary,
    retryable: false,
    retryableAfterRemediation: false,
    evidence: [],
    remediationKind: null,
    remediation: null,
    exitCode: meta.exitCode,
    defaultMaxAttempts: meta.defaultMaxAttempts,
    defaultBackoffSeconds: meta.defaultBackoffSeconds,
  };
}

/**
 * Render a diagnosis as the operator-facing message.
 *
 * The ONLY thing this is allowed to state as fact is what is in
 * `evidence[]`. For `unknown` it says it does not know, names nothing, and
 * asks for the run — which is a correct outcome, not a failure of the tool.
 */
export function renderDiagnosis(d: FailureDiagnosis, context?: { step?: string }): string {
  const where = context?.step ? ` in ${context.step}` : '';
  if (d.class === 'unknown') {
    return [
      `Could not classify this failure${where}.`,
      'No cause is asserted: nothing in the output matched a known Azure failure signal.',
      'This is a gap in the CSA Loom failure taxonomy (apps/fiab-console/lib/deploy/failure-taxonomy.json).',
      'Attach this run to a new issue labelled deploy-integrity so the signal can be added.',
    ].join(' ');
  }

  const observed = d.evidence.length
    ? `Established from the output: ${d.evidence.map((e) => `"${e.signal}"`).join(', ')}.`
    : 'No evidence recorded.';

  const parts = [`${d.label}${where}. ${d.summary}`, observed];
  if (d.remediation) parts.push(`Remediation: ${d.remediation}`);
  if (d.grantHint) parts.push(`Command: ${d.grantHint}`);
  if (d.portalPath) parts.push(`Portal: ${d.portalPath}`);
  return parts.join(' ');
}

/**
 * Whether CSA Loom itself must perform this remediation rather than printing it
 * (auto-bind-by-default.md §5: a remediation the platform could have executed
 * is a defect, not a helpful message).
 */
export function isPlatformRemediable(d: FailureDiagnosis): boolean {
  return d.remediationKind === 'platform-will-fix';
}
