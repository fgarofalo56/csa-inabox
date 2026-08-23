/**
 * RECOMMEND-ONLY, enforced at runtime rather than only in the type system.
 *
 * PRP §1 decision 1 is binding and its rationale is measured: of the 13 Container
 * App environments across these subscriptions, ONLY 1 is Loom's. The other 12 are
 * unrelated production estates. Autonomous action on a wrong ownership inference
 * destroys someone else's production. Taxonomy §3.7 adds the security-specific
 * form: a wrong autonomous "fix" to an authorization path is worse than the gap.
 *
 * `DraftedRemediation` declares no callable member, so TypeScript already forbids
 * one at a call site inside this package. That guarantee is ERASED the moment a
 * finding crosses a boundary the compiler does not own — a Cosmos document, a
 * queue message, an agent prompt, a `JSON.parse` of any of those. This module is
 * the runtime backstop for exactly that crossing.
 *
 * It is deliberately NOT a lint rule. A lint rule over `lib/brain/security/**`
 * would be keyed to the shape it forbids, which is the population failure the
 * taxonomy spends §6.4 on: a detector keyed to the unsafe pattern goes quiet on
 * the files that adopt the fix. `assertInertRemediation` runs over EVERY finding
 * regardless of who authored it, so its population is "findings", not "findings
 * that look dangerous".
 */

import type { Finding } from './substrate';

/** Property names that would make a "remediation" executable rather than drafted. */
const ACTUATOR_KEYS = [
  'apply',
  'execute',
  'exec',
  'run',
  'invoke',
  'call',
  'handler',
  'action',
  'mutate',
  'commit',
  'dispatch',
  'perform',
] as const;

/**
 * Throw if a finding's remediation carries anything executable.
 *
 * Checks BOTH the well-known actuator key names AND any function-valued property
 * whatsoever, because the second is the general case and the first only catches
 * the spellings someone thought of. The taxonomy's C1 is the same lesson: key a
 * guard to the SHAPE, never to a spelling list.
 */
export function assertInertRemediation(finding: Finding): void {
  const r = finding.remediation as unknown as Record<string, unknown>;
  if (r === null || typeof r !== 'object') {
    throw new Error(`[recommend-only] ${finding.id}: remediation is not a data object.`);
  }

  for (const [key, value] of Object.entries(r)) {
    if (typeof value === 'function') {
      throw new Error(
        `[recommend-only] ${finding.id}: remediation.${key} is a function. Findings and ` +
          'remediations are DATA (PRP §1 decision 1). Nothing in lib/brain/security may ' +
          'patch, write or call an actuator.',
      );
    }
    if ((ACTUATOR_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `[recommend-only] ${finding.id}: remediation.${key} names an actuator. A drafted ` +
          'remediation proposes; a human approves; an existing actuator executes.',
      );
    }
  }

  if (finding.remediation.requiresHumanApproval !== true) {
    throw new Error(
      `[recommend-only] ${finding.id}: requiresHumanApproval must be literally true.`,
    );
  }
}

/** Assert a whole batch. Returns the input so it can wrap a detector's output. */
export function assertAllInert(findings: readonly Finding[]): readonly Finding[] {
  for (const f of findings) assertInertRemediation(f);
  return findings;
}
