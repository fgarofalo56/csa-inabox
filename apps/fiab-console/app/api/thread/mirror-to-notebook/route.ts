/**
 * POST /api/thread/mirror-to-notebook — Loom Thread edge (mirrored-database).
 *
 * Weaves a mirrored database's replicated tables (landed in ADLS Bronze by the
 * mirror engine) into a NEW Loom Notebook with a Spark cell that reads each
 * table from its abfss path — no paths to type. Real owner-scoped Cosmos write
 * (createOwnedItem); reads the mirror's real per-table snapshot metadata.
 *
 * ── THE FORMAT IS DERIVED, NOT ASSUMED (#4084) ─────────────────────────────
 * This generator used to emit `spark.read.option("header", True).csv(...)` for
 * every table and label the cell "ADLS Bronze CSV". Loom has THREE Azure-native
 * mirror engines and they write three different formats — csv-snapshot -> CSV,
 * adf-cdc -> Delta, adf-copy (Snowflake) -> Parquet (`ParquetSink`,
 * mirror-engine.ts) — so the generated code was wrong for two of the three and
 * the comment asserted a format the engine does not produce (deploy-integrity
 * R7).
 *
 * That mismatch does not fail loudly. Parquet begins `PAR1`; read as headered
 * delimited text, Spark can infer a single garbage column and hand back a
 * non-empty DataFrame, so `.count()` prints a number and `display()` renders
 * rows. An operator gets a green-looking answer that is not the data.
 *
 * The reader is now built from `mirrorBronzeFormatOf` — the shared derivation in
 * `lib/azure/mirror-engine.ts`, which reads the format the ENGINE recorded for
 * that table (its `openrowset` FORMAT clause, else `state.lastRun.engine`). A
 * new sink format therefore changes both sides at once, and a table whose
 * format was never recorded is DISCLOSED in the cell rather than silently
 * defaulted.
 *
 * Body: { from:{id,type,name}, values:{ notebookName } }
 */
import { NextRequest, NextResponse } from 'next/server';
import { loadOwnedItem, createOwnedItem } from '../../items/_lib/item-crud';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import { httpsToAbfss, mirrorBronzeFormatOf, mirrorSparkReadExpr } from '@/lib/azure/mirror-engine';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * THE HANDLER IS TOOLKIT-WRAPPED; THE EXPORT IS 1-ARG. Both halves are load-bearing.
 *
 * `withSession` gives this route the shared 401 with no `if (gate) return gate;`
 * line to delete (`check-route-toolkit`'s boy-scout rule requires it once the
 * file is touched at all). But `withSession` returns a 2-ARG `RouteHandler`, and
 * this route is a WEAVE BRIDGE: `app/api/estate/execute/route.ts` dynamic-imports
 * all 13 bridges under `type RouteModule = { POST: (req: NextRequest) =>
 * Promise<Response> }`. MEASURED — exporting the wrapper directly makes that map
 * a compile error ("Target signature provides too few arguments. Expected 2 or
 * more, but got 1"), which `next build` would fail on. The thin adapter below
 * keeps the toolkit's authorization AND the bridge contract. This route has no
 * `[param]` segment, so the empty params object loses nothing.
 */
const postHandler = withSession(async (req: NextRequest, { session }) => {
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
  // The engine tag the LAST run recorded, used only for rows whose own
  // `openrowset` did not name a format.
  const lastEngine = (src.state as any)?.lastRun?.engine as string | undefined;

  const formats = new Set<string>();
  const reads = replicated.map((t) => {
    const abfss = httpsToAbfss(String(t.path));
    const varName = `${t.schema}_${t.table}`.replace(/[^A-Za-z0-9_]/g, '_');
    const derived = mirrorBronzeFormatOf(t, lastEngine);
    // NOT ESTABLISHED is said, not guessed away. When neither the row nor the
    // run recorded a format, the cell still runs (CSV is what the default
    // built-in engine writes) but it says that it is an assumption and names
    // the two alternatives — never an unqualified claim (deploy-integrity R7).
    const fmt = derived ?? 'csv';
    formats.add(derived ? derived : 'csv (ASSUMED — not recorded)');
    const disclosure = derived
      ? ''
      : '# NOTE: this mirror run recorded no on-disk format for this table, so the reader\n' +
        '#       below ASSUMES CSV (what Loom\'s built-in snapshot engine writes). If this\n' +
        '#       mirror used the ADF Copy backend the data is Parquet — swap in\n' +
        '#       spark.read.parquet(...) — and for the ADF CDC backend it is Delta:\n' +
        '#       spark.read.format("delta").load(...). Re-run the mirror to record it.\n';
    return (
      `# ${t.schema}.${t.table}\n` +
      disclosure +
      `${varName} = ${mirrorSparkReadExpr(fmt, abfss)}\n` +
      `print("${t.schema}.${t.table}:", ${varName}.count(), "rows")\n` +
      `display(${varName}.limit(100))\n`
    );
  });
  const code =
    `# Explore mirrored data from "${name}" (Azure-native mirror → ADLS Bronze)\n` +
    `# On-disk format, from what the mirror engine recorded: ${[...formats].sort().join(', ')}.\n` +
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
});

export async function POST(req: NextRequest): Promise<Response> {
  return postHandler(req, { params: Promise.resolve({}) });
}
