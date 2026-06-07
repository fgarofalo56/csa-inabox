/**
 * Follower database attach (database shortcut) — T7.
 *
 *   GET    /api/items/kql-database/[id]/follower
 *     Lists all attachedDatabaseConfigurations on the Loom (follower) cluster.
 *   POST   /api/items/kql-database/[id]/follower
 *     Attaches a leader database as a read-only follower, then records the
 *     follower state onto the Cosmos item so the editor renders read-only.
 *   DELETE /api/items/kql-database/[id]/follower?configName=<name>
 *     Detaches the follower configuration and clears follower state.
 *
 * A follower database is a live, read-only replica of a leader cluster's
 * database surfaced on THIS cluster via an `attachedDatabaseConfigurations`
 * ARM child resource. This is the Azure-native parity for "database shortcut"
 * — no Fabric / OneLake dependency. Real ARM REST only (kusto-arm-client).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  attachFollowerDatabase,
  listAttachedDatabaseConfigurations,
  detachFollowerDatabase,
  KustoArmError,
  KustoNotConfiguredError,
} from '@/lib/azure/kusto-arm-client';
import { loadKustoItem, saveItemState, KustoError } from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LEADER_ID_RE =
  /^\/subscriptions\/[0-9a-fA-F-]{36}\/resourceGroups\/[^/]+\/providers\/Microsoft\.Kusto\/clusters\/[^/]+$/;

/** Build a safe, unique attachedDatabaseConfiguration name (≤40 chars). */
function makeConfigName(databaseName: string): string {
  const slug = (databaseName === '*' ? 'all' : databaseName)
    .replace(/[^A-Za-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24) || 'db';
  return `attcfg-${slug}-${Date.now().toString(36)}`.slice(0, 40);
}

function notConfigured(e: KustoNotConfiguredError) {
  return NextResponse.json(
    {
      ok: false,
      error: e.message,
      missing: e.missing,
    },
    { status: 503 },
  );
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const leaderClusterResourceId = String(body?.leaderClusterResourceId || '').trim();
  const leaderClusterUri = String(body?.leaderClusterUri || '').trim();
  const databaseName = (String(body?.databaseName || '').trim() || '*');
  const principalsModificationKind = String(body?.principalsModificationKind || 'Union');

  if (!LEADER_ID_RE.test(leaderClusterResourceId)) {
    return NextResponse.json({
      ok: false,
      error:
        'leaderClusterResourceId must be a full ARM resource id: ' +
        '/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Kusto/clusters/{name}',
    }, { status: 400 });
  }
  if (databaseName !== '*' && !/^[\w .-]{1,260}$/.test(databaseName)) {
    return NextResponse.json({ ok: false, error: 'databaseName must be a valid database name or "*"' }, { status: 400 });
  }
  if (!['Union', 'Replace', 'None'].includes(principalsModificationKind)) {
    return NextResponse.json({ ok: false, error: 'principalsModificationKind must be Union, Replace, or None' }, { status: 400 });
  }

  try {
    const item = await loadKustoItem((await ctx.params).id, 'kql-database', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'item not found' }, { status: 404 });

    const configName = makeConfigName(databaseName);
    const result = await attachFollowerDatabase({
      configName,
      leaderClusterResourceId,
      databaseName,
      defaultPrincipalsModificationKind: principalsModificationKind as 'Union' | 'Replace' | 'None',
    });

    // Persist follower state so the editor + query route enforce read-only.
    // databaseName is the resolved DB the editor queries; for follow-all ('*')
    // there is no single DB, so we leave it unset and the user picks per-query.
    const patch: Record<string, any> = {
      isFollower: true,
      followerConfigName: configName,
      followerLeaderCluster: leaderClusterUri || leaderClusterResourceId,
      followerLeaderResourceId: leaderClusterResourceId,
      followerDatabaseName: databaseName,
    };
    if (databaseName !== '*') patch.databaseName = databaseName;
    await saveItemState(item, patch);

    return NextResponse.json({
      ok: true,
      configName,
      provisioningState: result.provisioningState,
      id: result.id,
      databaseName,
      leaderClusterResourceId,
    });
  } catch (e: any) {
    if (e instanceof KustoNotConfiguredError) return notConfigured(e);
    const status = e instanceof KustoArmError ? e.status : e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    const item = await loadKustoItem((await ctx.params).id, 'kql-database', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'item not found' }, { status: 404 });
    const configs = await listAttachedDatabaseConfigurations();
    return NextResponse.json({
      ok: true,
      configs,
      thisItemConfig: item?.state?.followerConfigName || null,
      isFollower: !!item?.state?.isFollower,
    });
  } catch (e: any) {
    if (e instanceof KustoNotConfiguredError) return notConfigured(e);
    const status = e instanceof KustoArmError ? e.status : e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const configName = (searchParams.get('configName') || '').trim();
  if (!configName) {
    return NextResponse.json({ ok: false, error: 'configName query param is required' }, { status: 400 });
  }

  try {
    const item = await loadKustoItem((await ctx.params).id, 'kql-database', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'item not found' }, { status: 404 });
    await detachFollowerDatabase(configName);
    await saveItemState(item, {
      isFollower: false,
      followerConfigName: null,
      followerLeaderCluster: null,
      followerLeaderResourceId: null,
      followerDatabaseName: null,
    });
    return NextResponse.json({ ok: true, detached: configName });
  } catch (e: any) {
    if (e instanceof KustoNotConfiguredError) return notConfigured(e);
    const status = e instanceof KustoArmError ? e.status : e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
