/**
 * Policy analysis (ADR-003): parse in memory -> SHA-256 digest + redacted facets.
 * The XML is never returned, stored or logged. Pure.
 */
import { createHash } from 'node:crypto';
import type { PolicyAnalysis, PolicyFacets } from './types';

/** Structural wrappers; never counted as policy elements. */
const STRUCTURAL = new Set(['policies', 'fragment', 'inbound', 'backend', 'outbound', 'on-error', 'base', 'choose', 'when', 'otherwise']);

const AUTH = new Set([
  'validate-jwt', 'validate-azure-ad-token', 'authentication-managed-identity', 'authentication-basic',
  'authentication-certificate', 'check-header', 'validate-client-certificate',
]);
const LIMIT = new Set(['rate-limit', 'rate-limit-by-key', 'quota', 'quota-by-key', 'llm-token-limit', 'azure-openai-token-limit']);
const LLM = new Set([
  'llm-token-limit', 'llm-emit-token-metric', 'llm-semantic-cache-lookup', 'llm-semantic-cache-store',
  'azure-openai-token-limit', 'azure-openai-emit-token-metric', 'azure-openai-semantic-cache-lookup', 'azure-openai-semantic-cache-store',
]);
/** Recognised, modelled elements. Anything else (outside STRUCTURAL) is externally authored. */
const KNOWN = new Set([
  ...AUTH, ...LIMIT, ...LLM,
  'set-backend-service', 'include-fragment', 'set-header', 'forward-request', 'retry', 'trace', 'metadata', 'message',
  'cors', 'ip-filter', 'set-variable', 'return-response', 'rewrite-uri', 'set-query-parameter', 'dimension',
  'audiences', 'audience', 'issuer-signing-keys', 'openid-config', 'required-claims', 'claim', 'value',
  'mock-response', 'cache-lookup', 'cache-store', 'find-and-replace', 'send-request',
]);

/** scheme://host[:port]/path with userinfo, query and fragment removed; undefined when not an absolute http(s) URL. */
export function redactUrl(raw: string): { url: string; host: string } | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    const path = u.pathname === '/' ? '' : u.pathname;
    return { url: `${u.protocol}//${u.host}${path}`, host: u.hostname.toLowerCase() };
  } catch {
    return undefined;
  }
}

interface Tag { name: string; attrs: Record<string, string> }

function* tags(xml: string): Generator<Tag> {
  // Re-apply until stable: one pass over `<!<!-- -->--` leaves a fresh comment behind (CodeQL js/incomplete-multi-character-sanitization).
  let stripped = xml;
  for (let prev = ''; prev !== stripped; ) {
    prev = stripped;
    stripped = stripped.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  }
  const re = /<([A-Za-z][\w.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const attrs: Record<string, string> = {};
    const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    while ((a = ar.exec(m[2] ?? ''))) attrs[a[1]] = a[2] ?? a[3] ?? '';
    yield { name: m[1], attrs };
  }
}

const num = (s: string | undefined): number | undefined => {
  if (s === undefined || !/^\d+$/.test(s.trim())) return undefined;
  return Number(s.trim());
};

export function analyzePolicy(xml: string): PolicyAnalysis {
  const facets: PolicyFacets = {
    backendHosts: [], backendUrls: [], authMethods: [], limits: [], includedFragments: [], elements: {}, llm: false,
  };
  const external = new Map<string, number>();
  const hosts = new Set<string>();
  const urls = new Set<string>();
  const auth = new Set<string>();
  const frags = new Set<string>();
  for (const t of tags(xml)) {
    if (STRUCTURAL.has(t.name)) continue;
    if (!KNOWN.has(t.name)) {
      external.set(t.name, (external.get(t.name) ?? 0) + 1);
      continue;
    }
    facets.elements[t.name] = (facets.elements[t.name] ?? 0) + 1;
    if (LLM.has(t.name)) facets.llm = true;
    if (AUTH.has(t.name)) auth.add(t.name);
    if (LIMIT.has(t.name)) {
      facets.limits.push({
        element: t.name,
        calls: num(t.attrs['calls']),
        tokensPerMinute: num(t.attrs['tokens-per-minute']),
        renewalPeriod: num(t.attrs['renewal-period']),
      });
    }
    if (t.name === 'include-fragment' && t.attrs['fragment-id']) frags.add(t.attrs['fragment-id']);
    if (t.name === 'set-backend-service' || t.name === 'send-request') {
      const raw = t.attrs['base-url'] ?? t.attrs['url'];
      const r = raw ? redactUrl(raw) : undefined;
      if (r) { hosts.add(r.host); urls.add(r.url); }
    }
  }
  facets.backendHosts = [...hosts].sort();
  facets.backendUrls = [...urls].sort();
  facets.authMethods = [...auth].sort();
  facets.includedFragments = [...frags].sort();
  return {
    sha256: createHash('sha256').update(xml).digest('hex'),
    facets,
    externallyAuthored: [...external.values()].reduce((a, b) => a + b, 0),
    externalElementNames: [...external.keys()].sort(),
  };
}
