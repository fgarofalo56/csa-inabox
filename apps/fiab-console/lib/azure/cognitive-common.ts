/**
 * cognitive-common — shared Entra-auth plumbing for the Azure AI (Cognitive
 * Services) data-plane clients used by the AI-enrichment pipeline activities
 * (doc-intelligence / vision / language / translator).
 *
 * Every client here follows the SAME proven pattern as
 * `lib/azure/foundry-cs-client.ts` / `foundry-client.ts` (Content Safety):
 *   - token via the shared `loomServerCredential` chain
 *     (AcaManagedIdentity → ManagedIdentity → DefaultAzureCredential)
 *   - the sovereign-cloud-correct Cognitive Services audience from
 *     `cogScope()` (Commercial `cognitiveservices.azure.com`, Gov
 *     `cognitiveservices.azure.us`) — NO hard-coded audience
 *   - an honest not-configured gate (`CognitiveNotConfiguredError`) naming the
 *     exact env var + the bicep module that provisions the account, per
 *     .claude/rules/no-vaporware.md — never a mock, never a silent fallback.
 *
 * No Fabric / Power BI host is ever contacted (no-fabric-dependency.md): these
 * are pure Azure Cognitive Services data-plane REST calls.
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { loomServerCredential } from '@/lib/azure/aca-managed-identity';
import { cogScope } from './cloud-endpoints';

/**
 * Thrown when the endpoint env var for a cognitive service is unset. Carries
 * the exact env var + a remediation hint so the BFF route can surface an honest
 * MessageBar (naming the var + the bicep module) instead of a fake result.
 */
export class CognitiveNotConfiguredError extends Error {
  service: string;
  envVar: string;
  hint: string;
  constructor(service: string, envVar: string, hint: string) {
    super(`${service} is not configured in this deployment (set ${envVar}).`);
    this.name = 'CognitiveNotConfiguredError';
    this.service = service;
    this.envVar = envVar;
    this.hint = hint;
  }
}

/** Thrown on a non-OK cognitive data-plane response. */
export class CognitiveError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `Cognitive Services call failed (${status})`);
    this.name = 'CognitiveError';
    this.status = status;
    this.body = body;
  }
}

/** Acquire a Cognitive Services data-plane bearer token (sovereign-aware). */
export async function cognitiveToken(): Promise<string> {
  const t = await loomServerCredential.getToken(cogScope());
  if (!t?.token) throw new Error('Failed to acquire a Cognitive Services access token.');
  return t.token;
}

/**
 * Env vars carrying the SHARED multi-service Azure AI Services (Foundry) account
 * endpoint — the default-ON fallback for any single AI-enrichment service whose
 * dedicated endpoint var is unset. An AIServices-kind account serves Document
 * Intelligence, Vision, Language, Translator, and Content Safety on the SAME
 * cognitiveservices.* host, so the enrichment activities stay 100% functional
 * against it (this is exactly the endpoint bicep derives the per-service vars
 * from — `loomAiEnrichEndpoint`). LOOM_AOAI_ENDPOINT is preferred: it is the
 * cognitiveservices.azure.* host that carries the classic data-plane paths
 * (`/formrecognizer`, `/vision`, `/language`, `/translator`, `/contentsafety`).
 * Per loom_default_on_opt_out the feature is ON via this fallback — no Fabric,
 * no Power BI, pure Azure Cognitive Services (no-fabric-dependency.md).
 */
export const AI_SERVICES_FALLBACK_ENVS = [
  'LOOM_AOAI_ENDPOINT',
  'LOOM_FOUNDRY_ENDPOINT',
  'LOOM_FOUNDRY_PROJECT_ENDPOINT',
] as const;

/** First non-empty env value among `vars`, trimmed + trailing-slash-stripped. */
export function firstEnvEndpoint(vars: readonly string[]): string | null {
  for (const v of vars) {
    const raw = process.env[v];
    if (raw && raw.trim()) return raw.trim().replace(/\/+$/, '');
  }
  return null;
}

/**
 * Resolve + normalise a cognitive-service endpoint from an env var. When the
 * dedicated endpoint var is unset, fall back to the shared multi-service Azure AI
 * Services (Foundry) account (default-ON / opt-out — the activity still runs).
 * Only when NEITHER is configured do we throw an honest not-configured gate.
 * Strips any trailing slash so callers can append a path unconditionally.
 */
export function resolveCognitiveEndpoint(
  envVar: string,
  service: string,
  example: string,
  fallbackEnvVars: readonly string[] = AI_SERVICES_FALLBACK_ENVS,
): string {
  const ep = process.env[envVar];
  if (ep && ep.trim()) return ep.trim().replace(/\/+$/, '');
  const shared = firstEnvEndpoint(fallbackEnvVars);
  if (shared) return shared;
  throw new CognitiveNotConfiguredError(
    service,
    envVar,
    `Set ${envVar} to a deployed ${service} resource endpoint (e.g. ${example}), ` +
      `or deploy the shared Azure AI Services account (${fallbackEnvVars.join(' / ')}) it falls back to. ` +
      `Provision a dedicated account via platform/fiab/bicep/modules/deploy-planner/cognitive-account.bicep ` +
      `(Entra-only, custom subdomain) and grant the Console UAMI "Cognitive Services User".`,
  );
}

/** Parse a cognitive data-plane JSON response, throwing CognitiveError on failure. */
export async function readCognitiveJson<T>(res: Response, service: string): Promise<T> {
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const msg =
      (parsed as any)?.error?.message ||
      (typeof parsed === 'string' ? parsed : `${service} call failed (${res.status})`);
    throw new CognitiveError(res.status, parsed, `${service}: ${String(msg).slice(0, 280)}`);
  }
  return (parsed as T) ?? ({} as T);
}

/** Re-export the shared fetch so clients import the whole surface from here. */
export { fetchWithTimeout };
