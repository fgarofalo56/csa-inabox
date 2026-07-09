/**
 * POST/GET /api/items/materialized-lake-view/[id]/assist — Materialized Lake
 * View inline Copilot builder (G1). NL → Spark SQL view-definition draft with
 * checkpoint/restore over the Loom-native Cosmos doc. Azure-native
 * (no-fabric-dependency.md).
 */

import { makeCopilotBuilderRoute } from '@/app/api/items/_lib/copilot-builder-route';
import { MLV_BUILDER_CONFIG } from '@/lib/azure/copilot-personas-materialized-lake-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, POST } = makeCopilotBuilderRoute(MLV_BUILDER_CONFIG);
