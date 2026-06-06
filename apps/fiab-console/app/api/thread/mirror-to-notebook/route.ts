/**
 * POST /api/thread/mirror-to-notebook — Loom Thread edge (mirrored-database).
 *
 * Weaves a mirrored database's replicated tables (landed as CSV in ADLS Bronze
 * by the mirror engine) into a NEW Loom Notebook with a Spark cell that reads
 * each table from its abfss path — no paths to type. Real owner-scoped Cosmos
 * write (createOwnedItem); reads the mirror's real per-table snapshot metadata.
 *
 * Body: { from:{id,type,name}, values:{ notebookName } }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, createOwnedItem } from '../../items/_lib/item-crud';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import { httpsToAbfss } from '@/lib/azure/mirror-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const oid = session.claims.oid;

  const body = await req.json().catch(() => ({} as any));
  const from = body?.from || {};
  const notebookName = String(body?.values?.notebookName || '').trim();
  if (from.type !== 'mirrored-database' || !from.id) {
    return NextResponse.json({ ok: false, error: 'this edge is for mirrored databases' }, { status: 400 });
  }

  const src = await loadOwnedItem(from.id, from.type, oid);
  if (!src) return NextResponse.json({ ok: false, error: 'mirrored database not found' }, { status: 404 });

  const tablesStatus: any[] = Array.isArray((src.state as any)?.tablesStatus) ? (src.state as any).tablesStatus : [];
  const replicated = tablesStatus.filter((t) => t.status === 'replicated' && t.path);
  if (!replicated.length) {
    return NextResponse.json(
      { ok: false, error: 'This mirror has no replicated tables yet. Open the mirror and click Start to snapshot its tables, then weave again.' },
      { status: 400 },
    );
  }

  const name = from.name || src.displayName;
  const reads = replicated.map((t) => {
    const abfss = httpsToAbfss(String(t.path));
    const varName = `${t.schema}_${t.table}`.replace(/[^A-Za-z0-9_]/g, '_');
    return (
      `# ${t.schema}.${t.table}\n` +
      `${varName} = spark.read.option("header", True).csv("${abfss}")\n` +
      `print("${t.schema}.${t.table}:", ${varName}.count(), "rows")\n` +
      `display(${varName}.limit(100))\n`
    );
  });
  const code =
    `# Explore mirrored data from "${name}" (Azure-native mirror → ADLS Bronze CSV)\n` +
    `# Each replicated table is read from its abfss path. No Fabric required.\n\n` +
    reads.join('\n');

  const res = await createOwnedItem(session, 'notebook', {
    workspaceId: src.workspaceId,
    displayName: notebookName || `Explore ${name}`,
    description: `Auto-created via Thread to explore mirrored database "${name}".`,
    state: { code, lang: 'pyspark' },
  });
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: res.status });

  await recordThreadEdge(session, {
    fromItemId: from.id, fromType: from.type, fromName: name,
    toItemId: res.item.id, toType: 'notebook', toName: res.item.displayName,
    action: 'mirror-explore-notebook',
  });

  return NextResponse.json({
    ok: true,
    message: `Created notebook "${res.item.displayName}" reading ${replicated.length} mirrored table(s) from ADLS Bronze.`,
    link: `/items/notebook/${res.item.id}`,
    linkLabel: 'Open the Notebook',
  });
}
