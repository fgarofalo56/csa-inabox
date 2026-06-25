/**
 * GET /api/items/sql-analytics-endpoint/[id]/schema
 *   ( ?database=<db>&table=<schema.table> → { ok, columns } for IntelliSense )
 *
 * Returns the browseable surface for the SQL analytics endpoint editor: the
 * attached user databases (CREATE DATABASE on serverless), the ADLS lake
 * containers (bronze/silver/gold/landing) for OPENROWSET, the serverless
 * endpoint FQDN, and sample queries.
 *
 * REUSE, NOT REINVENT (no-vaporware.md): RE-EXPORTED verbatim from the serverless
 * SQL pool route (real TDS via synapse-sql-client; env-pinned, id-agnostic).
 * Azure-native default — no Fabric (no-fabric-dependency.md).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export { GET } from '@/app/api/items/synapse-serverless-sql-pool/[id]/schema/route';
