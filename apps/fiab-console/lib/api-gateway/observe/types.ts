/**
 * API Gateway Plane - observed inventory documents (W1-3).
 *
 * Stored in `apiplane-observed` (PK /tenantId). Nothing here ever holds policy
 * XML, subscription keys, named-value values or user e-mail addresses
 * (ADR-003, SECURITY-AND-COMPLIANCE redaction rules).
 */
import type { ApiplaneDoc } from '../types';

export const OBSERVED_TYPES = [
  'api', 'operation', 'product', 'subscription', 'user', 'group', 'backend', 'namedValue', 'mcp', 'fragment',
] as const;
export type ObservedType = (typeof OBSERVED_TYPES)[number];

export interface PolicyFacets {
  /** Hosts only (no scheme/port/path/query/fragment): the redacted backend facet. */
  backendHosts: string[];
  /** Backend URLs reduced to scheme://host[:port]/path; query, fragment and userinfo removed. */
  backendUrls: string[];
  authMethods: string[];
  limits: Array<{ element: string; calls?: number; tokensPerMinute?: number; renewalPeriod?: number }>;
  includedFragments: string[];
  /** Counts of each recognised element. */
  elements: Record<string, number>;
  llm: boolean;
}

export interface PolicyAnalysis {
  /** SHA-256 of the raw policy text. The text itself is discarded. */
  sha256: string;
  facets: PolicyFacets;
  /** Elements the parser does not model: shown as "externally authored", never hidden. */
  externallyAuthored: number;
  externalElementNames: string[];
}

export type DetectionSelection = 'detected' | 'manual';

export interface AiSurface {
  selection: DetectionSelection;
  /** e.g. 'azure-openai', 'llm-policy'. */
  kinds: string[];
  reasons: string[];
}

export interface ObservedDoc extends ApiplaneDoc {
  docType: `observed:${ObservedType}`;
  gatewayId: string;
  observedType: ObservedType;
  /** The APIM resource name (not a secret). */
  name: string;
  displayName?: string;
  observedAt: string;
  /** Type-specific redacted metadata. */
  props: Record<string, unknown>;
  policyAnalysis?: PolicyAnalysis;
  aiSurface?: AiSurface;
  mcp?: { selection: DetectionSelection; url?: string };
}

/** Result of listing one type: `complete=false` means a page failed or a nextLink was not followed. */
export interface TypeListing {
  items: Array<Record<string, unknown>>;
  complete: boolean;
  error?: string;
}

export type McpListing =
  | ({ status: 'ok' } & TypeListing)
  | { status: 'unavailable'; reason: string };

/** Reads one gateway. Production = ARM; tests = recorded doubles. */
export interface ObserveSource {
  list(type: Exclude<ObservedType, 'mcp' | 'operation' | 'fragment'>): Promise<TypeListing>;
  operations(apiName: string): Promise<TypeListing>;
  fragments(): Promise<TypeListing>;
  mcpApis(): Promise<McpListing>;
  /** API-scope policy text, or null when none; throws on failure. */
  apiPolicy(apiName: string): Promise<string | null>;
}
