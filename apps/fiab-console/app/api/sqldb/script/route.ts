/**
 * GET /api/sqldb/script?workspaceId&id&objectId&group&variant[&indexId]
 *   — emits CREATE / ALTER / DROP DDL for an object:
 *       view/procedure/function → sys.sql_modules.definition (CREATE/ALTER) or generated DROP
 *       table                   → reconstructed CREATE TABLE (+CREATE INDEX) / DROP TABLE
 *       table-type              → reconstructed CREATE TYPE…AS TABLE / DROP TYPE
 *       index (needs indexId)   → CREATE/DROP INDEX from sys.indexes
 *     All identifiers come from the catalog (bracket-quoted); no caller string
 *     is interpolated into the emitted DDL.
 */
import { NextRequest, NextResponse } from 'next/server';
import { guardSqlDbRequest } from '../_shared';
import { scriptObject, type ScriptGroup, type ScriptVariant } from '@/lib/azure/sql-objects-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GROUPS: ScriptGroup[] = ['table', 'view', 'procedure', 'function', 'table-type', 'index'];
const VARIANTS: ScriptVariant[] = ['CREATE', 'ALTER', 'DROP'];

export async function GET(req: NextRequest) {
  const g = await guardSqlDbRequest(req);
  if (g.res) return g.res;
  const sp = req.nextUrl.searchParams;
  const objectId = Number(sp.get('objectId'));
  const group = String(sp.get('group') || '') as ScriptGroup;
  const variant = String(sp.get('variant') || 'CREATE').toUpperCase() as ScriptVariant;
  const indexIdRaw = sp.get('indexId');
  const indexId = indexIdRaw != null ? Number(indexIdRaw) : undefined;

  if (!Number.isInteger(objectId)) return NextResponse.json({ ok: false, error: 'objectId is required' }, { status: 400 });
  if (!GROUPS.includes(group)) return NextResponse.json({ ok: false, error: `group must be one of ${GROUPS.join(', ')}` }, { status: 400 });
  if (!VARIANTS.includes(variant)) return NextResponse.json({ ok: false, error: `variant must be one of ${VARIANTS.join(', ')}` }, { status: 400 });

  const r = await scriptObject(g.ctx.server, g.ctx.database, group, objectId, variant, indexId);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, script: r.script });
}
