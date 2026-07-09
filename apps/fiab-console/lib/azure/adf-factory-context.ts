/**
 * Selected-factory override context (Data Factory).
 *
 * The pipeline editor lets the operator point a pipeline item at a SPECIFIC
 * Azure Data Factory — across any subscription their RBAC reaches — via the
 * cross-sub AzureResourcePicker. Historically that selection was DECORATIVE for
 * listing: every `/api/adf/*` route and the per-item bind route resolved the
 * SAME env-pinned deployment-default factory (LOOM_SUBSCRIPTION_ID /
 * LOOM_DLZ_RG / LOOM_ADF_NAME), so the Factory Resources tree, the "Bind to an
 * existing pipeline" dropdown, and Create-&-bind could silently diverge from the
 * factory the operator picked — surfacing as "No pipelines found" / "Bind
 * failed" whenever the selected factory wasn't the env default.
 *
 * This module threads the SELECTED factory coordinates through EVERY adf-client
 * call a request makes, WITHOUT rewiring ~40 client functions: a route parses
 * the coords from the request's query params and runs its handler inside
 * `withFactoryOverride(...)`. `adf-client.ts`'s `base()` (and `adfConfigGate`)
 * consult the active override via {@link currentFactoryOverride}, so every
 * `listPipelines()` / `upsertPipeline()` / `listDatasets()` / … issued during
 * that request targets the SELECTED factory. When no factory is selected the
 * override is undefined and the env default stands (unchanged behaviour).
 *
 * Self-heal safety: the ARM 404/403 → Resource-Graph-by-name self-heal in
 * `adf-client.call()` keys on the ENV-default coords (`isDefaultFactoryUrl`
 * reads process.env directly, NOT this override). When a non-default factory is
 * selected, `base()` builds a non-default URL so self-heal correctly does NOT
 * fire (the selected coords are authoritative). When the selection equals the
 * env default (or is absent), self-heal behaves exactly as before.
 *
 * Server-only (imports node:async_hooks). Never import from a client component.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** A concrete, trimmed selected-factory override (only the coords that were supplied). */
export interface FactoryOverride {
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
}

/** Raw, possibly-empty coordinate input (from query params, item state, a picker). */
export interface FactoryCoordsInput {
  subscriptionId?: string | null;
  resourceGroup?: string | null;
  factoryName?: string | null;
}

const store = new AsyncLocalStorage<FactoryOverride>();

/**
 * Normalize raw coordinate input into a {@link FactoryOverride}, or `undefined`
 * when nothing usable was supplied (so callers fall back to the env default).
 * Only the non-empty coords are carried — a partial selection (e.g. only a
 * factoryName, same subscription/RG as the deployment) is honored, and the
 * absent coords fall through to the env default inside `adf-client`.
 */
export function resolveFactoryOverride(input?: FactoryCoordsInput | null): FactoryOverride | undefined {
  if (!input) return undefined;
  const subscriptionId = (input.subscriptionId || '').trim();
  const resourceGroup = (input.resourceGroup || '').trim();
  const factoryName = (input.factoryName || '').trim();
  if (!subscriptionId && !resourceGroup && !factoryName) return undefined;
  const out: FactoryOverride = {};
  if (subscriptionId) out.subscriptionId = subscriptionId;
  if (resourceGroup) out.resourceGroup = resourceGroup;
  if (factoryName) out.factoryName = factoryName;
  return out;
}

/**
 * Parse the selected-factory coords from a request's query params. The client
 * appends `factorySubscriptionId` / `factoryResourceGroup` / `factoryName` to
 * every factory-scoped `/api/adf/*` call (and to the per-item bind route) when a
 * factory is selected; absent params → `undefined` (env default).
 */
export function factoryOverrideFromSearchParams(sp: URLSearchParams): FactoryOverride | undefined {
  return resolveFactoryOverride({
    subscriptionId: sp.get('factorySubscriptionId'),
    resourceGroup: sp.get('factoryResourceGroup'),
    factoryName: sp.get('factoryName'),
  });
}

/** The override active for the current request (or `undefined` outside a `withFactoryOverride`). */
export function currentFactoryOverride(): FactoryOverride | undefined {
  return store.getStore();
}

/**
 * Run `fn` with `override` active for every `adf-client` call it makes. A
 * falsy/empty override runs `fn` unchanged (env-default path), so wrapping is
 * always safe. AsyncLocalStorage propagates the override across every `await`
 * inside `fn`.
 */
export function withFactoryOverride<T>(override: FactoryOverride | undefined, fn: () => T): T {
  if (!override) return fn();
  return store.run(override, fn);
}

/** Convenience: derive the override from a request and run `fn` inside it. */
export function withFactoryFromRequest<T>(
  req: { nextUrl: { searchParams: URLSearchParams } },
  fn: () => T,
): T {
  return withFactoryOverride(factoryOverrideFromSearchParams(req.nextUrl.searchParams), fn);
}
