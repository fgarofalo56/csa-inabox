/**
 * POST/GET /api/items/mirrored-database/[id]/assist — Mirrored Database inline
 * Copilot builder (G1). NL → structured edits to the mirrored-table set with
 * checkpoint/restore over the Loom-native Cosmos doc. Azure-native
 * (no-fabric-dependency.md).
 */

import { makeCopilotBuilderRoute } from '@/app/api/items/_lib/copilot-builder-route';
import { MIRRORED_DATABASE_BUILDER_CONFIG } from '@/lib/azure/copilot-personas-mirrored-database';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, POST } = makeCopilotBuilderRoute(MIRRORED_DATABASE_BUILDER_CONFIG);
