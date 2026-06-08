/**
 * /api/items/synapse-dedicated-sql-pool/[id]/model — Model view (relationships
 * + measures) for the Synapse Dedicated SQL pool. Shares the handler with the
 * Warehouse route (same wired-in pool); only the Cosmos itemType differs. See
 * app/api/items/_lib/synapse-model.ts.
 */

import { makeSynapseModelHandlers } from '../../../_lib/synapse-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, POST, DELETE } = makeSynapseModelHandlers('synapse-dedicated-sql-pool');
