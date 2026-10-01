/**
 * ADLS shortcuts and browse share one container scope.
 *
 * The shortcut wizard's ADLS browse and the create route's ADLS target both run
 * on the Console identity, so WHICH storage account and container a caller may
 * reach through them is decided here, once:
 *
 *   1. The lakehouse item is authorized with `authorizeLakehouse` (404 when the
 *      caller cannot reach it; 403 on a read-only role when `write` is asked).
 *   2. The locations the caller may use are
 *        (a) this deployment's lake containers: each configured
 *            `LOOM_<CONTAINER>_URL` paired with the account in that URL; and
 *        (b) every container a lakehouse in the same workspace records
 *            (`state.storageAccount` or the primary lake account, with
 *            `adlsContainer`, `ownedContainers` and the provisioned container;
 *            plus the account and container in the provisioning receipt's
 *            abfss root), when the caller can read that lakehouse.
 *      Recycled lakehouses and non-lakehouse items record nothing here.
 *   3. A tenant admin may use any account and container (`unrestricted`).
 *
 * A failed workspace lookup is 503 `adls_scope_unverified` for a non-admin,
 * never an allow. A location outside the scope is 403 with the allowed
 * locations in the body, so the caller can pick one.
 */
import { NextResponse } from 'next/server';
import { configuredContainerNames, getAccountName, resolveAbfssRoot } from '@/lib/azure/adls-client';
import { dfsUrl } from '@/lib/azure/cloud-endpoints';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import type { SessionPayload } from '@/lib/auth/session';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { authorizeLakehouse } from './item-scope';

/** One storage account + container the caller may reach on the Console identity. */
export interface AdlsLocation {
  /** Storage account name, lower-cased. */
  account: string;
  container: string;
  /** The account's dfs host (sovereign-cloud suffix included). */
  dfsHost: string;
  /** `lake`: this deployment's lake container. `lakehouse`: recorded by a lakehouse in the workspace. */
  source: 'lake' | 'lakehouse';
  /** The lakehouse that records it (`source: 'lakehouse'`). */
  lakehouseName?: string;
}

export interface AdlsScope {
  item: WorkspaceItem;
  /** True for a tenant admin: any account and container. */
  unrestricted: boolean;
  /** The locations above. For a tenant admin these are suggestions, not a limit. */
  locations: AdlsLocation[];
}

/** The storage coordinates a lakehouse item records, as read by {@link workspaceLocations}. */
interface LakehouseStorageRow {
  id: string;
  displayName?: unknown;
  storageAccount?: unknown;
  adlsContainer?: unknown;
  ownedContainers?: unknown;
  provContainer?: unknown;
  provAdlsRoot?: unknown;
}

function hostOf(account: string): string {
  return new URL(dfsUrl(account)).host;
}

/** (a): each configured lake container with the account its URL names. */
function lakeLocations(): AdlsLocation[] {
  const out: AdlsLocation[] = [];
  for (const container of configuredContainerNames()) {
    const m = /^abfss:\/\/[^@/]+@(([^./]+)\.[^/]+)/i.exec(resolveAbfssRoot(container, '') || '');
    if (m) out.push({ account: m[2].toLowerCase(), container, dfsHost: m[1].replace(/\.blob\./i, '.dfs.'), source: 'lake' });
  }
  return out;
}

