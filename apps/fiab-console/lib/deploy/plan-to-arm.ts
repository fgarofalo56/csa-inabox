/**
 * plan-to-arm — the ONE serializer that turns a DeploymentPlan into the shape
 * every deploy tier needs.
 *
 * WHY ONE
 * -------
 * There were two translators and neither was wired to the deploy that runs:
 *
 *   - `lib/setup/service-choices-to-params.ts` was CORRECT (it cleared the
 *     enable flag on use-existing) and was imported by nothing but its own test.
 *   - `app/api/setup/deploy/route.ts`'s `serviceChoiceParamLines()` was wired,
 *     disagreed with it (it set the flag to TRUE on use-existing), and was
 *     reachable only from the HTTP-503 copy-paste block.
 *
 * So a divergence between two mappings decided whether a customer got a second
 * Purview. There is now one function, and `scripts/ci/check-plan-transport.mjs`
 * asserts every tier calls it.
 *
 * THE FOUR TIERS
 * --------------
 *   0. user-ARM PUT       → `planToArmParameters()` into the deployment body
 *   1. Setup Orchestrator → the plan on the request model (its pydantic
 *                           `extra="ignore"` silently dropped anything undeclared)
 *   2. GitHub dispatch    → `planToDispatchInputs()`. The REST dispatch API caps
 *                           `inputs` at 10 properties — which is exactly why the
 *                           existing allow-list is 10 — so the plan MUST travel
 *                           as ONE opaque property.
 *   3. copy-paste `az`    → `planToCliTokens()`
 *
 * All four emit the SAME `adopt` object, so a plan cannot mean one thing on one
 * tier and something else on another.
 */

import { getServiceDef } from './adoption-catalog';
import { canonicalize, type DeploymentPlan, type ServiceDecision } from './plan-model';

/** The per-service entry `main.bicep`'s `adopt` object carries. */
export interface AdoptEntry {
  mode: 'adopt' | 'create' | 'skip';
  target?: { name: string; rg: string; sub: string };
  extra?: Record<string, string>;
}

export type AdoptBag = Record<string, AdoptEntry>;

export type ArmParamValue = string | number | boolean | Record<string, unknown> | unknown[];

/**
 * Build the `adopt` object.
 *
 * Two rules, both load-bearing:
 *
 * 1. A `create` decision emits `{ mode: 'create' }` and NO target. Bicep's
 *    `union()` DEEP-merges, so a `target` left on a create entry would survive a
 *    merge over the legacy EXISTING_* environment and rebind the Console to the
 *    customer's resource while a new one was also deployed. main.bicep's
 *    accessors gate on mode for the same reason; this is the belt to that brace.
 *
 * 2. A service the operator never touched is OMITTED, not written as 'create'.
 *    An absent key already means create in `adoptMode()`, and an empty object is
 *    the honest representation of "no decisions were made".
 */
export function planToAdoptBag(plan: DeploymentPlan): AdoptBag {
  const bag: AdoptBag = {};
  for (const key of Object.keys(plan.services).sort()) {
    const d: ServiceDecision = plan.services[key];
    if (!getServiceDef(key)) {
      // An unknown key would be silently ignored by bicep. Dropping it here and
      // surfacing it in validatePlan() is the honest half of that.
      continue;
    }
    if (d.mode === 'create') {
      bag[key] = { mode: 'create' };
      continue;
    }
    if (d.mode === 'skip') {
      bag[key] = { mode: 'skip' };
      continue;
    }
    const entry: AdoptEntry = {
      mode: 'adopt',
      target: {
        name: d.target?.name ?? '',
        rg: d.target?.rg ?? '',
        sub: d.target?.sub ?? '',
      },
    };
    if (d.extra && Object.keys(d.extra).length > 0) {
      entry.extra = { ...d.extra };
    }
    bag[key] = entry;
  }
  return bag;
}

