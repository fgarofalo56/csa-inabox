/**
 * POST /api/sqldb/rename?workspaceId&id
 *   body: { group: 'table'|'view'|'procedure'|'function', objectId: number, newName: string }
 *   — renames the object via `sp_rename … @objtype='OBJECT'`. The old name is
 *     resolved from the catalog; the new bare name is parameterized. Returns
 *     `warningDefinitionStale` for view/procedure/function (sp_rename does not
 *     update sys.sql_modules.definition — Microsoft recommends DROP+CREATE).
 */
import { NextRequest, NextResponse } from 'next/server';
import { guardSqlDbRequest } from '../_shared';
import { renameObject, type SqlObjectGroup } from '@/lib/azure/sql-objects-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RENAMEABLE: SqlObjectGroup[] = ['table', 'view', 'procedure', 'function'];

export async function POST(req: NextRequest) {
  const g = await guardSqlDbRequest(req);
  if (g.res) return g.res;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const group = String(body?.group || '') as SqlObjectGroup;
  const objectId = Number(body?.objectId);
  const newName = typeof body?.newName === 'string' ? body.newName : '';
  if (!RENAMEABLE.includes(group)) {
    return NextResponse.json({ ok: false, error: `group must be one of ${RENAMEABLE.join(', ')}` }, { status: 400 });
  }
  if (!Number.isInteger(objectId)) return NextResponse.json({ ok: false, error: 'objectId is required' }, { status: 400 });
  if (!newName.trim()) return NextResponse.json({ ok: false, error: 'newName is required' }, { status: 400 });

  const r = await renameObject(g.ctx.server, g.ctx.database, group, objectId, newName);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, renamed: r.renamed, warningDefinitionStale: !!r.warningDefinitionStale });
}
