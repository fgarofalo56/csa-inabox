/**
 * GET /api/onelake/storage[?workspaceId=&itemId=]
 *
 * OneLake **item-size reporting** — aggregates the ADLS Gen2 storage each
 * OneLake item in the tenant consumes, broken out into live data, system /
 * metadata files (Delta `_delta_log/`, checkpoints, `_SUCCESS`…), and
 * soft-deleted bytes still billed during the retention window. This is the
 * Azure-native parity for the Fabric "OneLake — item storage" view (per-item
 * workspace storage usage, refreshed on demand).
 *
 * Azure-native is the DEFAULT (per .claude/rules/no-fabric-dependency.md). The
 * route never touches a Fabric / OneLake REST host: it resolves each item's
 * ADLS prefix from its own Cosmos state (state.provisioning.secondaryIds.
 * {container,rootPath} written by the provisioner, with resourceId / legacy
 * state.container fallbacks) and walks the prefix via adls-client. Both the live
 * recursive listPaths walk and the soft-deleted blob walk hit the storage
 * account itself, on the sovereign-correct .dfs / .blob hosts.
 *
 * On-demand: force-dynamic + no caching — every GET re-walks the live storage so
 * the number is current (matching Fabric's "Refresh" affordance).
 *
 * Tenant scoping: an item is in scope only when its parent workspace's tenantId
 * matches the caller's oid (same model as /api/items/by-type + /recycle).
 *
 * Honest gate (no-vaporware.md): when no DLZ ADLS container URL is configured
 * the route returns 503 naming LOOM_BRONZE_URL + the data-landing-zone module —
 * never a fabricated number.
 *
 * No mocks, no return [] placeholders — real storage walks or an honest gate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { ONELAKE_TYPES } from '@/lib/catalog/onelake-types';
import {
  aggregatePrefixUsage,
  getAccountName,
  KNOWN_CONTAINERS,
  type PrefixUsage,
} from '@/lib/azure/adls-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ItemUsageDto {
  id: string;
  itemType: string;
  workspaceId: string;
  displayName: string;
  /** Resolved ADLS location "<container>/<rootPath>" — null when the item has
   *  no materialised Azure-native ADLS backing (e.g. a Fabric-opt-in or
   *  ADX/KQL item that stores nothing in the DLZ account). */
  location: string | null;
  /** Usage breakdown — null (with a `reason`) when location is unresolved or the
   *  walk could not run for this item. */
  usage: PrefixUsage | null;
  /** Why usage is null, for an honest per-item note (never a fabricated number). */
  reason?: string;
}

/** A resolved ADLS prefix for one item, or null if it has no DLZ backing. */
interface ResolvedPrefix {
  container: string;
  prefix: string;
}

const KNOWN = new Set<string>(KNOWN_CONTAINERS as readonly string[]);

/**
 * Resolve a OneLake item's {container, prefix} inside the DLZ account from its
 * persisted Cosmos state. Order of precedence:
 *   1. state.provisioning.secondaryIds.{container,rootPath}  (Azure-native lakehouse)
 *   2. state.provisioning.resourceId = "<container>/<rootPath>"
 *   3. legacy top-level state.{container,rootPath}
 *   4. state.provisioning.secondaryIds.adlsRoot (abfss://<container>@host/<path>)
 * Returns null when the item stores nothing in a known DLZ container.
 */