/** ARM deployment parameters for the tier-0 PUT and the tier-1 orchestrator. */
export function planToArmParameters(plan: DeploymentPlan): Record<string, ArmParamValue> {
  const params: Record<string, ArmParamValue> = {
    adopt: planToAdoptBag(plan) as Record<string, unknown>,
  };
  for (const [flag, value] of Object.entries(plan.featureFlags)) {
    params[flag] = value;
  }
  return params;
}

/** The canonical `LOOM_ADOPT_JSON` value — what the bicepparam files read. */
export function planToAdoptJson(plan: DeploymentPlan): string {
  return JSON.stringify(canonicalize(planToAdoptBag(plan)));
}

/**
 * Tokens for the copy-paste `az deployment sub create` command.
 *
 * The JSON is passed as a single-quoted shell literal. Any single quote inside a
 * resource name would break the quoting, so it is escaped the POSIX way
 * (`'\''`). Azure resource names cannot contain a quote today, but a serializer
 * that would emit a broken command if they ever could is a latent defect.
 */
export function planToCliTokens(plan: DeploymentPlan): string[] {
  const json = planToAdoptJson(plan);
  const quoted = `'${json.replace(/'/g, `'\\''`)}'`;
  const tokens = [`adopt=${quoted}`];
  for (const [flag, value] of Object.entries(plan.featureFlags).sort()) {
    tokens.push(`${flag}=${value ? 'true' : 'false'}`);
  }
  return tokens;
}

/**
 * Inputs for the tier-2 `workflow_dispatch`.
 *
 * `plan_id` is preferred: the workflow reads the plan from the
 * `deployment-plans` Cosmos container, so the dispatch payload stays small and
 * the deployed plan is provably the persisted one. `plan_json` is the fallback
 * for a first-run deploy, where the Console (and therefore Cosmos) does not
 * exist yet.
 *
 * The GitHub REST API rejects a dispatch with more than 10 `inputs` properties.
 * That cap is why the shipped allow-list is exactly 10 entries and why the plan
 * could never be added as a set of per-service inputs.
 */
export const GITHUB_DISPATCH_INPUT_CAP = 10;

export function planToDispatchInputs(
  plan: DeploymentPlan,
  opts: { preferPlanId: boolean },
): Record<string, string> {
  return opts.preferPlanId
    ? { plan_id: plan.planId }
    : { plan_json: planToAdoptJson(plan) };
}

/**
 * Merge plan inputs into an existing dispatch payload, failing CLOSED if that
 * would exceed GitHub's cap.
 *
 * Silently dropping the plan to stay under the cap is precisely the defect this
 * whole change exists to remove — the shipped allow-list dropped `serviceChoices`
 * without a word and the deploy provisioned duplicates.
 */
export function mergeDispatchInputs(
  base: Record<string, string>,
  planInputs: Record<string, string>,
): Record<string, string> {
  const merged = { ...base, ...planInputs };
  const count = Object.keys(merged).length;
  if (count > GITHUB_DISPATCH_INPUT_CAP) {
    throw new Error(
      `dispatch payload would carry ${count} inputs, over GitHub's cap of ${GITHUB_DISPATCH_INPUT_CAP}. ` +
        `Drop a non-plan input — the deployment plan must not be the thing that is dropped, ` +
        `because a dispatch without it deploys new resources beside the ones the operator chose to adopt.`,
    );
  }
  return merged;
}

/**
 * Every role assignment the deploy must create before it provisions anything.
 * Derived from the plan, so the grant set can never drift from the decisions.
 */
export function planToGrants(plan: DeploymentPlan): { serviceKey: string; roleName: string; roleGuid: string; scope: string }[] {
  const out: { serviceKey: string; roleName: string; roleGuid: string; scope: string }[] = [];
  for (const key of Object.keys(plan.services).sort()) {
    const d = plan.services[key];
    if (d.mode !== 'adopt') continue;
    const def = getServiceDef(key);
    if (!def?.roleGuid || !def.roleName) continue;
    const rg = d.target?.rg ?? '';
    const name = d.target?.name ?? '';
    if (!rg || !name) continue;
    out.push({ serviceKey: key, roleName: def.roleName, roleGuid: def.roleGuid, scope: `${rg}/${name}` });
  }
  return out;
}
