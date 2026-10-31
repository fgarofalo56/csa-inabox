/**
 * Advisory findings (ADR-008 decision 8). Findings never block. They report
 * blocked pairings that exist in APIM OUTSIDE the plane's publications.
 *
 * Structured for W2: a producer is one function returning Finding[]; W2 adds a
 * producer for backend / API URLs vs registered endpoints and appends it to
 * `producers` in runFindings(). Today there is one producer: gateway MCP
 * servers matching registered MCP endpoints.
 */
import { permits, type PermitsSettings } from './permits';
import type { ClassifiableResource, ResourceKind } from './types';

export interface Finding {
  id: string;
  /** Stable producer id, e.g. 'gateway-mcp'; W2 adds 'backend-url'. */
  producer: string;
  severity: 'advisory';
  gatewayId: string;
  gatewayName: string;
  resourceKind: ResourceKind;
  resourceId: string;
  resourceName: string;
  message: string;
}

/** An MCP server observed on a gateway (from W1-3 inventory). */
export interface GatewayMcpServer { gatewayId: string; serverId: string; name: string; url: string }

export interface FindingsInput {
  gateways: readonly ClassifiableResource[];
  mcpEndpoints: readonly (ClassifiableResource & { url: string })[];
  gatewayMcpServers: readonly GatewayMcpServer[];
  settings: PermitsSettings;
}

export type FindingProducer = (input: FindingsInput) => Finding[];

/** Scheme, host and path compared case-insensitively; query, fragment and trailing slash ignored. */
export function normalizeUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return undefined;
  }
}

export const gatewayMcpProducer: FindingProducer = (input) => {
  const gateways = new Map(input.gateways.map((g) => [g.id, g]));
  const byUrl = new Map<string, ClassifiableResource & { url: string }>();
  for (const e of input.mcpEndpoints) {
    const n = normalizeUrl(e.url);
    if (n) byUrl.set(n, e);
  }
  const out: Finding[] = [];
  for (const s of input.gatewayMcpServers) {
    const gw = gateways.get(s.gatewayId);
    const n = normalizeUrl(s.url);
    const ep = n ? byUrl.get(n) : undefined;
    if (!gw || !ep) continue;
    const verdict = permits(gw.environmentKey, ep.environmentKey, input.settings);
    if (verdict.level !== 'blocked') continue;
    out.push({
      id: `gateway-mcp:${gw.id}:${s.serverId}`,
      producer: 'gateway-mcp',
      severity: 'advisory',
      gatewayId: gw.id,
      gatewayName: gw.displayName,
      resourceKind: 'mcp',
      resourceId: ep.id,
      resourceName: ep.displayName,
      message: `MCP server "${s.name}" on ${gw.displayName} points at ${ep.displayName}. ${verdict.message}`,
    });
  }
  return out;
};

export const producers: readonly FindingProducer[] = [gatewayMcpProducer];

export function runFindings(input: FindingsInput, list: readonly FindingProducer[] = producers): Finding[] {
  return list.flatMap((p) => p(input)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