function resolveItemPrefix(state: any): ResolvedPrefix | null {
  const prov = state?.provisioning ?? {};
  const sec = (prov?.secondaryIds ?? {}) as Record<string, string>;

  const tryPair = (c?: string, p?: string): ResolvedPrefix | null => {
    if (!c) return null;
    const container = String(c).trim();
    if (!KNOWN.has(container)) return null;
    return { container, prefix: String(p ?? '').replace(/^\/+|\/+$/g, '') };
  };

  // 1. secondaryIds.container + rootPath
  const fromSec = tryPair(sec.container, sec.rootPath);
  if (fromSec) return fromSec;

  // 2. resourceId "container/rootPath"
  if (typeof prov.resourceId === 'string' && prov.resourceId.includes('/')) {
    const [c, ...rest] = prov.resourceId.split('/');
    const fromRid = tryPair(c, rest.join('/'));
    if (fromRid) return fromRid;
  }

  // 3. legacy top-level state.container / state.rootPath
  const fromState = tryPair(state?.container, state?.rootPath);
  if (fromState) return fromState;

  // 4. abfss://<container>@<host>/<path> (mirrored-database adlsRoot, etc.)
  const abfss = sec.adlsRoot || state?.adlsRoot;
  if (typeof abfss === 'string') {
    const m = abfss.match(/^abfss:\/\/([^@]+)@[^/]+\/(.*)$/i);
    if (m) {
      const fromAbfss = tryPair(m[1], m[2]);
      if (fromAbfss) return fromAbfss;
    }
  }

  return null;
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const wsFilter = sp.get('workspaceId')?.trim() || undefined;
  const itemFilter = sp.get('itemId')?.trim() || undefined;

  // Honest infra gate — the DLZ storage account must be wired in. Name the env
  // var + bicep module rather than inventing a host (no-vaporware.md).
  let account: string;
  try {
    account = getAccountName();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        code: 'adls_not_configured',
        error:
          'OneLake item-size reporting needs the DLZ storage account. Set LOOM_BRONZE_URL ' +
          '(or LOOM_SILVER_URL / LOOM_GOLD_URL / LOOM_LANDING_URL) to the ADLS Gen2 container ' +
          'URL emitted by platform/fiab/bicep — see the data-landing-zone module.',
        hint: {
          missingEnvVar: 'LOOM_BRONZE_URL',
          bicepModule: 'platform/fiab/bicep/modules/data-plane/data-landing-zone.bicep',
        },
      },
      { status: 503 },
    );
  }

  // ── Candidate OneLake items (Cosmos) ──
  const items = await itemsContainer();
  const orClauses = ONELAKE_TYPES.map((_, i) => `c.itemType = @t${i}`).join(' OR ');
  const params = ONELAKE_TYPES.map((t, i) => ({ name: `@t${i}`, value: t }));
  const { resources: candidates } = await items.items
    .query<any>({
      query:
        `SELECT c.id, c.itemType, c.workspaceId, c.displayName, c.state FROM c ` +
        `WHERE (${orClauses}) AND (NOT IS_DEFINED(c.state._recycled) OR c.state._recycled = null)`,
      parameters: params,
    })
    .fetchAll();

  // ── Tenant-filter by workspace ownership (cached single-partition reads) ──
  const ws = await workspacesContainer();
  const ownCache = new Map<string, boolean>();
  const owned: any[] = [];
  for (const it of candidates) {
    if (wsFilter && it.workspaceId !== wsFilter) continue;
    if (itemFilter && it.id !== itemFilter) continue;
    let isOwned = ownCache.get(it.workspaceId);
    if (isOwned === undefined) {
      try {
        const { resource } = await ws.item(it.workspaceId, s.claims.oid).read<any>();
        isOwned = !!resource && resource.tenantId === s.claims.oid;
      } catch {
        isOwned = false;
      }
      ownCache.set(it.workspaceId, isOwned);
    }
    if (isOwned) owned.push(it);
  }

  // ── Walk each item's ADLS prefix (bounded concurrency) ──
  const CONCURRENCY = 6;
  const out: ItemUsageDto[] = new Array(owned.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= owned.length) return;
      const it = owned[i];
      const resolved = resolveItemPrefix(it.state);
      if (!resolved) {
        out[i] = {
          id: it.id,
          itemType: it.itemType,
          workspaceId: it.workspaceId,
          displayName: it.displayName,
          location: null,
          usage: null,
          reason:
            'No Azure-native ADLS Gen2 backing for this item (it stores nothing in ' +
            'the DLZ account — e.g. a KQL/ADX-backed item or a Fabric-opt-in item).',
        };
        continue;
      }
      try {
        const usage = await aggregatePrefixUsage(resolved.container, resolved.prefix, account);
        out[i] = {
          id: it.id,
          itemType: it.itemType,
          workspaceId: it.workspaceId,
          displayName: it.displayName,
          location: `${resolved.container}/${resolved.prefix}`,
          usage,
        };
      } catch (e: any) {
        const status = e?.statusCode;
        out[i] = {
          id: it.id,
          itemType: it.itemType,
          workspaceId: it.workspaceId,
          displayName: it.displayName,
          location: `${resolved.container}/${resolved.prefix}`,
          usage: null,
          reason:
            status === 403
              ? `Forbidden (403) — grant the Console managed identity (LOOM_UAMI_CLIENT_ID) ` +
                `the Storage Blob Data Reader role on the DLZ storage account '${account}'.`
              : e?.message || 'Storage walk failed for this item.',
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, owned.length || 1) }, worker));

  // ── Tenant totals over the items that resolved ──
  const totals = out.reduce(
    (acc, r) => {
      if (r.usage) {
        acc.liveBytes += r.usage.liveBytes;
        acc.systemBytes += r.usage.systemBytes;
        acc.deletedBytes += r.usage.deletedBytes;
        acc.totalBytes += r.usage.totalBytes;
        acc.liveFiles += r.usage.liveFiles;
        acc.deletedFiles += r.usage.deletedFiles;
        acc.reportedItems += 1;
        if (r.usage.capped) acc.capped = true;
      }
      return acc;
    },
    {
      liveBytes: 0,
      systemBytes: 0,
      deletedBytes: 0,
      totalBytes: 0,
      liveFiles: 0,
      deletedFiles: 0,
      reportedItems: 0,
      capped: false,
    },
  );

  // Largest items first — the most actionable ordering for storage cleanup.
  out.sort((a, b) => (b.usage?.totalBytes ?? -1) - (a.usage?.totalBytes ?? -1));

  return NextResponse.json({
    ok: true,
    account,
    refreshedAt: new Date().toISOString(),
    items: out,
    totals,
  });
}
