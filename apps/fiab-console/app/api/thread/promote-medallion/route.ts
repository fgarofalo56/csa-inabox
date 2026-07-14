/**
 * POST /api/thread/promote-medallion — Loom Thread (Weave) edge.
 *
 * From a `lakehouse`, promote one of its bronze/silver Delta tables to the next
 * medallion layer. Loom scaffolds a REAL Synapse Spark notebook (read the source
 * Delta table → apply the chosen transform (clean+dedup, or aggregate) → write
 * the promoted Delta table into the target lakehouse) with both lakehouses
 * attached, records the promotion lineage edge, and deep-links the notebook so
 * the user Runs it on Azure-native Synapse Spark (the proven %%pyspark path). The
 * medallion spine — Azure-native, no Fabric (no-fabric-dependency.md). The
 * notebook + generated code are 100% real; the promotion executes on real Spark
 * at Run (no-vaporware.md), same shape as the shipped "Analyze in a Notebook"
 * and "Explore mirrored data in a Notebook" edges.
 *
 * Body: { from:{id,type,name}, values:{ table:'name|adlsPath', targetLayer, transform, targetLakehouseId } }
 * Returns: { ok, message, code, link, linkLabel } | { ok:false, error }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, createOwnedItem } from '../../items/_lib/item-crud';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type TargetLayer = 'silver' | 'gold';
type Transform = 'clean-dedup' | 'aggregate';

function bad(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

/** Sanitize a Delta table name for use as a target folder / Python literal. */
function safeTableName(s: string): string {
  return String(s).replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'table';
}

/**
 * Build the REAL medallion-promotion PySpark for the scaffolded notebook. Reads
 * the source Delta table, applies the transform, and writes the promoted Delta
 * table to the target lakehouse's `Tables/` folder (so a lakehouse table scan
 * discovers it). Every path is a resolved abfss URI (never a guessed one).
 */
