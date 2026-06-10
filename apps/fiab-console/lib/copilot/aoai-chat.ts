/**
 * aoai-chat — one-shot Azure OpenAI chat-completion helper shared by Loom's
 * server-side Copilot tool surfaces (DAX Copilot, the semantic-model
 * model-structure Copilot, …).
 *
 * It centralises:
 *   - the UAMI-first credential chain (ManagedIdentity → Default),
 *   - cloud-aware AOAI token scope (cogScope — cognitiveservices.azure.us in Gov),
 *   - the per-tenant AOAI target resolution (admin config → env → Foundry
 *     discovery) via the orchestrator's resolveAoaiTarget,
 *   - the reasoning-model temperature retry quirk.
 *
 * ZERO Power BI / Fabric REST — this is purely the AOAI data-plane. Imports of
 * copilot-orchestrator / copilot-config-store are dynamic to avoid a static
 * import cycle (the orchestrator statically pulls in the DAX tools, which in
 * turn use this helper).
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';

import { cogScope } from '@/lib/azure/cloud-endpoints';
import type { AoaiTarget } from '@/lib/azure/copilot-orchestrator';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

/** Acquire an AAD bearer token for the AOAI cognitive-services scope. */
export async function aoaiToken(): Promise<string> {
  const t = await credential.getToken(cogScope());
  if (!t?.token) throw new Error('Failed to acquire an AOAI token.');
  return t.token;
}

/**
 * Resolve the AOAI chat target for a caller. Loads the tenant's admin-selected
 * Copilot config (account + deployment) and feeds it to the orchestrator's
 * resolver, which falls back to env / Foundry discovery. Dynamic import breaks
 * the static cycle with copilot-orchestrator.
 */
export async function getAoaiTarget(userOid: string): Promise<AoaiTarget> {
  const [{ resolveAoaiTarget }, { loadTenantCopilotConfig }] = await Promise.all([
    import('@/lib/azure/copilot-orchestrator'),
    import('@/lib/azure/copilot-config-store'),
  ]);
  const cfg = await loadTenantCopilotConfig(userOid).catch(() => null);
  return resolveAoaiTarget(cfg);
}

export interface AoaiChatOpts {
  maxTokens?: number;
  temperature?: number;
  jsonObject?: boolean;
}

/**
 * One-shot AOAI chat completion (no tools). Cloud-portable via getAoaiTarget.
 * Returns the assistant message content (trimmed). Throws on a non-retryable
 * error so callers can surface a precise message.
 */
export async function aoaiChat(
  userOid: string,
  system: string,
  user: string,
  opts: AoaiChatOpts = {},
): Promise<string> {
  const target = await getAoaiTarget(userOid);
  const token = await aoaiToken();
  const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(target.deployment)}/chat/completions?api-version=${target.apiVersion}`;
  const payload: Record<string, unknown> = {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: opts.maxTokens ?? 400,
  };
  if (opts.temperature !== undefined) payload.temperature = opts.temperature;
  if (opts.jsonObject) payload.response_format = { type: 'json_object' };

  const send = (body: Record<string, unknown>) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

  let res = await send(payload);
  // Newer reasoning models reject a non-default temperature — retry without it.
  if (res.status === 400 && opts.temperature !== undefined) {
    const t = await res.text();
    if (/temperature|top_p|unsupported_value|does not support/i.test(t)) {
      const { temperature, ...rest } = payload;
      res = await send(rest);
    } else {
      throw new Error(`AOAI chat failed 400: ${t.slice(0, 300)}`);
    }
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AOAI chat failed ${res.status}: ${t.slice(0, 300)}`);
  }
  const body = await res.json();
  return String(body?.choices?.[0]?.message?.content ?? '').trim();
}
