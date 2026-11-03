/**
 * Findings source for lib/api-gateway/environments (W1-4 hand-off): gateways x MCP
 * servers, read from the observed `mcp` documents. Registered endpoints arrive in W2,
 * so `mcpEndpoints` is honestly empty today (the producer then yields no findings).
 */
import type { GatewayMcpServer } from '../environments/findings';
import type { FindingsSource } from '../environments/findings-source';
import type { ApiplaneRepo } from '../types';
import type { ObservedDoc } from './types';

export function observedFindingsSource(repo: () => ApiplaneRepo<ObservedDoc>): FindingsSource {
  return {
    async gatewayMcpServers(tenantId): Promise<GatewayMcpServer[]> {
      const docs = await repo().list(tenantId, 'observed:mcp');
      return docs
        .filter((d) => typeof d.mcp?.url === 'string' && d.mcp.url)
        .map((d) => ({ gatewayId: d.gatewayId, serverId: d.id, name: d.displayName ?? d.name, url: d.mcp!.url as string }));
    },
    async mcpEndpoints() {
      return [];
    },
  };
}
