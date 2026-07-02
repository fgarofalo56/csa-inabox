/**
 * POST /api/items/sql-analytics-endpoint/[id]/query
 *   body: { sql, database? }
 *
 * Executes read-first T-SQL for the `sql-analytics-endpoint` item over the
 * Azure-native Synapse SERVERLESS SQL endpoint (TDS + AAD via synapse-sql-client)
 * — the Azure parity for Fabric's SQL analytics endpoint, no Fabric required.
 *
 * REUSE, NOT REINVENT (no-vaporware.md): the handler is RE-EXPORTED verbatim from
 * the serverless SQL pool route, which runs real TDS (executeQuery /
 * executeQueryAsUser), honours the item's data-access mode, and flags DDL. The
 * endpoint is env-pinned (LOOM_SYNAPSE_WORKSPACE) and id-agnostic for execution,
 * so it serves this item's own BFF namespace unchanged.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export { POST } from '@/app/api/items/synapse-serverless-sql-pool/[id]/query/route';
