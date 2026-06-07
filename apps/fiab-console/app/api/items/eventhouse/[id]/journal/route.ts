/**
 * GET /api/items/eventhouse/[id]/journal?limit=100&database=<optional>
 *
 * Returns the ADX schema-change journal — the metadata-operation log for the
 * shared Loom cluster (Fabric RTI Eventhouse Azure-native default). Maps to
 * Fabric's "Eventhouse system overview → schema changes" surface.
 *
 * Cluster-wide (`.show journal`) returns every journal entry the caller has
 * admin access to; pass `database` to scope to one db (`.show database <db>
 * journal`). Read-only metadata; no PII. Real backend only — no mocks.
 *
 * Journal columns (grounded in Learn — note the docs flag the column set /
 * formatting as non-contractual, so we read every column defensively):
 *   https://learn.microsoft.com/kusto/management/journal
 *   Event, EventTimestamp, Database, EntityName, UpdatedEntityName,
 *   EntityVersion, EntityContainerName, OriginalEntityState,
 *   UpdatedEntityState, ChangeCommand, Principal
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeMgmtCommand, KustoError } from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** KQL bracketed-string quote for a (possibly hyphenated) db name. */
function qName(name: string): string {
  return `["${name.replace(/"/g, '\\"')}"]`;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  await ctx.params; // [id] = Loom item id; journal is cluster/db scoped.

  const url = new URL(req.url);
  const limitRaw = parseInt(url.searchParams.get('limit') || '100', 10);
  const limit = Math.min(1000, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100));
  const database = (url.searchParams.get('database') || '').trim();

  const command = database
    ? `.show database ${qName(database)} journal | take ${limit}`
    : `.show journal | take ${limit}`;

  try {
    const r = await executeMgmtCommand('NetDefaultDB', command);
    const idx = (c: string) => r.columns.indexOf(c);
    const ts = idx('EventTimestamp');
    const ev = idx('Event');
    const db = idx('Database');
    const ent = idx('EntityName');
    const upd = idx('UpdatedEntityName');
    const ver = idx('EntityVersion');
    const cont = idx('EntityContainerName');
    const cmd = idx('ChangeCommand');
    const princ = idx('Principal');
    const get = (row: unknown[], i: number) => (i >= 0 && row[i] != null ? String(row[i]) : '');

    const entries = r.rows.map((row) => ({
      event: get(row, ev),
      eventTimestamp: get(row, ts),
      database: get(row, db),
      entityName: get(row, ent),
      updatedEntityName: get(row, upd),
      entityVersion: get(row, ver),
      entityContainerName: get(row, cont),
      changeCommand: get(row, cmd),
      principal: get(row, princ),
    }));

    // Newest first so the UI log reads top-down.
    entries.sort((a, b) => {
      const ta = Date.parse(a.eventTimestamp) || 0;
      const tb = Date.parse(b.eventTimestamp) || 0;
      return tb - ta;
    });

    return NextResponse.json({ ok: true, entries, rowCount: entries.length });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), body: e?.body },
      { status },
    );
  }
}
