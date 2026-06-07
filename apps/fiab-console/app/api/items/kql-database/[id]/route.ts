/**
 * GET /api/items/kql-database/[id]
 * Returns live ADX database details (size, retention, hot cache, table count).
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  clusterUri, defaultDatabase, getDatabaseDetails, listTables,
  listFunctions, listMaterializedViews,
  loadKustoItem, resolveDatabase, KustoError,
} from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    const item = await loadKustoItem((await ctx.params).id, 'kql-database', session.claims.oid);
    const database = resolveDatabase(item);
    const [details, tables, functions, materializedViews] = await Promise.all([
      getDatabaseDetails(database).catch(() => null),
      listTables(database).catch(() => []),
      listFunctions(database).catch(() => []),
      listMaterializedViews(database).catch(() => []),
    ]);

    // App-install starter content (a `KqlDatabaseContent`) is stamped onto
    // `state.content` so a bundle-installed KQL database opens FULLY
    // BUILT-OUT — its tables (with columns + sample rows), functions, and
    // starter analyst queries — even before the live ADX/Eventhouse objects
    // are created. The live cluster (.show tables/functions) is still the
    // source of truth once objects exist; we only use content to populate
    // the schema the live cluster doesn't yet have.
    const content: any = item?.state?.content;
    const isKqlContent = content?.kind === 'kql-database';
    const liveTableNames = new Set(tables.map((t: any) => String(t?.name)));
    const liveFnNames = new Set(functions.map((f: any) => String(f?.name)));

    // Rich schema view (columns + sample) sourced from content; live tables
    // that already exist are marked live=true (no duplicate from content).
    const schema = isKqlContent && Array.isArray(content.tables)
      ? content.tables.map((t: any) => ({
          name: String(t?.name),
          columns: Array.isArray(t?.columns)
            ? t.columns.map((c: any) => ({ name: String(c?.name), type: String(c?.type || 'string') }))
            : [],
          sample: Array.isArray(t?.sample) ? t.sample : [],
          live: liveTableNames.has(String(t?.name)),
        }))
      : [];

    // Merge content tables/functions that aren't live yet into the lists the
    // editor shows, flagging them so the UI can mark them "from app template".
    const contentTables = isKqlContent && Array.isArray(content.tables)
      ? content.tables
          .filter((t: any) => !liveTableNames.has(String(t?.name)))
          .map((t: any) => ({ name: String(t?.name), fromContent: true }))
      : [];
    const contentFunctions = isKqlContent && Array.isArray(content.functions)
      ? content.functions
          .filter((f: any) => !liveFnNames.has(String(f?.name)))
          .map((f: any) => ({ name: String(f?.name), body: String(f?.body || ''), fromContent: true }))
      : [];

    const starterQueries = isKqlContent && Array.isArray(content.starterQueries)
      ? content.starterQueries.map((q: any) => ({ name: String(q?.name || 'Query'), kql: String(q?.kql || '') }))
          .filter((q: any) => q.kql.length > 0)
      : [];

    const mergedTables = [...tables, ...contentTables];
    const mergedFunctions = [...functions, ...contentFunctions];

    // Follower (database-shortcut) state — drives the read-only badge, the
    // write-block messaging, and disabling of the mutation ribbon wizards.
    const isFollower = !!item?.state?.isFollower;
    const followerLeaderCluster = item?.state?.followerLeaderCluster || null;
    const followerConfigName = item?.state?.followerConfigName || null;
    const followerDatabaseName = item?.state?.followerDatabaseName || null;

    return NextResponse.json({
      ok: true,
      cluster: clusterUri(),
      database,
      defaultDatabase: defaultDatabase(),
      details,
      tables: mergedTables,
      tableCount: mergedTables.length,
      functions: mergedFunctions,
      functionCount: mergedFunctions.length,
      materializedViews,
      materializedViewCount: materializedViews.length,
      displayName: item?.displayName,
      // Follower / database-shortcut projection.
      isFollower,
      followerLeaderCluster,
      followerConfigName,
      followerDatabaseName,
      // Content-derived projections — surfaced when the live object is absent.
      schema,
      starterQueries,
      contentFallback: schema.length > 0 || starterQueries.length > 0,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
