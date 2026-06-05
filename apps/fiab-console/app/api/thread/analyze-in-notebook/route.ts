/**
 * POST /api/thread/analyze-in-notebook — Loom Thread edge.
 *
 * Weaves a data item (lakehouse / warehouse / KQL / SQL) into a NEW Loom Notebook
 * with that item attached as a data source and a starter cell scaffolded for it,
 * so the user explores it immediately — no paths/connection strings to type.
 * Real owner-scoped Cosmos write (createOwnedItem). No mocks.
 *
 * Body: { from: { id, type, name }, values: { notebookName } }
 * Returns: { ok, message, link, linkLabel }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, createOwnedItem } from '../../items/_lib/item-crud';
import { recordThreadEdge } from '@/lib/thread/thread-edges';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Map a source slug → the notebook AttachedSource.kind it understands. */
const ATTACH_KIND: Record<string, 'lakehouse' | 'warehouse' | 'kql-database'> = {
  'lakehouse': 'lakehouse',
  'warehouse': 'warehouse',
  'synapse-dedicated-sql-pool': 'warehouse',
  'synapse-serverless-sql-pool': 'warehouse',
  'azure-sql-database': 'warehouse',
  'kql-database': 'kql-database',
};

/** A helpful starter cell for the attached source. */
function starterCode(kind: 'lakehouse' | 'warehouse' | 'kql-database', name: string): { code: string; lang: string } {
  if (kind === 'lakehouse') {
    return {
      lang: 'pyspark',
      code:
        `# Explore "${name}" (attached Lakehouse)\n` +
        `# The attached lakehouse is mounted into this session — read a Delta table:\n` +
        `df = spark.read.format("delta").table("${name.replace(/[^A-Za-z0-9_]/g, '_')}")\n` +
        `df.printSchema()\n` +
        `display(df.limit(100))\n`,
    };
  }
  if (kind === 'kql-database') {
    return {
      lang: 'sql',
      code: `// Explore "${name}" (attached KQL database)\n${name.replace(/[^A-Za-z0-9_]/g, '_')}\n| take 100\n`,
    };
  }
  return {
    lang: 'sql',
    code: `-- Explore "${name}" (attached warehouse)\nSELECT TOP 100 *\nFROM /* schema.table in ${name} */ ;\n`,
  };
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const oid = session.claims.oid;

  const body = await req.json().catch(() => ({} as any));
  const from = body?.from || {};
  const notebookName = String(body?.values?.notebookName || '').trim();
  if (!from.id || !from.type) return NextResponse.json({ ok: false, error: 'missing source item' }, { status: 400 });

  const kind = ATTACH_KIND[from.type];
  if (!kind) return NextResponse.json({ ok: false, error: `${from.type} can't be attached to a notebook` }, { status: 400 });

  const src = await loadOwnedItem(from.id, from.type, oid);
  if (!src) return NextResponse.json({ ok: false, error: 'source item not found' }, { status: 404 });

  const name = from.name || src.displayName;
  const starter = starterCode(kind, name);

  const res = await createOwnedItem(session, 'notebook', {
    workspaceId: src.workspaceId,
    displayName: notebookName || `Explore ${name}`,
    description: `Auto-created via Thread to explore ${from.type} "${name}".`,
    state: {
      code: starter.code,
      lang: starter.lang,
      // The notebook editor loads `definition.attachedSources` on open.
      attachedSources: [{ kind, id: src.id, displayName: name, isDefault: true }],
    },
  });
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: res.status });

  await recordThreadEdge(session, {
    fromItemId: from.id, fromType: from.type, fromName: name,
    toItemId: res.item.id, toType: 'notebook', toName: res.item.displayName,
    action: 'analyze-in-notebook',
  });

  return NextResponse.json({
    ok: true,
    message: `Created notebook "${res.item.displayName}" with ${name} attached.`,
    link: `/items/notebook/${res.item.id}`,
    linkLabel: 'Open the Notebook',
  });
}
