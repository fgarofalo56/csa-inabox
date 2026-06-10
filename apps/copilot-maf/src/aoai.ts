/**
 * Gov AOAI direct client. Mirrors `callAoai()` in the Console's
 * copilot-orchestrator.ts exactly — same chat-completions URL shape, same
 * temperature-then-retry-without behaviour for reasoning models — but resolves
 * the target purely from env (no Foundry hub discovery, which is the whole point
 * of the MAF tier in Gov).
 */
import { credential } from './credential.js';
import { cogScope } from './cloud-scope.js';
import type { ChatMessage } from './types.js';

export interface AoaiTarget {
  endpoint: string;
  deployment: string;
  apiVersion: string;
}

/** Resolve the AOAI chat target from env — no hub discovery. */
export function resolveAoaiTargetFromEnv(): AoaiTarget {
  const endpoint = (process.env.LOOM_AOAI_ENDPOINT || '').replace(/\/+$/, '');
  const deployment = process.env.LOOM_AOAI_DEPLOYMENT || '';
  const apiVersion = process.env.LOOM_AOAI_API_VERSION || '2024-10-21';
  if (!endpoint || !deployment) {
    throw new Error(
      'MAF tier requires LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT (Gov AOAI direct, no Foundry-hub discovery).',
    );
  }
  return { endpoint, deployment, apiVersion };
}

let _token: { value: string; exp: number } | null = null;

async function aoaiToken(): Promise<string> {
  const now = Date.now();
  if (_token && _token.exp - 60_000 > now) return _token.value;
  const t = await credential.getToken(cogScope());
  if (!t?.token) throw new Error('Failed to acquire AOAI token (cognitiveservices.azure.us)');
  _token = { value: t.token, exp: t.expiresOnTimestamp ?? now + 5 * 60_000 };
  return _token.value;
}

/**
 * True when an AOAI 400 body is the "this model only supports the default
 * temperature" rejection newer reasoning models emit. Same heuristic as the
 * Console orchestrator so both tiers behave identically across model families.
 */
export function isUnsupportedSamplingParam(body: string): boolean {
  return (
    /unsupported_value|does not support|Only the default \(1\) value is supported/i.test(body) &&
    /temperature|top_p/i.test(body)
  );
}

export async function callAoai(
  target: AoaiTarget,
  messages: ChatMessage[],
  tools: unknown[],
): Promise<any> {
  const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(target.deployment)}/chat/completions?api-version=${target.apiVersion}`;
  const token = await aoaiToken();
  const base: Record<string, unknown> = { messages };
  if (tools.length > 0) {
    base.tools = tools;
    base.tool_choice = 'auto';
  }

  const send = (withTemperature: boolean) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(withTemperature ? { ...base, temperature: 0.2 } : base),
    });

  let res = await send(true);
  if (res.status === 400) {
    const t = await res.text();
    if (isUnsupportedSamplingParam(t)) {
      res = await send(false);
    } else {
      throw new Error(`AOAI chat-completions failed 400: ${t.slice(0, 400)}`);
    }
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AOAI chat-completions failed ${res.status}: ${t.slice(0, 400)}`);
  }
  return res.json();
}
