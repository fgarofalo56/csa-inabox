/**
 * LOOM BRAIN ACTIONS — the executor registry, keyed by DETECTOR KIND (#4242).
 *
 * The mapping from "what the Brain found" to "what the platform can do about
 * it" lives HERE, server-side, and nowhere else. It is deliberately NOT a field
 * on the finding: an actuator key on a remediation object would trip
 * `assertInertRemediation`, and the whole four-layer inertness contract on
 * `lib/brain/**` stays exactly as it was.
 *
 * ── THE POPULATION ─────────────────────────────────────────────────────────
 * Every detector kind this repo mints has an entry: the four runtime detectors
 * (`app/api/admin/brain/_lib/detect.ts`), the library detectors
 * (`lib/brain/detectors/*`), and the security family (`lib/brain/security`).
 * Security is matched by SHAPE (`security.` prefix), not by a spelling list —
 * a c10 added next month is never-performable on arrival, not silently unknown.
 * An unknown detector kind is REFUSED with the honest reason, never guessed at.
 *
 * ── WHAT "NOT PERFORMABLE" MEANS, HONESTLY ─────────────────────────────────
 * The repo-edit classes (dangling wires, config drift, declared-but-dead) have
 * remediations that are REPOSITORY EDITS — a bicep line, a param file. The
 * console's write credential holds ARM roles, not a GitHub identity, and per
 * `deploy-integrity.md` an out-of-band ARM write that bicep would revert on the
 * next deploy is not a fix, it is drift. So those classes return
 * `performable: false` with that reason stated — a real refusal, not a stub
 * that pretends (`no-vaporware.md`). PR automation for them is the tracked
 * follow-up on #4242.
 */

import type { PerformRegistryEntry } from './types';

/** Security detectors are matched on this prefix — the shape, not a list. */
export const SECURITY_DETECTOR_PREFIX = 'security.';

const SECURITY_REASON =
  'Security findings are NEVER performable. Taxonomy §3.7: a wrong autonomous ' +
  '"fix" to an authorization path is worse than the gap it closes — an agent that ' +
  'edits guards can disable them. Security remediations remain recommend-only, ' +
  'permanently, by design; this is not a phase.';

const REPO_EDIT_REASON = (what: string): string =>
  `The remediation for this finding is a REPOSITORY EDIT (${what}), and the ` +
  'platform holds an ARM write credential, not a repository identity. Writing the ' +
  'change out-of-band in ARM would be reverted by the next bicep deploy ' +
  '(deploy-integrity.md — drift, not a fix). The proposed change is rendered on the ' +
  'finding for a human to land in the repo; automated PR authoring for this class is ' +
  'the tracked follow-up on #4242.';

/**
 * The registry. Executor kinds:
 *
 *   scale-to-zero    Container Apps minReplicas → 0 via the existing ARM PATCH
 *                    in `lib/azure/container-apps-arm-client.ts`. Destructive
 *                    (removes always-on capacity; adds cold-start latency), so
 *                    it STAGES on the first call and executes only on the
 *                    confirmed second call.
 *   delete-resource  ARM DELETE of the subject. Destructive in the strongest
 *                    sense; same staged two-step, same guards.
 */
const ENTRIES: readonly PerformRegistryEntry[] = [
  // ── performable: the waste class the platform can genuinely act on ───────
  {
    detector: 'unreachable-always-on',
    performable: true,
    executor: 'scale-to-zero',
    destructive: true,
  },
  {
    detector: 'unreachable-service',
    performable: true,
    executor: 'scale-to-zero',
    destructive: true,
  },
  {
    detector: 'always-on-unused',
    performable: true,
    executor: 'scale-to-zero',
    destructive: true,
  },
  // The prune class: a resource established as abandoned. ARM DELETE, behind
  // the same staged confirm.
  {
    detector: 'orphan',
    performable: true,
    executor: 'delete-resource',
    destructive: true,
  },

  // ── honestly not performable: repo-edit classes ──────────────────────────
  {
    detector: 'dangling-empty-wire',
    performable: false,
    notPerformableReason: REPO_EDIT_REASON(
      "the empty env wire is authored in bicep; the fix is wiring the value so it is produced by the deploy, per auto-bind-by-default.md §5",
    ),
  },
  {
    detector: 'dangling-wire',
    performable: false,
    notPerformableReason: REPO_EDIT_REASON(
      'the broken wire is authored in a deploy artifact; the fix lands where the wire is written',
    ),
  },
  {
    detector: 'config-drift',
    performable: false,
    notPerformableReason: REPO_EDIT_REASON(
      'drift is a disagreement between the template and the estate; the fix is reconciling the template and re-running the deploy path, not a second out-of-band ARM write',
    ),
  },
  {
    detector: 'declared-not-configured',
    performable: false,
    notPerformableReason: REPO_EDIT_REASON(
      'the template already wires this service and the deployment did not apply it; the fix is re-running the deploy path that should have',
    ),
  },
  {
    detector: 'declared-but-dead',
    performable: false,
    notPerformableReason: REPO_EDIT_REASON(
      'the declaration lives in a deploy artifact; the fix is an edit there',
    ),
  },
  {
    detector: 'reachable-not-observed',
    performable: false,
    notPerformableReason:
      'Reachable-and-unused is a WEAK signal: over a short telemetry window a ' +
      'low-frequency consumer is indistinguishable from none, so acting on it can ' +
      'break a real caller. This class stays a human decision — widen the window, ' +
      'confirm with the owning team, then land the change in the repo.',
  },
];

const BY_DETECTOR: ReadonlyMap<string, PerformRegistryEntry> = new Map(
  ENTRIES.map((e) => [e.detector, e]),
);

/** Every registered entry — the read-back route ships this so a UI can render
 * Perform buttons and honest not-performable reasons without guessing. */
export function performRegistryEntries(): readonly PerformRegistryEntry[] {
  return ENTRIES;
}

/**
 * Resolve the registry entry for a detector kind.
 *
 * NEVER returns undefined: the security family resolves by prefix, and an
 * unknown kind resolves to an explicit not-performable refusal. "I do not know
 * this detector" must never fall through to an executor.
 */
export function resolvePerformEntry(detector: string): PerformRegistryEntry {
  const hit = BY_DETECTOR.get(detector);
  if (hit) return hit;

  if (detector.startsWith(SECURITY_DETECTOR_PREFIX)) {
    return {
      detector,
      performable: false,
      notPerformableReason: SECURITY_REASON,
    };
  }

  return {
    detector,
    performable: false,
    notPerformableReason:
      `No executor is registered for detector kind '${detector}'. Refusing rather ` +
      'than guessing: an executor chosen by heuristic is exactly the wrong-inference ' +
      'blast radius PRP §1 decision 1 exists to prevent. Register the kind in ' +
      'lib/brain-actions/registry.ts with either a real executor or an honest reason.',
  };
}
