/**
 * Authorization for the /api/storage/[account]/** routes.
 *
 * ── THE CONFUSED DEPUTY THESE ROUTES WERE ───────────────────────────────────
 * Both routes shipped as `withSession` ONLY — authentication, no authorization
 * — while `account` and `container` came straight off the request URL and the
 * listing ran as the Console UAMI, which holds Storage Blob Data Reader (and in
 * places Contributor) across the whole Data Landing Zone. So ANY signed-in
 * session — a workspace-scoped user with no DLZ standing whatsoever — could
 * enumerate every container on every account the UAMI can reach and walk every
 * path inside them, just by typing an account name into the URL.
 *
 * That is a regression against these routes' own siblings, which have always
 * bounded the account/container reachable through them:
 *   - `/api/lakehouse/paths` rejects any container outside KNOWN_CONTAINERS;
 *   - `/api/lakehouse/references/paths` derives the account from a Cosmos item,
 *     checks the workspace's tenant, and allow-lists against that lakehouse's
 *     `ownedContainers`.
 *
 * NOTE ON WHY CI DID NOT CATCH IT: `check-route-guards` reported violations: 0,
 * because it counts `withSession` as a guard SIGNAL. Presence, not enforcement
 * (memory: csa_loom_guard_signals_presence_not_enforcement). A green
 * route-guards run was never evidence about these routes.
 *
 * ── THE MODEL ───────────────────────────────────────────────────────────────
 * The account a caller may drive the UAMI at is bounded by what that caller can
 * ALREADY reach, and everything else needs real authority:
 *
 *   T1  deployment lake — an account named by this deployment's own
 *       LOOM_{BRONZE,SILVER,GOLD,LANDING,CSV_IMPORTS}_URL. Any signed-in
 *       session. This is NOT an escalation: `/api/lakehouse/containers` and
 *       `/api/lakehouse/paths` already serve exactly these accounts to exactly
 *       this population, and have for as long as they have existed.
 *
 *   T2  DLZ authority — tenant admin, or domain admin of at least one domain,
 *       per the shared `denyIfNoDlzAccess`. These are the principals the DLZ
 *       panes already trust with landing-zone-wide infrastructure, which is
 *       precisely what "any account the UAMI can read" is.
 *
 *   T3  workspace-referenced — an account a lakehouse the caller can ACCESS is
 *       bound to (`state.storageAccount`), authorized through the canonical
 *       `authorizeWorkspace` ladder (owner → tenant admin → shared ACL). This
 *       keeps the browse dialog working for the ordinary case it exists for —
 *       an item whose lake lives outside the DLZ — rather than turning that case
 *       into the dead end `auto-bind-by-default.md` forbids.
 *
 * Anything else is denied with an honest 403 that names who can widen it.
 *
 * FAIL CLOSED. If the tenant/domain lookup or the Cosmos probe THROWS, this
 * denies. An authorization check that cannot reach its evidence has verified
 * nothing, and treating "I could not tell" as "allowed" is how a gate becomes
 * decorative (memory: csa_loom_gates_that_measure_nothing).
 */
import type { SessionPayload } from '@/lib/auth/session';
import { tenantScopeId } from '@/lib/auth/session';
import { canAccessDlzPanes } from '@/lib/auth/domain-role';
import { loadTenantDomains } from '@/lib/auth/load-domains';
import { authorizeWorkspace } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

/** The env vars whose URLs name this deployment's own lake account(s). */
const LAKE_URL_ENVS = [
  'LOOM_BRONZE_URL',
  'LOOM_SILVER_URL',
  'LOOM_GOLD_URL',
  'LOOM_LANDING_URL',
  'LOOM_CSV_IMPORTS_URL',
] as const;

export type StorageGrant = 'deployment-lake' | 'dlz-authority' | 'workspace-item';

export type StorageAuthz =
  | { allowed: true; via: StorageGrant }
  | { allowed: false; reason: string };

/**
 * Account names parsed out of this deployment's configured lake container URLs.
 * Read at call time, never memoized — env is re-read on every deploy and a
 * cached empty set from a cold start would deny the DLZ forever.
 */
