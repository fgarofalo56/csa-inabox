/**
 * /api/items/warehouse/[id]/model — Model view (relationships + measures) for
 * the Fabric "Warehouse", backed by the Synapse Dedicated SQL pool. See
 * app/api/items/_lib/synapse-model.ts for the shared handler. No Power BI /
 * Fabric dependency — works fully with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 */

import { makeSynapseModelHandlers } from '../../../_lib/synapse-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, POST, DELETE } = makeSynapseModelHandlers('warehouse');
