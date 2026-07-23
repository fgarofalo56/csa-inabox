/**
 * loom-prompt-registry — doc shapes + PURE semver layer + MIG1 versioned-migration
 * registration (N13, Unified LLMOps).
 *
 * N13 adds the ONE plane WS-E deliberately left out: a governed PROMPT REGISTRY.
 * WS-E (E1–E6) already owns the eval harness (azure-functions/copilot-evaluator),
 * the score floors (content/evals/eval-floors.json), the CI gate
 * (scripts/csa-loom/check-eval-regression.mjs + .github/workflows/copilot-quality-evals.yml)
 * and the /admin/copilot-quality read surface. N13 does NOT rebuild any of that —
 * it registers prompts as semver'd, eval-scored, APPROVED artifacts and feeds a
 * prompt bump into the EXISTING evaluator + the EXISTING floor gate.
 *
 * This module is a LEAF: it imports ONLY `cosmos-migrations` (no cosmos-client,
 * no copilot store) so `cosmos-client` can import it at module scope to register
 * the migrator chain before any read materializes — exactly the
 * copilot-evals-model / semantic-contract-model precedent. The Cosmos-touching
 * store lives in `lib/copilot/prompt-registry.ts`.
 *
 * CURRENT SCHEMA VERSION: 1 (every doc is stamped `schemaVersion: 1` at write).
 * A future breaking shape change bumps PROMPT_REGISTRY_SCHEMA_VERSION to N+1 and
 * registers its `fromVersion: N` migrator in
 * {@link registerPromptRegistryMigrators} (called at module scope). Per MIG1
 * there is deliberately NO v1 migrator today.
 *
 * Per-cloud: identical Commercial / GCC-High (pure metadata in Cosmos; the eval
 * hook rides the same in-boundary evaluator Function both clouds deploy).
 * IL5/SOVEREIGN MOAT: the registry, the scores it carries, and the approval
 * records all live in the deployment's OWN Cosmos + the deployment's OWN
 * evaluator Function inside the VNet — there is NO external LLMOps SaaS
 * (no Braintrust, no LangSmith, no Weights & Biases) in the path. That is
 * precisely why Loom builds this natively: an IL5 enclave cannot ship prompts,
 * completions, or eval scores to a commercial multi-tenant SaaS, so prompt
 * governance has to be in-boundary or it does not exist.
 */

import { registerMigrator, type DocMigrator } from './cosmos-migrations';

export const PROMPT_REGISTRY_CONTAINER = 'loom-prompt-registry';
export const PROMPT_REGISTRY_SCHEMA_VERSION = 1;

/** The first version minted when a prompt is registered (code default — no env). */
export const INITIAL_PROMPT_VERSION = '1.0.0';

/** Lifecycle of one prompt version. */
export type PromptVersionStatus =
  /** Authored, not yet put in front of the evaluator. */
  | 'draft'
  /** Published → an eval run was requested through the EXISTING E2 evaluator. */
  | 'published'
  /** A human approved it (audited) — eligible to be the active version. */
  | 'approved'
  /** Superseded by an explicit rollback to an earlier approved version. */
  | 'rolled-back';

/** The eval score a version carries, copied from the REAL E2 `eval-run` rollup. */
export interface PromptEvalScore {
  /** The Copilot surface the eval set scored ('help', 'lakehouse', …). */
  surface: string;
  /** The E2 run this score came from (`eval-run.runId`). */
  runId: string;
  finishedAt: string;
  questions: number;
  retrievalHitRate: number;
  /** null when the judge was deferred (E2 daily cap) — E3 treats that as no-change. */
  groundingAvg: number | null;
  passRate: number;
  /** True when ANY measured metric sat below its E3 floor in that run. */
  belowFloor: boolean;
  /** Which metrics were below floor (empty when clean). */
  belowFloorMetrics: string[];
  /** True when the floors compared against were still the provisional seed. */
  provisionalFloor: boolean;
}

/** The audited approval record stamped onto a version. */
export interface PromptApproval {
  approvedBy: string;
  approvedByOid: string;
  approvedAt: string;
  note?: string;
  /** True when an admin knowingly approved a version that sat below its E3 floor. */
  overrodeFloor?: boolean;
}

/** A registered prompt (the container's `docType:'prompt'` doc). PK /promptId. */
export interface PromptDoc {
  /** Cosmos id — `prompt:<promptId>`. */
  id: string;
  /** PK — the stable prompt key; every version shares this partition. */
  promptId: string;
  docType: 'prompt';
  schemaVersion: number;
  /** The Copilot surface this prompt serves — the eval set that scores it. */
  surface: string;
  label: string;
  description: string;
  /** Steward / owner (UPN, email, or display name). */
  owner: string;
  /** The semver currently served by {@link getActivePrompt}; null until approved. */
  activeVersion: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy?: string;
}

/** One semver'd prompt version (`docType:'prompt-version'`). PK /promptId. */
export interface PromptVersionDoc {
  /** Cosmos id — `version:<promptId>:<version>`. */
  id: string;
  /** PK — shares the prompt's partition (list-versions is single-partition). */
  promptId: string;
  docType: 'prompt-version';
  schemaVersion: number;
  /** Semantic version, e.g. `1.2.0`. */
  version: string;
  /** The prompt text itself (system/instruction template). */
  template: string;
  /** Author's changelog note for this bump. */
  notes?: string;
  status: PromptVersionStatus;
  /** The E2 run requested for this version at publish time (null when gated). */
  evalRunId?: string | null;
  evalRequestedAt?: string;
  /** Honest record of an evaluator that was not wired at publish time. */
  evalGate?: { gateId: string; missing: string[]; remediation: string } | null;
  /** The score attached from the REAL evaluator run (absent until it lands). */
  evalScore?: PromptEvalScore;
  approval?: PromptApproval;
  createdAt: string;
  createdBy: string;
  updatedAt?: string;
}

