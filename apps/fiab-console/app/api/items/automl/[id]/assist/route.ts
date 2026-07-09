/**
 * POST/GET /api/items/automl/[id]/assist — AutoML inline Copilot builder (G1).
 * NL → structured Azure ML AutoML config with checkpoint/restore over the
 * Loom-native Cosmos doc. Azure-native (no-fabric-dependency.md).
 */

import { makeCopilotBuilderRoute } from '@/app/api/items/_lib/copilot-builder-route';
import { makeAutoMlBuilderConfig } from '@/lib/azure/copilot-personas-automl';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, POST } = makeCopilotBuilderRoute(makeAutoMlBuilderConfig('automl'));