/** This deployment's primary lake account, lower-cased, or null when none is configured. */
function primaryLakeAccount(): string | null {
  try {
    return getAccountName().toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Every location a lakehouse row records. The account is `state.storageAccount`
 * when set, else the primary lake account; the provisioning receipt's abfss root
 * names its own account and host.
 */
function recordedLocations(row: LakehouseStorageRow, primary: string | null): AdlsLocation[] {
  const out: AdlsLocation[] = [];
  const lakehouseName = typeof row.displayName === 'string' ? row.displayName : undefined;
  const explicit = typeof row.storageAccount === 'string' ? row.storageAccount.trim().toLowerCase() : '';
  const account = explicit || primary;
  const owned = Array.isArray(row.ownedContainers) ? row.ownedContainers : [];
  if (account) {
    for (const c of [row.adlsContainer, row.provContainer, ...owned]) {
      if (typeof c === 'string' && c.trim()) {
        out.push({ account, container: c.trim(), dfsHost: hostOf(account), source: 'lakehouse', lakehouseName });
      }
    }
  }
  if (typeof row.provAdlsRoot === 'string') {
    const m = /^abfss:\/\/([^@/]+)@(([^./]+)\.[^/]+)/i.exec(row.provAdlsRoot.trim());
    if (m) {
      out.push({
        account: m[3].toLowerCase(), container: m[1], dfsHost: m[2].replace(/\.blob\./i, '.dfs.'), source: 'lakehouse', lakehouseName,
      });
    }
  }
  return out;
}

/** (b): the locations readable lakehouses in `lakehouse`'s workspace record. Throws when the lookup fails. */
async function workspaceLocations(session: SessionPayload, lakehouse: WorkspaceItem): Promise<AdlsLocation[]> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<LakehouseStorageRow>(
      {
        query:
          'SELECT c.id, c.displayName, c.state.storageAccount AS storageAccount, c.state.adlsContainer AS adlsContainer, '
          + 'c.state.ownedContainers AS ownedContainers, '
          + 'c.state.provisioning.secondaryIds.container AS provContainer, '
          + 'c.state.provisioning.secondaryIds.adlsRoot AS provAdlsRoot '
          + "FROM c WHERE c.workspaceId = @ws AND c.itemType = 'lakehouse' "
          + 'AND (NOT IS_DEFINED(c.state._recycled) OR c.state._recycled = null)',
        parameters: [{ name: '@ws', value: lakehouse.workspaceId }],
      },
      { partitionKey: lakehouse.workspaceId },
    )
    .fetchAll();
  const primary = primaryLakeAccount();
  const out: AdlsLocation[] = [];
  for (const row of resources) {
    const recorded = recordedLocations(row, primary);
    if (!recorded.length) continue;
    // The requested lakehouse is already authorized; any other one must be readable too.
    if (row.id !== lakehouse.id && !(await resolveItemAccessByOid(session, row.id, 'lakehouse'))) continue;
    out.push(...recorded);
  }
  return out;
}

/** The first entry for each account + container, in input order. */
function distinct(locations: AdlsLocation[]): AdlsLocation[] {
  const seen = new Set<string>();
  return locations.filter((l) => {
    const key = `${l.account}/${l.container}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Authorize `lakehouseId` and resolve the ADLS locations the caller may reach
 * through it. Returns the refusal (404 / 403 read-only / 503) as a NextResponse.
 */
export async function resolveAdlsScope(
  session: SessionPayload,
  lakehouseId: string,
  opts: { write?: boolean; readOnlyMessage?: string } = {},
): Promise<AdlsScope | NextResponse> {
  const access = await authorizeLakehouse(session, lakehouseId, opts);
  if (access instanceof NextResponse) return access;
  let bound: AdlsLocation[] | null;
  try {
    bound = await workspaceLocations(session, access.item);
  } catch {
    bound = null;
  }
  if (isTenantAdmin(session)) {
    // Any account: the locations are offered as suggestions, so a failed lookup only shortens them.
    return { item: access.item, unrestricted: true, locations: distinct([...lakeLocations(), ...(bound ?? [])]) };
  }
  if (bound === null) {
    const error = 'Loom could not read which containers are bound to this workspace, so it did not use the '
      + 'storage account. Retry in a moment; if it persists, ask a tenant admin.';
    return NextResponse.json({ ok: false, code: 'adls_scope_unverified', error, hint: error }, { status: 503 });
  }
  return { item: access.item, unrestricted: false, locations: distinct([...lakeLocations(), ...bound]) };
}

/** May the caller use `container` on `account` under `scope`? */
export function adlsLocationPermitted(scope: AdlsScope, account: string, container: string): boolean {
  if (scope.unrestricted) return true;
  const a = account.trim().toLowerCase();
  const c = container.trim();
  return scope.locations.some((l) => l.account === a && l.container === c);
}

/**
 * The 403 for a location outside `scope`. The body lists the allowed
 * locations (`allowed`) and names what a tenant admin can do.
 */
export function adlsLocationRefusal(scope: AdlsScope, use: 'browse' | 'shortcut'): NextResponse {
  const did = use === 'browse' ? 'did not browse it' : 'did not create the shortcut';
  const error = 'ADLS shortcuts and browse are scoped to the containers bound to this workspace (this '
    + "deployment's lake containers and the containers its lakehouses record), and this storage account and "
    + `container are not one of them, so Loom ${did}. `
    + (scope.locations.length
      ? `Pick one of the ${scope.locations.length} listed in the wizard, or ask a tenant admin, who can create this shortcut for you.`
      : 'None is available yet; ask a tenant admin, who can create this shortcut for you.');
  return NextResponse.json(
    {
      ok: false,
      code: 'adls_location_not_permitted',
      error,
      hint: error,
      allowed: scope.locations.map(({ account, container, dfsHost }) => ({ account, container, dfsHost })),
    },
    { status: 403 },
  );
}