export function deploymentLakeAccounts(): Set<string> {
  const out = new Set<string>();
  for (const key of LAKE_URL_ENVS) {
    const url = process.env[key];
    if (!url) continue;
    const m = /^https:\/\/([^./]+)\./i.exec(url.trim());
    if (m) out.add(m[1].toLowerCase());
  }
  return out;
}

/**
 * Does a lakehouse the caller can ACCESS bind this storage account?
 *
 * The item query is workspace-blind (items are partitioned by workspace), so
 * each candidate's workspace is put through the CANONICAL ladder in
 * `lib/auth/workspace-guard.ts` — owner → tenant admin → shared ACL.
 *
 * NOT a `workspacesContainer().item(id, tenantId)` point read, which is what
 * this function was written as first and what
 * `/api/lakehouse/references/paths` still does. `check-owner-only-workspace-guard`
 * rejected that shape and was right to: the `workspaces` container is
 * partitioned on `/tenantId`, and `Workspace.tenantId` holds the workspace
 * CREATOR's oid — so a point read there can only answer "did this caller CREATE
 * it?", never "may this caller ACCESS it?". Every non-creator member of a
 * workspace, and every tenant admin, would have been refused a lake their own
 * lakehouse is bound to (#2941/#2942 are two editors that shipped broken on
 * exactly this read).
 *
 * `allowReadRoles: true` — listing containers is a READ, so Viewer and
 * Contributor members qualify; nothing here mutates.
 */
async function boundByAccessibleLakehouse(session: SessionPayload, account: string): Promise<boolean> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query:
        "SELECT c.id, c.workspaceId FROM c WHERE c.itemType = 'lakehouse' "
        + 'AND IS_DEFINED(c.state.storageAccount) AND LOWER(c.state.storageAccount) = @account',
      parameters: [{ name: '@account', value: account }],
    })
    .fetchAll();

  for (const row of resources) {
    if (!row.workspaceId) continue;
    // `authorizeWorkspace` returns a DENIAL response, or null when allowed.
    const denied = await authorizeWorkspace(session, row.workspaceId, { allowReadRoles: true });
    if (!denied) return true;
  }
  return false;
}

/**
 * May `session` drive the Console identity at `account`? Returns the grant that
 * allowed it, or a denial carrying text safe to show the user.
 *
 * `account` must already be shape-validated (`isValidStorageAccount`); this
 * function lower-cases but does not re-validate.
 */
export async function authorizeStorageAccount(
  session: SessionPayload,
  accountRaw: string,
): Promise<StorageAuthz> {
  const account = (accountRaw || '').trim().toLowerCase();

  // T1 — this deployment's own lake. Env-only, no I/O, no Cosmos dependency on
  // the hot path that every adopting editor takes.
  if (deploymentLakeAccounts().has(account)) return { allowed: true, via: 'deployment-lake' };

  try {
    // T2 — landing-zone authority.
    const domains = await loadTenantDomains(tenantScopeId(session));
    if (await canAccessDlzPanes(session, domains)) return { allowed: true, via: 'dlz-authority' };

    // T3 — an account one of this tenant's lakehouses is actually bound to.
    if (await boundByAccessibleLakehouse(session, account)) return { allowed: true, via: 'workspace-item' };
  } catch {
    return {
      allowed: false,
      reason:
        'Loom could not establish whether you may browse this storage account, so it did not browse it. '
        + 'This is a Loom-side failure reading the tenant/domain records, not a statement about your access — retry, '
        + 'and if it persists report it to a tenant admin.',
    };
  }

  return {
    allowed: false,
    reason:
      `You are not authorized to browse the storage account '${account}' through Loom. Browsing an account outside `
      + "this deployment's own data lake runs as the Loom Console identity, which can read across the Data Landing "
      + 'Zone, so it is limited to tenant admins, domain admins, and accounts a lakehouse in your tenant is already '
      + 'bound to. A tenant admin can grant you a domain admin Entra group at /admin/permissions (Domain access).',
  };
}
