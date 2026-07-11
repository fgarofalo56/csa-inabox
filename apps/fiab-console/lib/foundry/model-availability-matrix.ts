/**
 * model-availability-matrix — the Learn-grounded, per-cloud/region source of
 * truth for the BEST-supported Azure OpenAI model per task class (model-strategy
 * M5).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Model availability is **region + version specific**, and Azure Government
 * LAGS Commercial (Foundry-in-Gov currently lists gpt-5 / gpt-5.1 / gpt-5-chat /
 * gpt-4.1; GPT-5.2 reached US Gov Secret/TS; there is NO GPT-5.6 in Gov yet).
 * A deploy — or the runtime resolver — that hard-codes a Commercial frontier
 * model (e.g. GPT-5.6) 404s in a Gov boundary. This matrix encodes, per
 * `(cloud, region)`, an ORDERED preference list per task class (best → floor)
 * so callers can:
 *
 *   1. seed a clean per-cloud deploy with the matrix DEFAULTS ({@link bestModelsFor}), and
 *   2. resolve a configured-but-missing deployment DOWN to a model that is
 *      actually present in the account ({@link ensureDeploymentAvailable}),
 *
 * and NEVER return a model the boundary cannot serve. A fallback is a normal,
 * logged outcome — never an error (PRP §2c "resolve-best-at-deploy + fallback").
 *
 * PURE + TESTABLE: this module has NO Azure-SDK / network dependency. It reads
 * only its arguments, so the matrix and the fallback logic are unit-testable
 * with no credential chain. The RUNTIME wiring (fetching the account's live
 * deployment list + swapping the resolved target) lives in the sibling
 * `model-availability-runtime.ts`, which consults this module.
 *
 * SOURCES (verified against Microsoft Learn — PRP §2a/§2b):
 *   learn.microsoft.com/azure/foundry/openai/how-to/reasoning
 *   .../foundry-models/concepts/models-sold-directly-by-azure
 *   .../models-sold-directly-by-azure-gov
 *   .../models-sold-directly-by-azure-region-availability
 *
 * No Fabric / Power BI models are referenced — every entry is an Azure OpenAI /
 * Foundry model deployable via the Cognitive Services `deployments` PUT
 * (no-fabric-dependency.md).
 */

import type { LoomCloud } from '../azure/cloud-endpoints';

/**
 * The four task keys the matrix resolves. These line up 1:1 with the AIF-12
 * tier router (`model-tier-router.ts`) plus embeddings:
 *   • `chat`   — interactive Copilots (the STANDARD tier; low-latency chat)
 *   • `mini`   — lightweight / high-volume turns (the MINI tier; cheap)
 *   • `strong` — reasoning / planners / build-assist (the STRONG tier)
 *   • `embed`  — RAG index / semantic-search embeddings
 */
export type MatrixTaskKey = 'chat' | 'mini' | 'strong' | 'embed';

/** The BEST-supported model per task key for a resolved `(cloud, region)`. */
export interface BestModels {
  chat: string;
  mini: string;
  strong: string;
  embed: string;
}

/** All four task keys, for iteration. */
export const MATRIX_TASK_KEYS: readonly MatrixTaskKey[] = ['chat', 'mini', 'strong', 'embed'];

/**
 * Last-resort FLOOR per task key — the model every enumerated boundary
 * (Commercial through DoD) is known to serve. `bestModelsFor` / the fallback
 * chain always end here, so a resolver can never emit an unknown model.
 *   • chat / mini / strong → `gpt-4.1` (broadly available incl. Gov; the current
 *     Gov chat default per PRP §2b).
 *   • embed → `text-embedding-ada-002` (v2 — deployable in every boundary).
 */
export const MODEL_FLOOR: BestModels = {
  chat: 'gpt-4.1',
  mini: 'gpt-4.1-mini',
  strong: 'gpt-4.1',
  embed: 'text-embedding-ada-002',
};

/**
 * Per-cloud preference chains (best → fallback → floor). Ordered so the FIRST
 * entry is the aspirational best for the boundary and the LAST is a model the
 * boundary is known to serve. Each chain implicitly ends at {@link MODEL_FLOOR}
 * (appended by {@link modelPreferenceChain}) so a match is always reachable.
 *
 * Grounding (PRP §2b):
 *   • Commercial gets the frontier GPT-5.6 (MS365-Copilot-preferred) + gpt-5-chat
 *     + gpt-4.1-mini + text-embedding-3-large.
 *   • GCC runs on Commercial Azure but with a thinner Foundry catalog — best of
 *     the GPT-5.x actually present, else gpt-4.1.
 *   • GCC-High / DoD lag: gpt-5-chat / gpt-5 / gpt-5.1 (+ gpt-5.2 in DoD, which
 *     reached US Gov Secret/TS) → gpt-4.1; embeddings degrade
 *     text-embedding-3-large → ada-002 where 3-large is absent.
 */
