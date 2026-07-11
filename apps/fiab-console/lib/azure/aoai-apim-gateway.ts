/**
 * aoai-apim-gateway — pure routing helper for the OPT-IN APIM AI-gateway (M4).
 *
 * Model-strategy M4 ships an APIM GenAI gateway for Azure OpenAI traffic
 * (token-limit / load-balance / circuit-breaker / optional semantic cache), but
 * it is **OPT-IN, default OFF** pending operator confirmation of the APIM
 * direction. Until it is flipped on, every AOAI call hits the cognitiveservices
 * endpoint DIRECTLY, byte-identical to before this wave.
 *
 * This module is the single, network-free decision point that both the unified
 * client (aoai-chat-client) and the orchestrator's inline call path
 * (copilot-orchestrator) consult:
 *
 *   • `LOOM_AOAI_VIA_APIM=true` AND `LOOM_AOAI_APIM_URL=<gateway>` →
 *     route through the APIM gateway (`endpoint` swapped to the gateway URL; the
 *     client's existing `${endpoint}/openai/deployments/<dep>/…` path lands on
 *     the gateway's `openai` API, whose backend forwards to the real AOAI with
 *     managed-identity auth). An APIM subscription key is attached when
 *     `LOOM_AOAI_APIM_SUBSCRIPTION_KEY` is set; otherwise the managed-identity
 *     bearer already on the request suffices (the gateway is internal-VNet only).
 *   • Anything else (the DEFAULT) → hit the resolved cognitiveservices endpoint
 *     directly, exactly as today.
 *
 * **Gov direct-with-MI fallback:** the LLM policies (llm-token-limit,
 * llm-semantic-cache-*) may be absent in sovereign APIM, so a Gov gateway can be
 * unreachable / not-authored even with the flag on. A caller that observes the
 * APIM attempt fail re-resolves with `apimAvailable:false`, which forces the
 * direct-with-managed-identity path — same real backend, no feature regression.
 *
 * Pure + deterministic: `resolveAoaiCallTarget` reads only its `base` + `env`
 * (defaulting to `process.env`) so the routing decision is unit-testable with no
 * network and no Azure SDK.
 */

import type { AoaiTarget } from './copilot-orchestrator';

/** APIM subscription-key request header. */
export const APIM_SUBSCRIPTION_KEY_HEADER = 'Ocp-Apim-Subscription-Key';

/**
 * The concrete AOAI call target after the APIM routing decision. Shares
 * `endpoint`/`deployment`/`apiVersion` with {@link AoaiTarget} so it is a
 * drop-in for `chatUrl(...)` / the embeddings URL builder — when routed,
 * `endpoint` is the APIM gateway URL; otherwise it is the direct AOAI endpoint.
 */
export interface AoaiCallTarget {
  endpoint: string;
  deployment: string;
  apiVersion: string;
  /** True when routing through the APIM gateway; false on the direct path. */
  viaApim: boolean;
  /** APIM subscription key to attach (only when routed AND a key is configured). */
  subscriptionKey?: string;
}

export interface ResolveAoaiCallOpts {
  /** Environment source (defaults to `process.env`). Injected for tests. */
  env?: Record<string, string | undefined>;
  /**
   * Runtime availability of the APIM gateway. Defaults to `true`. A caller that
   * saw the APIM attempt fail (Gov — LLM policies absent / gateway down)
   * re-resolves with `false` to force the direct-with-managed-identity fallback.
   */
  apimAvailable?: boolean;
}

/** True when the flag is the literal string `'true'` (case-insensitive). */
function flagOn(v: string | undefined): boolean {
  return String(v ?? '').trim().toLowerCase() === 'true';
}

/**
 * Decide whether an AOAI call routes through the APIM gateway or hits the AOAI
 * endpoint directly. Pure — no network, no side effects.
 *
 * Routes via APIM only when ALL hold:
 *   1. `LOOM_AOAI_VIA_APIM=true`
 *   2. `LOOM_AOAI_APIM_URL` is a non-empty gateway URL
 *   3. `opts.apimAvailable !== false` (the Gov runtime fallback switch)
 *
 * Otherwise returns the direct target unchanged (byte-identical to the pre-M4
 * path). When routed and `LOOM_AOAI_APIM_SUBSCRIPTION_KEY` is set, the key is
 * carried on the result for {@link aoaiApimHeaders}.
 */
export function resolveAoaiCallTarget(base: AoaiTarget, opts: ResolveAoaiCallOpts = {}): AoaiCallTarget {
  const env = opts.env ?? process.env;
  const via = flagOn(env.LOOM_AOAI_VIA_APIM);
  const apimUrl = String(env.LOOM_AOAI_APIM_URL ?? '').trim().replace(/\/+$/, '');
  const available = opts.apimAvailable !== false;

  if (via && apimUrl && available) {
    const key = String(env.LOOM_AOAI_APIM_SUBSCRIPTION_KEY ?? '').trim();
    return {
      endpoint: apimUrl,
      deployment: base.deployment,
      apiVersion: base.apiVersion,
      viaApim: true,
      ...(key ? { subscriptionKey: key } : {}),
    };
  }

  // DEFAULT (and the direct-with-MI fallback): the resolved AOAI endpoint, unchanged.
  return {
    endpoint: base.endpoint,
    deployment: base.deployment,
    apiVersion: base.apiVersion,
    viaApim: false,
  };
}

/**
 * Extra request headers for a resolved call target — the APIM subscription-key
 * header when routing through the gateway with a key configured; an empty object
 * on the direct path (so the direct request is byte-identical to before M4).
 * The managed-identity `Authorization` bearer is added by the caller and works
 * on BOTH paths (the gateway's authentication-managed-identity policy re-auths to
 * the backend).
 */
export function aoaiApimHeaders(call: AoaiCallTarget): Record<string, string> {
  return call.viaApim && call.subscriptionKey
    ? { [APIM_SUBSCRIPTION_KEY_HEADER]: call.subscriptionKey }
    : {};
}
