/**
 * GET /api/items/sql-analytics-endpoint/[id]/objects?database=<db>
 *
 * Enumerates the SQL objects (views, stored procedures, table-valued functions,
 * external tables, columns) in the selected serverless database for the SQL
 * analytics endpoint editor's object explorer + Monaco IntelliSense.
 *
 * REUSE, NOT REINVENT (no-vaporware.md): RE-EXPORTED verbatim from the serverless
 * SQL pool route — every catalog query runs against the real TDS endpoint via
 * synapse-sql-client (AAD MI), each independently try/caught so the surface
 * degrades to a partial-but-honest result rather than an opaque error.
 * Azure-native default — no Fabric (no-fabric-dependency.md).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export { GET } from '@/app/api/items/synapse-serverless-sql-pool/[id]/objects/route';