// ── PURE semver layer (no Azure, fully unit-testable) ────────────────────────

/** A parsed semantic version. */
export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/** Which component a publish bumps. */
export type SemverBump = 'major' | 'minor' | 'patch';

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Parse `X.Y.Z` → {@link Semver}, or null when it is not a strict semver. Pure. */
export function parseSemver(v: string): Semver | null {
  const m = SEMVER_RE.exec(String(v || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Render a {@link Semver} back to `X.Y.Z`. Pure. */
export function formatSemver(s: Semver): string {
  return `${s.major}.${s.minor}.${s.patch}`;
}

/**
 * Compare two semvers: negative when `a` < `b`, 0 when equal, positive when
 * `a` > `b`. An unparseable version sorts BELOW every valid one (so a corrupt
 * doc can never become "latest"). Pure.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

/** Bump a semver (minor/patch reset the lower components). Pure. */
export function bumpSemver(v: string, kind: SemverBump = 'minor'): string {
  const p = parseSemver(v) ?? { major: 1, minor: 0, patch: 0 };
  if (kind === 'major') return formatSemver({ major: p.major + 1, minor: 0, patch: 0 });
  if (kind === 'patch') return formatSemver({ major: p.major, minor: p.minor, patch: p.patch + 1 });
  return formatSemver({ major: p.major, minor: p.minor + 1, patch: 0 });
}

/** The highest semver in a list (null for an empty/all-invalid list). Pure. */
export function latestVersion(versions: readonly string[]): string | null {
  let best: string | null = null;
  for (const v of versions) {
    if (!parseSemver(v)) continue;
    if (best === null || compareSemver(v, best) > 0) best = v;
  }
  return best;
}

/** Version docs sorted newest-semver-first (stable for equal versions). Pure. */
export function sortVersionsDesc<T extends { version: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => compareSemver(b.version, a.version));
}

/**
 * The version a runtime read should serve: the prompt's `activeVersion` when it
 * resolves to an APPROVED version doc, else null. Deliberately strict — an
 * unapproved (draft/published) version is NEVER served, which is what makes the
 * registry a governance control rather than a filing cabinet. Pure.
 */
export function resolveActiveVersion(
  prompt: Pick<PromptDoc, 'activeVersion'>,
  versions: readonly PromptVersionDoc[],
): PromptVersionDoc | null {
  if (!prompt.activeVersion) return null;
  const hit = versions.find((v) => v.version === prompt.activeVersion);
  return hit && hit.status === 'approved' ? hit : null;
}

/**
 * Whether a version may be approved, given its attached eval score and the E3
 * floors it was measured against. Pure — the store applies the verdict, the UI
 * explains it.
 *
 *   • no score yet          → blocked ('no-eval'): publish first, let the
 *                             EXISTING evaluator score it.
 *   • score below its floor → blocked ('below-floor') unless the admin passes an
 *                             explicit override (which is recorded in the audit
 *                             row as `overrodeFloor: true`).
 *   • otherwise             → allowed.
 */
export function approvalEligibility(
  version: Pick<PromptVersionDoc, 'evalScore' | 'status'>,
  opts: { overrideBelowFloor?: boolean } = {},
): { allowed: boolean; reason: 'ok' | 'no-eval' | 'below-floor'; detail: string } {
  const score = version.evalScore;
  if (!score) {
    return {
      allowed: false,
      reason: 'no-eval',
      detail:
        'This version has no eval score yet. Publish it (which requests a run from the copilot-evaluator Function) and wait for the run to land, then approve.',
    };
  }
  if (score.belowFloor && !opts.overrideBelowFloor) {
    return {
      allowed: false,
      reason: 'below-floor',
      detail: `Run ${score.runId} sat below the ${score.surface} floor (${score.belowFloorMetrics.join(', ') || 'one or more metrics'}). Fix the prompt and publish again, or approve with an explicit floor override (recorded in the audit trail).`,
    };
  }
  return { allowed: true, reason: 'ok', detail: 'Eval score is at or above the surface floor.' };
}

// ── MIG1 registration ────────────────────────────────────────────────────────

/**
 * MIG1 registration point for this container's migrator chain. v1 is current —
 * the chain is empty. The FIRST breaking change adds:
 *
 *   const v1toV2: DocMigrator = (doc) => ({ ...doc, …, schemaVersion: 2 });
 *   registerMigrator(PROMPT_REGISTRY_CONTAINER, 1, v1toV2);
 *
 * plus the optional backfill script
 * `scripts/csa-loom/cosmos-backfill-loom-prompt-registry.mjs`.
 */
export function registerPromptRegistryMigrators(): void {
  // v1 → (none yet). Keeping the registerMigrator reference live reserves the
  // wiring for the first real migration without claiming the one-owner-per-step
  // v1 slot with an inert migrator (the MIG1 convention, per copilot-evals-model).
  const register: (containerId: string, fromVersion: number, migrate: DocMigrator) => void = registerMigrator;
  void register;
}

registerPromptRegistryMigrators();
