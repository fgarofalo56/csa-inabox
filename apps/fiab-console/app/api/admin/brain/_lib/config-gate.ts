/**
 * WHICH 503 IS THIS? (#4283) — the classifier, and the invariant that keeps it
 * honest (#4342 review).
 *
 * The brain `perform` route answers 503 for three error classes, and until
 * #4283 it answered all three with a bare `apiHonestError`, whose body is
 * `{ok:false, error}`. That body carries NOTHING a client can discriminate on,
 * so the surface could only print the server's sentence and say — correctly, and
 * uselessly — that it does not know which cause it is looking at.
 * `ux-baseline.md` G2 asks for an inline Fix-it on a gate; the client could not
 * honestly render one because rendering "<surface> needs <gate> wired" over an
 * ARG throttle asserts a cause nobody established (`deploy-integrity.md` R7).
 *
 * The fix is to DISCRIMINATE here, where the class is known, not to guess there.
 * `configGateFor` returns a registry gate id ONLY for an error that IS a
 * configuration gap AND whose reported gap that gate's Fix-it can actually
 * resolve. Everything else returns null and keeps the bare honest 503.
 *
 *   BrainActionsNotConfiguredError → 'cosmos-config'. The store throws it from
 *     exactly one place (`state-store.ts:92`, on `!process.env.LOOM_COSMOS_ENDPOINT`),
 *     and that var is a member of the gate's anyOf group with a real ARM
 *     resource-picker Fix-it that writes it.
 *     DISCLOSED, NOT FIXED HERE (#4342): that group is
 *     `['LOOM_COSMOS_ENDPOINT','COSMOS_ENDPOINT']` (env-checks/data-plane.ts:14)
 *     while the store reads ONLY `LOOM_COSMOS_ENDPOINT`, so an estate carrying
 *     just the legacy `COSMOS_ENDPOINT` alias reaches `configured` while the
 *     store still refuses — the same shape as the ACA gap below, reachable only
 *     via that alias. Narrowing it means changing a critical gate used by every
 *     surface, which is outside this review's blast radius; it is recorded here
 *     rather than papered over. The membership rule below is what a future fix
 *     should be measured against.
 *   AcaNotConfiguredError → 'subscription', but ONLY for the gaps listed in
 *     `ACA_GAPS_THE_SUBSCRIPTION_GATE_RESOLVES` below — see the membership rule,
 *     which is narrower than "the gate mentions the var" and is asserted by a
 *     spec rather than argued for in prose.
 *   ResourceGraphCollectionError → null, always. `arg-collect.ts` throws it on a
 *     token-acquisition failure and on ANY non-OK ARG response — a throttle, a
 *     403, a 500. None of those is a value the deploy did not set. (That class is
 *     never passed here; the route keeps it on the bare path.)
 */

import { AcaNotConfiguredError } from '@/lib/azure/container-apps-arm-client';
import { BrainActionsNotConfiguredError } from '@/lib/brain-actions/state-store';

/**
 * Gaps `readAcaConfig()` can report that resolving the 'subscription' gate
 * GENUINELY closes — mapped to the env var(s) each gap string denotes, so the
 * membership rule below is machine-checkable instead of asserted in a comment.
 *
 * ── THE MEMBERSHIP RULE (#4342 review) ─────────────────────────────────────
 * A gap belongs here only when the gate reaching `status:'configured'` IMPLIES
 * that gap is closed — i.e. at least one env var the gap denotes is a
 * `required:true` setting on the gate, not an `anyOf` alternative. An anyOf
 * member is satisfiable by a SIBLING, so `configured` says nothing about it.
 *
 * That distinction is the whole defect this rule exists to prevent, and it was
 * live: `'LOOM_ACA_RG (or LOOM_ADMIN_RG)'` used to be a member. The
 * 'subscription' gate is `required:['LOOM_SUBSCRIPTION_ID']` +
 * `anyOf:[['LOOM_DLZ_RG','LOOM_ADMIN_RG']]` and never mentions LOOM_ACA_RG at
 * all, while `readAcaConfig` reads `LOOM_ACA_RG || LOOM_ADMIN_RG` and never
 * reads LOOM_DLZ_RG. So on an estate with LOOM_SUBSCRIPTION_ID + LOOM_DLZ_RG
 * set, the gate evaluates `configured` with `missing:[]` WHILE `readAcaConfig`
 * still throws for its resource group — and `GateFixitDialog`'s poll declares
 * success on exactly that status, so the wizard would fire `onResolved()` and
 * the perform surface would 503 again with an identical envelope, under a bar
 * asserting a gate the registry already considers wired (R7 + ux-baseline G2).
 *
 * `LOOM_SUBSCRIPTION_ID` satisfies the rule: it is the gate's `required` entry,
 * so `configured` cannot be reached while it is unset. Every other gap
 * `readAcaConfig` (and its siblings — LOOM_ACA_ENVIRONMENT, the MCP-files RG)
 * can report falls through to the bare honest 503, which claims only what the
 * error itself established.
 */
export const ACA_GAPS_THE_SUBSCRIPTION_GATE_RESOLVES: ReadonlyMap<string, readonly string[]> =
  new Map([['LOOM_SUBSCRIPTION_ID', ['LOOM_SUBSCRIPTION_ID'] as readonly string[]]]);

/** The gate id the ACA-configuration class maps to when its gap qualifies. */
export const ACA_GATE_ID = 'subscription';

/** The gate id the Loom-store configuration class maps to. */
export const COSMOS_GATE_ID = 'cosmos-config';

/**
 * Classify a caught error into the gate whose Fix-it can close it, or null to
 * keep the bare honest 503. Null is not a fallback — it is the answer whenever
 * the code cannot establish that a gate's remediation would work.
 */
export function configGateFor(e: unknown): { id: string; missing: string[] } | null {
  if (e instanceof BrainActionsNotConfiguredError) {
    return { id: COSMOS_GATE_ID, missing: ['LOOM_COSMOS_ENDPOINT'] };
  }
  if (e instanceof AcaNotConfiguredError) {
    const missing = Array.isArray(e.missing) ? e.missing : [];
    // An empty list would mean the error established no gap at all; naming a
    // gate over it would be an assertion the code cannot support.
    if (missing.length === 0) return null;
    if (!missing.every((m) => ACA_GAPS_THE_SUBSCRIPTION_GATE_RESOLVES.has(m))) return null;
    return { id: ACA_GATE_ID, missing };
  }
  return null;
}