const CLOUD_PREFERENCES: Record<LoomCloud, Record<MatrixTaskKey, readonly string[]>> = {
  Commercial: {
    chat: ['gpt-5-chat', 'gpt-5.6', 'gpt-4.1', 'gpt-4o'],
    mini: ['gpt-4.1-mini', 'gpt-4o-mini'],
    strong: ['gpt-5.6', 'gpt-5.5', 'gpt-5.2', 'gpt-4.1'],
    embed: ['text-embedding-3-large', 'text-embedding-3-small', 'text-embedding-ada-002'],
  },
  GCC: {
    // GCC uses Commercial Azure, but Foundry-in-GCC trails the public catalog.
    chat: ['gpt-5-chat', 'gpt-4.1', 'gpt-4o'],
    mini: ['gpt-4.1-mini', 'gpt-4o-mini'],
    strong: ['gpt-5.1', 'gpt-5', 'gpt-4.1'],
    embed: ['text-embedding-3-large', 'text-embedding-3-small', 'text-embedding-ada-002'],
  },
  'GCC-High': {
    chat: ['gpt-5-chat', 'gpt-4.1'],
    mini: ['gpt-4.1-mini'],
    strong: ['gpt-5.1', 'gpt-5', 'gpt-4.1'],
    embed: ['text-embedding-3-large', 'text-embedding-ada-002'],
  },
  DoD: {
    chat: ['gpt-5-chat', 'gpt-4.1'],
    mini: ['gpt-4.1-mini'],
    // GPT-5.2 reached US Gov Secret / Top Secret (PRP §2b).
    strong: ['gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-4.1'],
    embed: ['text-embedding-3-large', 'text-embedding-ada-002'],
  },
};

/**
 * Region-specific overrides layered OVER the cloud default. Availability is
 * region + version specific (PRP §2b), so a leaner Gov region can pin a more
 * conservative chain than its cloud default. Keyed by NORMALISED region
 * (`normalizeRegion`). Partial — any task key absent here inherits the cloud
 * chain.
 *
 * `usgovvirginia` is the primary, richest Azure Gov region — it keeps the full
 * GCC-High chain. `usgovarizona` trails it (a smaller Foundry footprint), so its
 * embeddings realistically resolve to ada-002 and its strong tier to gpt-5 →
 * gpt-4.1. These are conservative defaults; the RUNTIME availability check
 * (`ensureDeploymentAvailable`) always has the final say against what is truly
 * deployed.
 */
const REGION_OVERRIDES: Record<string, Partial<Record<MatrixTaskKey, readonly string[]>>> = {
  usgovarizona: {
    strong: ['gpt-5', 'gpt-4.1'],
    embed: ['text-embedding-ada-002', 'text-embedding-3-large'],
  },
};

/** Normalise a region to the matrix key form: lower-case, no whitespace. */
export function normalizeRegion(region: string | undefined | null): string {
  return String(region ?? '').replace(/\s+/g, '').toLowerCase();
}

/** Case-insensitive de-duplicating append that preserves order (first wins). */
function dedupe(models: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of models) {
    const k = m.trim().toLowerCase();
    if (!m.trim() || seen.has(k)) continue;
    seen.add(k);
    out.push(m.trim());
  }
  return out;
}

/**
 * The ORDERED preference chain (best → floor) for a `(cloud, region, key)`.
 * Region overrides layer over the cloud default; the {@link MODEL_FLOOR} for
 * the key is always appended so the chain never dead-ends. De-duplicated,
 * order-preserving. An unknown cloud falls back to Commercial; an unknown
 * region simply uses the cloud default.
 *
 * This is the single ordering both {@link bestModelsFor} (takes the head) and
 * {@link ensureDeploymentAvailable} (walks the tail) rely on.
 */
export function modelPreferenceChain(
  cloud: LoomCloud,
  region: string | undefined,
  key: MatrixTaskKey,
): string[] {
  const cloudChain = (CLOUD_PREFERENCES[cloud] ?? CLOUD_PREFERENCES.Commercial)[key];
  const override = REGION_OVERRIDES[normalizeRegion(region)]?.[key];
  return dedupe([...(override ?? cloudChain), MODEL_FLOOR[key]]);
}

/**
 * The BEST-supported model per task key for a `(cloud, region)` — the head of
 * each preference chain. This is the source of truth a clean per-cloud deploy
 * (and the tier-config bootstrap) seeds its defaults from. Never returns an
 * unknown model (the chains are static and floor-terminated).
 *
 * NOTE: "best" here is the aspirational per-boundary default. It is what a
 * deploy would ATTEMPT; the runtime {@link ensureDeploymentAvailable} then
 * degrades it to whatever is actually present so a lagging region never 404s.
 */
export function bestModelsFor(cloud: LoomCloud, region?: string): BestModels {
  return {
    chat: modelPreferenceChain(cloud, region, 'chat')[0],
    mini: modelPreferenceChain(cloud, region, 'mini')[0],
    strong: modelPreferenceChain(cloud, region, 'strong')[0],
    embed: modelPreferenceChain(cloud, region, 'embed')[0],
  };
}

