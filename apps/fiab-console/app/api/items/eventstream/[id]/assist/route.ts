/**
 * POST/GET /api/items/eventstream/[id]/assist — Eventstream inline Copilot
 * builder (G1).
 *
 * Real AOAI-grounded NL → structured topology edit plan (add/rename/remove
 * transform, add destination) with checkpoint/restore safety, over the
 * Loom-native Cosmos topology doc. Azure-native DEFAULT (no-fabric-dependency.md):
 * works with LOOM_DEFAULT_FABRIC_WORKSPACE unset; never contacts
 * api.fabric.microsoft.com. Wiring lives entirely in the shared builder route +
 * the eventstream persona config.
 */

import { makeCopilotBuilderRoute } from '@/app/api/items/_lib/copilot-builder-route';
import { EVENTSTREAM_BUILDER_CONFIG } from '@/lib/azure/copilot-personas-eventstream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, POST } = makeCopilotBuilderRoute(EVENTSTREAM_BUILDER_CONFIG);
