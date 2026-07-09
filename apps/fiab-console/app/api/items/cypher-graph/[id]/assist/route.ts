/**
 * POST/GET /api/items/cypher-graph/[id]/assist — Graph (openCypher) inline
 * Copilot builder (G1). NL → ADX graph query draft with checkpoint/restore over
 * the Loom-native Cosmos doc. Azure-native (no-fabric-dependency.md).
 */

import { makeCopilotBuilderRoute } from '@/app/api/items/_lib/copilot-builder-route';
import { makeGraphBuilderConfig } from '@/lib/azure/copilot-personas-graph';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, POST } = makeCopilotBuilderRoute(makeGraphBuilderConfig('cypher-graph'));
