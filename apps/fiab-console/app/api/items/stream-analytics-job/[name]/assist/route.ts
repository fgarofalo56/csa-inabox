/**
 * POST/GET /api/items/stream-analytics-job/[id]/assist — Stream Analytics inline
 * Copilot builder (G1). NL → SAQL draft with checkpoint/restore over the
 * Loom-native Cosmos doc. Azure-native (no-fabric-dependency.md).
 */

import { makeCopilotBuilderRoute } from '@/app/api/items/_lib/copilot-builder-route';
import { STREAM_ANALYTICS_BUILDER_CONFIG } from '@/lib/azure/copilot-personas-stream-analytics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, POST } = makeCopilotBuilderRoute(STREAM_ANALYTICS_BUILDER_CONFIG);
