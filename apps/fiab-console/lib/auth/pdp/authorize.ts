/**
 * PDP — public authorize() surface for EH Phase-1.
 *
 * `authorize()` = evaluate(principal, resource, action, await
 * loadPolicyBundle(principal, resource)). `requireAuthorize()` returns the
 * Decision on allow or throws an Error carrying `status: 403` + the deny reason
 * for routes/middleware to surface.
 *
 * NOTE: per the increment scope, NOTHING in this repo calls these yet — they are
 * additive and wired into routes/middleware in a later increment.
 */

import type { Action, Decision, Principal, ResourceRef } from './resource-ref';
import { evaluate } from './evaluate';
import { loadPolicyBundle } from './context-loader';

export type { Action, Decision, Principal, ResourceRef } from './resource-ref';
export { evaluate } from './evaluate';
export { loadPolicyBundle, bustAclCache } from './context-loader';

/**
 * Resolve the PDP Decision for (`principal`, `resource`, `action`): load the
 * real policy bundle from the silos, then compose it through the pure
 * `evaluate()` engine.
 */
export async function authorize(
  principal: Principal,
  resource: ResourceRef,
  action: Action,
): Promise<Decision> {
  const bundle = await loadPolicyBundle(principal, resource);
  return evaluate(principal, resource, action, bundle);
}

/** An authorization failure carrying an HTTP status for the route layer. */
export class AuthorizationError extends Error {
  readonly status = 403;
  readonly decision: Decision;
  constructor(decision: Decision) {
    super(decision.reason);
    this.name = 'AuthorizationError';
    this.decision = decision;
  }
}

/**
 * Authorize and THROW on deny (status 403 + reason) — for routes that want a
 * guard clause. Returns the (allow) Decision, whose `obligations[]` the caller
 * must still enforce (RLS predicate / CLS columns / export-block).
 */
export async function requireAuthorize(
  principal: Principal,
  resource: ResourceRef,
  action: Action,
): Promise<Decision> {
  const decision = await authorize(principal, resource, action);
  if (decision.effect === 'deny') throw new AuthorizationError(decision);
  return decision;
}
