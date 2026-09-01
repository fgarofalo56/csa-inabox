/**
 * LOOM BRAIN ACTIONS — THE ESTATE ID EVERY MUTATION IS SCOPED BY (#4255 / #4258).
 *
 * ── WHY THIS IS ITS OWN MODULE ─────────────────────────────────────────────
 * Two things in this package have to agree about one string, and if they ever
 * disagree the failure is silent and severe:
 *
 *   1. The BACKFILL writes `loom-estate-id: <estateId>` onto a resource.
 *   2. `guardOwnership` decides a mutation may proceed because a resource
 *      carries `loom-estate-id: <estateId>`.
 *
 * If (1) stamps one value and (2) scopes by another, ownership silently stops
 * matching — or, worse, matches too much. So the value comes from exactly one
 * place, this function, and both callers use it.
 *
 * ── THE PERMISSIVE-OWNERSHIP DEFECT THIS CLOSES (#4258 item 4) ──────────────
 * `perform.ts` used to call `loadSnapshot()` with NO estate id.
 * `resource-graph.ts` documents precisely what that means: "When OMITTED, any
 * non-empty `loom-estate-id` value counts as owned … Callers that will
 * recommend a mutation MUST pass it." So the mutation path was running the one
 * ownership mode the extractor explicitly forbids for mutating callers.
 *
 * It was harmless only by accident: nothing on the estate carries the tag, so
 * `guardOwnership` refused everything. The backfill in this same PR removes
 * that accident. Un-fixed, the first tagged estate would degrade `guardOwnership`
 * to "carries SOME Loom estate tag" — with only `guardWriteScope` bounding the
 * blast radius, and a second Loom estate sharing a subscription and RG would be
 * inside it.
 *
 * ── WHY `resolveEstateId` AND NOT `process.env.LOOM_ESTATE_ID` ─────────────
 * `LOOM_ESTATE_ID` is measured to be set by NOTHING today (see
 * `lib/estate/pause-orchestrator.ts`'s arming-switch note, and #3922).
 * Scoping on the raw env var would make this whole capability inert on every
 * real deployment — an honest gate whose remediation the platform could
 * perform itself, which `auto-bind-by-default.md` calls a defect rather than a
 * compliant state.
 *
 * `resolveEstateId` is the ESTABLISHED resolver the pause path already trusts:
 * `LOOM_ESTATE_ID` when the deploy set one, otherwise a DETERMINISTIC
 * `loom:<sub8>:<rg>` from the subscription + admin RG the console is bound to.
 * It is not a guess about ownership — ownership still comes from the tag; it
 * only needs to be STABLE, so the value stamped today is the value matched
 * tomorrow. Reusing it also means the Brain and the pause machinery cannot end
 * up scoping two different estates.
 *
 * ── AND WHY `loom:unbound` IS REFUSED ──────────────────────────────────────
 * `resolveEstateId` falls back to the literal `loom:unbound` when it has
 * neither an explicit id nor a subscription + RG. That is a NON-IDENTITY: it
 * names no estate, and two unrelated consoles would both produce it. Stamping
 * it would claim resources for a nothing, and scoping by it would match every
 * other console that also failed to resolve. So it is refused — a real,
 * honest, and (on any completed deploy) unreachable gate.
 */

import { resolveEstateId } from '@/lib/estate/pause-orchestrator';
import type { GuardRefusal } from './types';

/**
 * The sentinel `resolveEstateId` returns when it can establish no identity.
 * Mirrors the literal in `lib/estate/pause-orchestrator.ts`; the test asserts
 * they are still the same string, so a rename there cannot silently un-gate
 * this one.
 */
export const UNBOUND_ESTATE_ID = 'loom:unbound';

/**
 * Resolve the estate id a mutation (or a backfill write) is scoped by.
 *
 * Returns a refusal rather than throwing so it can slot into the guard chain
 * as just another guard, and so the audit row records the same
 * `{guard, reason}` shape every other refusal does.
 */
export function resolveMutationEstateId(
  env: NodeJS.ProcessEnv = process.env,
): { readonly estateId: string } | { readonly refusal: GuardRefusal } {
  const estateId = resolveEstateId(env);
  if (!estateId || estateId === UNBOUND_ESTATE_ID) {
    return {
      refusal: {
        guard: 'estate-scoped',
        reason:
          'REFUSED: this console cannot establish WHICH Loom estate it is. ' +
          `LOOM_ESTATE_ID is unset and neither LOOM_SUBSCRIPTION_ID nor an admin ` +
          'resource group (LOOM_ADMIN_RG / LOOM_ACA_RG / LOOM_DLZ_RG) is set either, ' +
          `so the estate id resolves to the non-identity '${UNBOUND_ESTATE_ID}'. ` +
          'Ownership scoped by a non-identity would match every other console that ' +
          'also failed to resolve, and a tag stamped with it would claim resources ' +
          'for no estate at all. Nothing was read from Azure and NOTHING was ' +
          'changed in Azure.',
      },
    };
  }
  return { estateId };
}
