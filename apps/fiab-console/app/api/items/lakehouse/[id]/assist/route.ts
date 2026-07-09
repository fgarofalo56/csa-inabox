/**
 * POST/GET /api/items/lakehouse/[id]/assist — Lakehouse inline Copilot builder
 * (G1). NL → Synapse-serverless / Spark SQL draft over the lakehouse Delta
 * tables, with checkpoint/restore over the Loom-native Cosmos doc. Azure-native
 * (no-fabric-dependency.md).
 */

import { makeCopilotBuilderRoute } from '@/app/api/items/_lib/copilot-builder-route';
import { LAKEHOUSE_BUILDER_CONFIG } from '@/lib/azure/copilot-personas-lakehouse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, POST } = makeCopilotBuilderRoute(LAKEHOUSE_BUILDER_CONFIG);
