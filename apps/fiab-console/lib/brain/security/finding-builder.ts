/**
 * Finding construction helper.
 *
 * One place that builds a `Finding` so every detector's output carries the same
 * fields with the same discipline, and so `requiresHumanApproval: true` cannot be
 * forgotten. Nothing clever lives here — the value is that a reviewer reading a
 * detector sees the PREDICATE, not twenty lines of object literal per branch.
 */

import type {
  Confidence,
  DraftedRemediation,
  Evidence,
  Finding,
  FindingClass,
  Severity,
} from './substrate';

export interface FindingInput {
  readonly id: string;
  readonly detectorId: string;
  readonly findingClass: FindingClass;
  readonly severity: Severity;
  readonly confidence: Confidence;
  readonly title: string;
  readonly nodeIds: readonly string[];
  readonly edgeIds?: readonly string[];
  readonly query: string;
  readonly facts: readonly string[];
  readonly remediationSummary: string;
  readonly proposedCommands?: readonly string[];
  readonly proposedPatchDescription?: string | null;
}

export function buildFinding(input: FindingInput): Finding {
  const evidence: Evidence = {
    nodeIds: input.nodeIds,
    edgeIds: input.edgeIds ?? [],
    query: input.query,
    facts: input.facts,
  };
  const remediation: DraftedRemediation = {
    summary: input.remediationSummary,
    proposedCommands: input.proposedCommands ?? [],
    proposedPatchDescription: input.proposedPatchDescription ?? null,
    requiresHumanApproval: true,
  };
  return {
    id: input.id,
    detectorId: input.detectorId,
    findingClass: input.findingClass,
    severity: input.severity,
    confidence: input.confidence,
    title: input.title,
    evidence,
    remediation,
  };
}
