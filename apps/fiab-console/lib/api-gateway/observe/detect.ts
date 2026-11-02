/** AI-surface and MCP detection (W1-3). `manual` selections are never overwritten by a sync. */
import type { AiSurface, PolicyAnalysis } from './types';

const AI_HOSTS = [/\.openai\.azure\.(com|us)$/i, /\.cognitiveservices\.azure\.(com|us)$/i, /\.services\.ai\.azure\.(com|us)$/i];

export function detectAiSurface(input: {
  serviceUrl?: string;
  path?: string;
  backendHosts?: string[];
  policy?: PolicyAnalysis;
}): AiSurface | undefined {
  const kinds = new Set<string>();
  const reasons: string[] = [];
  const hosts = [...(input.backendHosts ?? []), ...(input.policy?.facets.backendHosts ?? [])];
  if (input.serviceUrl) {
    try { hosts.push(new URL(input.serviceUrl).hostname); } catch { /* not a URL: contributes nothing */ }
  }
  const aiHost = hosts.find((h) => AI_HOSTS.some((r) => r.test(h)));
  if (aiHost) { kinds.add('azure-openai'); reasons.push(`backend host ${aiHost}`); }
  if (input.path && /(^|\/)openai(\/|$)/i.test(input.path)) { kinds.add('azure-openai'); reasons.push('path contains /openai'); }
  if (input.policy?.facets.llm) { kinds.add('llm-policy'); reasons.push('policy uses an llm-/azure-openai- element'); }
  if (kinds.size === 0) return undefined;
  return { selection: 'detected', kinds: [...kinds].sort(), reasons };
}

/** Keep a manual selection from the previously stored document; otherwise use the fresh detection. */
export function mergeSelection<T extends { selection: 'detected' | 'manual' }>(prior: T | undefined, detected: T | undefined): T | undefined {
  if (prior?.selection === 'manual') return prior;
  return detected;
}
