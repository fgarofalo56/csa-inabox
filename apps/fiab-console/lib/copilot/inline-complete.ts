/**
 * Server-side helpers for inline code completion (ghost text) deployment
 * resolution.
 *
 * `resolveCompletionTarget()` layers the optional
 * `LOOM_AOAI_COMPLETION_DEPLOYMENT` env var on top of `resolveAoaiTarget()` so a
 * dedicated low-latency / cheaper model (e.g. gpt-4o-mini, gpt-4.1-mini) can
 * serve ghost text WITHOUT consuming the main chat deployment's TPM quota.
 *
 * Honest gate (per no-vaporware.md): when `LOOM_AOAI_COMPLETION_DEPLOYMENT` is
 * unset the function falls back SILENTLY to the chat deployment that the rest of
 * the Copilot uses — never a fabricated/canned completion. If AOAI itself is not
 * configured, `resolveAoaiTarget()`'s `NoAoaiDeploymentError` propagates so the
 * route can emit the precise 503 infra-gate.
 *
 * Azure-native by default (per no-fabric-dependency.md): the underlying target
 * is AOAI on the AI Foundry account — no Fabric / Power BI capacity, no
 * `LOOM_DEFAULT_FABRIC_WORKSPACE` dependency.
 */

import {
  resolveAoaiTarget,
  type AoaiTarget,
} from '@/lib/azure/copilot-orchestrator';

/**
 * Resolve the AOAI target for inline completion (ghost text).
 *
 * Resolution order:
 *   1. `LOOM_AOAI_COMPLETION_DEPLOYMENT` — override ONLY the deployment NAME on
 *      the same endpoint as the chat target (a faster / cheaper model slot).
 *   2. Fallback to the chat deployment (`resolveAoaiTarget()` output).
 *
 * The endpoint + apiVersion are ALWAYS inherited from `resolveAoaiTarget()` —
 * `LOOM_AOAI_COMPLETION_DEPLOYMENT` is a deployment-name override, NOT a separate
 * AOAI account. This keeps the credential chain (cognitiveservices scope, same
 * UAMI) identical to the orchestrator across all sovereign clouds and avoids
 * introducing a second endpoint to manage.
 *
 * @throws NoAoaiDeploymentError (re-thrown from resolveAoaiTarget) when AOAI is
 *   not configured at all — the route turns this into a 503 honest gate.
 */
export async function resolveCompletionTarget(): Promise<AoaiTarget> {
  const base = await resolveAoaiTarget();
  const completionDeployment = process.env.LOOM_AOAI_COMPLETION_DEPLOYMENT?.trim();
  if (completionDeployment) {
    return { ...base, deployment: completionDeployment };
  }
  // No dedicated completion deployment configured — share the chat deployment.
  return base;
}