// ── Runtime availability resolution (still pure — takes the live list in) ─────

/**
 * A model deployment as reported by the Cognitive Services `deployments` REST
 * surface (see `foundry-cs-client.ModelDeployment`). We match on BOTH the
 * deployment `name` (what the AOAI URL path uses) and the underlying
 * `modelName` (what the matrix chains are expressed in), because a deployment
 * is often named for its model but need not be.
 */
export interface AvailableDeployment {
  name: string;
  modelName?: string;
}

/** The outcome of an availability resolution. */
export interface DeploymentAvailabilityResult {
  /** The deployment NAME to actually call (URL path segment). */
  deployment: string;
  /** True when a usable deployment (configured or a matrix fallback) was found. */
  available: boolean;
  /** True only when we degraded AWAY from `configured` to a matrix fallback. */
  fallback: boolean;
  /** The matrix model the fallback resolved to (its `modelName`), for the receipt. */
  fallbackModel?: string;
  /** Honest, human-readable explanation — set when nothing usable was found. */
  reason?: string;
}

/** Normalise a mixed string|object deployment list to `AvailableDeployment[]`. */
function normalizeDeployments(
  list: readonly (string | AvailableDeployment)[],
): AvailableDeployment[] {
  return (list ?? [])
    .map((d) => (typeof d === 'string' ? { name: d } : d))
    .filter((d): d is AvailableDeployment => !!d && !!d.name);
}

/**
 * Find the deployment whose `name` OR `modelName` matches `target`
 * (case-insensitive). Returns the deployment NAME to call, or undefined.
 */
function findDeployment(
  target: string,
  deployments: readonly AvailableDeployment[],
): AvailableDeployment | undefined {
  const t = target.trim().toLowerCase();
  if (!t) return undefined;
  return deployments.find(
    (d) => d.name.trim().toLowerCase() === t || (d.modelName ?? '').trim().toLowerCase() === t,
  );
}

/**
 * Resolve a configured deployment against the account's ACTUAL deployments,
 * degrading gracefully to the best matrix model that IS present — so a
 * configured-but-undeployed model (the Gov-lag 404 class) never reaches the
 * data plane.
 *
 * Resolution:
 *   1. If `configured` is present (by deployment name or model name) → use it
 *      as-is (`available:true, fallback:false`). The happy path — no change.
 *   2. Else walk the `(cloud, region, key)` preference chain (best → floor) and
 *      return the FIRST chain model that is deployed (`fallback:true`,
 *      `fallbackModel` set for the deploy/log receipt).
 *   3. Else — nothing in the chain is deployed — return an honest signal
 *      (`available:false`, `reason` set) and leave `configured` unchanged so the
 *      caller's existing honest 404/503 gate still fires. NEVER invents a model.
 *
 * Pure: depends only on its arguments. `availableDeployments` may be a list of
 * deployment names (strings) or `{name, modelName}` objects.
 */
export function ensureDeploymentAvailable(
  configured: string,
  availableDeployments: readonly (string | AvailableDeployment)[],
  cloud: LoomCloud,
  region: string | undefined,
  key: MatrixTaskKey = 'chat',
): DeploymentAvailabilityResult {
  const deployments = normalizeDeployments(availableDeployments);
  const cfg = (configured ?? '').trim();

  // No deployment list to check against → trust the configured value (the
  // runtime layer treats an empty list as "unknown", never as "nothing works").
  if (deployments.length === 0) {
    return { deployment: cfg, available: !!cfg, fallback: false };
  }

  // 1. Configured deployment is actually present → use it unchanged.
  if (cfg) {
    const hit = findDeployment(cfg, deployments);
    if (hit) return { deployment: hit.name, available: true, fallback: false };
  }

  // 2. Degrade to the best matrix model that IS deployed.
  const chain = modelPreferenceChain(cloud, region, key);
  for (const model of chain) {
    const hit = findDeployment(model, deployments);
    if (hit) {
      return {
        deployment: hit.name,
        available: true,
        fallback: true,
        fallbackModel: hit.modelName ?? model,
        reason:
          `Configured ${key} deployment "${cfg || '(none)'}" is not deployed in ${cloud}` +
          `${region ? `/${normalizeRegion(region)}` : ''}; resolved to supported model "${model}" ` +
          `(deployment "${hit.name}").`,
      };
    }
  }

  // 3. Nothing usable — honest signal; leave configured for the caller's gate.
  return {
    deployment: cfg,
    available: false,
    fallback: false,
    reason:
      `No supported ${key} model from the availability matrix is deployed in ${cloud}` +
      `${region ? `/${normalizeRegion(region)}` : ''}. Deploy one of: ` +
      `${modelPreferenceChain(cloud, region, key).join(' → ')}.`,
  };
}