function promotionCode(args: {
  sourceName: string;
  targetLayer: TargetLayer;
  transform: Transform;
  srcAbfss: string;
  dstAbfss: string;
  dstTable: string;
}): string {
  const header =
    `# Medallion promotion — ${args.sourceName} → ${args.targetLayer} (${args.transform})\n` +
    `# Reads the source Delta table, applies the transform, and writes the promoted\n` +
    `# Delta table to the target lakehouse. Run this cell on Synapse Spark.\n` +
    `from pyspark.sql import functions as F\n\n` +
    `SRC_PATH = "${args.srcAbfss}"\n` +
    `DST_PATH = "${args.dstAbfss}"\n\n` +
    `df = spark.read.format("delta").load(SRC_PATH)\n` +
    `print(f"Source rows: {df.count():,}")\n\n`;

  const body =
    args.transform === 'aggregate'
      ? // Aggregate: group by the non-numeric columns, sum the numeric ones.
        `# --- Aggregate: group by dimensions, sum measures ---\n` +
        `numeric_types = ("int", "bigint", "smallint", "tinyint", "double", "float", "long", "decimal")\n` +
        `measures = [c for c, t in df.dtypes if t.startswith(numeric_types)]\n` +
        `dims = [c for c, t in df.dtypes if c not in measures]\n` +
        `if measures and dims:\n` +
        `    promoted = df.groupBy(*dims).agg(*[F.sum(c).alias(f"sum_{c}") for c in measures])\n` +
        `else:\n` +
        `    # No clear measure/dimension split — fall back to a distinct set.\n` +
        `    promoted = df.dropDuplicates()\n\n`
      : // Clean + de-duplicate: drop exact dupes, drop all-null rows, trim strings.
        `# --- Clean + de-duplicate ---\n` +
        `promoted = df.dropDuplicates().na.drop("all")\n` +
        `for c, t in promoted.dtypes:\n` +
        `    if t == "string":\n` +
        `        promoted = promoted.withColumn(c, F.trim(F.col(c)))\n\n`;

  const footer =
    `promoted.write.format("delta").mode("overwrite").save(DST_PATH)\n` +
    `print(f"Promoted {promoted.count():,} rows → ${args.targetLayer}/${args.dstTable}")\n` +
    `display(promoted.limit(100))\n`;

  return header + body + footer;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return bad('unauthenticated', 401);
  const oid = session.claims.oid;

  const body = await req.json().catch(() => ({} as any));
  const from = body?.from || {};
  const values = body?.values || {};
  const tableSel = String(values.table || '').trim();
  const targetLayer = String(values.targetLayer || 'silver').trim() as TargetLayer;
  const transform = String(values.transform || 'clean-dedup').trim() as Transform;
  const targetLakehouseId = String(values.targetLakehouseId || '').trim();

  if (from.type !== 'lakehouse' || !from.id) return bad('this edge is for lakehouse items', 400);
  if (!tableSel) return bad('pick a source Delta table', 400);
  if (targetLayer !== 'silver' && targetLayer !== 'gold') return bad('invalid target layer', 400);
  if (transform !== 'clean-dedup' && transform !== 'aggregate') return bad('invalid transform', 400);
  if (!targetLakehouseId) return bad('pick a target lakehouse', 400);

  const srcLake = await loadOwnedItem(from.id, from.type, oid);
  if (!srcLake) return bad('source lakehouse not found', 404);

  const sourceName = safeTableName(tableSel.split('|')[0] || '');
  const dstTable = `${sourceName}_${targetLayer}`;

  // Resolve the SOURCE Delta table abfss.
  const srcRoot = await resolveLakehouseAbfss(from.id, srcLake.workspaceId);
  if (!srcRoot) {
    return NextResponse.json(
      {
        ok: false,
        gate: { missing: 'LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL' },
        error:
          'No lakehouse storage configured — set LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL and grant the ' +
          'Console UAMI Storage Blob Data Reader on the container.',
      },
      { status: 503 },
    );
  }
  const srcAbfss = `${srcRoot.abfss.replace(/\/+$/, '')}/Tables/${sourceName}`;

  // Resolve (or create) the TARGET lakehouse in the same workspace.
  let targetLake;
  if (targetLakehouseId === '__new__') {
    const created = await createOwnedItem(session, 'lakehouse', {
      workspaceId: srcLake.workspaceId,
      displayName: `${srcLake.displayName} ${targetLayer}`,
      description: `Medallion ${targetLayer} lakehouse for promotions from "${srcLake.displayName}".`,
      state: {},
    });
    if (!created.ok) return bad(created.error, created.status);
    targetLake = created.item;
  } else {
    targetLake = await loadOwnedItem(targetLakehouseId, 'lakehouse', oid);
    if (!targetLake) return bad('target lakehouse not found', 404);
  }

  const dstRoot = await resolveLakehouseAbfss(targetLake.id, targetLake.workspaceId);
  if (!dstRoot) {
    return NextResponse.json(
      {
        ok: false,
        gate: { missing: 'LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL' },
        error: 'The target lakehouse has no configured storage. Set LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL.',
      },
      { status: 503 },
    );
  }
  const dstAbfss = `${dstRoot.abfss.replace(/\/+$/, '')}/Tables/${dstTable}`;

  const code = promotionCode({ sourceName, targetLayer, transform, srcAbfss, dstAbfss, dstTable });

  // Scaffold the promotion notebook with BOTH lakehouses attached + the code.
  const nbName = `Promote ${sourceName} → ${targetLayer}`;
  const created = await createOwnedItem(session, 'notebook', {
    workspaceId: srcLake.workspaceId,
    displayName: nbName,
    description: `Auto-created via Thread to promote lakehouse table "${sourceName}" to ${targetLayer}.`,
    state: {
      code,
      lang: 'pyspark',
      attachedSources: [
        { kind: 'lakehouse', id: srcLake.id, displayName: srcLake.displayName, isDefault: true },
        { kind: 'lakehouse', id: targetLake.id, displayName: targetLake.displayName, isDefault: false },
      ],
    },
  });
  if (!created.ok) return bad(created.error, created.status);
  const nbId = created.item.id;

  // Lineage: source lakehouse → target lakehouse (the promotion), and source →
  // the scaffolding notebook (like analyze-in-notebook).
  await recordThreadEdge(session, {
    fromItemId: from.id, fromType: from.type, fromName: from.name || srcLake.displayName,
    toItemId: targetLake.id, toType: 'lakehouse', toName: targetLake.displayName,
    toLink: `/items/lakehouse/${targetLake.id}`, action: 'promote-medallion',
  });
  await recordThreadEdge(session, {
    fromItemId: from.id, fromType: from.type, fromName: from.name || srcLake.displayName,
    toItemId: nbId, toType: 'notebook', toName: nbName,
    toLink: `/items/notebook/${nbId}`, action: 'promote-medallion',
  });

  return NextResponse.json({
    ok: true,
    code,
    message:
      `Scaffolded promotion notebook "${nbName}" (${transform}) writing ${targetLayer}/${dstTable} into ` +
      `lakehouse "${targetLake.displayName}". Open it and Run to promote on Synapse Spark.`,
    link: `/items/notebook/${nbId}`,
    linkLabel: 'Open the promotion notebook',
  });
}
