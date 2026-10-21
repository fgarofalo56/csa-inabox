/**
 * inventory - the read path behind the Copilot `workspace_list`, `item_list`
 * and `governance_inventory` tools (governance-autopilot W1, PRP section 5.9).
 *
 * TWO MEASURED DEFECTS THIS FIXES (re-measured at origin/main 8261467cf):
 *
 *  1. VISIBILITY. `workspace_list` called `listOwnedWorkspaces(ctx.userOid)`
 *     (`app/api/items/_lib/item-crud.ts`, `WHERE c.tenantId = @t`). In the
 *     workspaces container `tenantId` is the OWNER's Entra oid (the partition
 *     key, `lib/types/workspace.ts`), so the tool returned ONLY workspaces the
 *     caller owns - never ACL-shared ones, and never "the whole estate" for a
 *     tenant admin. `item_list` used the access-aware `listAllOwnedItems`, so
 *     its rows referenced workspaces `workspace_list` never returned.
 *  2. TRUNCATION + LATENCY. `item_list` ran `SELECT * FROM c` over the WHOLE
 *     items container (every tenant, every workspace, full `state` blobs),
 *     then resolved workspace access for every distinct workspace in the
 *     estate, then the tool loop cut the JSON at 16,000 characters with no
 *     signal. Here the visible workspace set is resolved ONCE per request and
 *     items are read only for those workspaces, projected to the few fields
 *     needed, and returned through the bounded envelope in
 *     `inventory-envelope.ts`.
 *
 * AUTHORIZATION (recorded decision D10, PRP section 11.1):
 *  - default `scope:'mine'`: the workspaces the caller can access. This is
 *    `listAccessibleWorkspaces` (owned + directly shared), or, when a
 *    `workspaceId` is given, ONE `resolveWorkspaceAccessByOid` point read -
 *    the full resolver, which also honours group shares and the tid boundary.
 *    Known limit, stated in every `mine` envelope: workspaces shared only
 *    through a GROUP membership are not enumerable without a Graph probe per
 *    group (`listAccessibleWorkspaces` documents the same), so they appear
 *    when `workspaceId` is passed.
 *  - `scope:'tenant'`: tenant admins only. The check is `checkCapability(...,
 *    'admin.workspaces', 'Admin')` - the mechanism `loom_resolve_gate` uses
 *    (tenant admins pass its built-in bypass) - on the tool context's session,
 *    OR the ambient request session's admin flag (which carries the group
 *    claims the tool context does not). The fan-out is bounded to the
 *    caller's OWN Entra tenant (`c.tid = @tid`) and FAILS CLOSED when the
 *    session carries no `tid`. A non-admin gets a refusal, never a silent
 *    downgrade to `mine`. Every tenant-scope call - including refusals - emits
 *    one audit event carrying the caller oid.
 */

import type { ToolContext } from '@/lib/azure/copilot-orchestrator';
import type { SessionPayload } from '@/lib/auth/session';
import type { Workspace } from '@/lib/types/workspace';
import { checkCapability } from '@/lib/auth/feature-gate';
import {
  ambientAccessOptsFor,
  listAccessibleWorkspaces,
  resolveWorkspaceAccessByOid,
  type WorkspaceAccessOpts,
} from '@/lib/auth/workspace-access';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { allKeyPaths, resolveBacking, type BackingResolution, type ResolverStatus } from './backing-resolver';
import { InvalidCursorError, clampPageSize, pagingHint, paginate } from './inventory-envelope';

/**
 * Same predicate as `NOT_RECYCLED` in `app/api/items/_lib/item-crud.ts` (a
 * recycled item must not be listed). Duplicated, not imported, so this module
 * does not pull item-crud's provisioning graph; `inventory.test.ts` asserts the
 * two strings stay identical.
 */
export const NOT_RECYCLED_SQL = '(NOT IS_DEFINED(c.state._recycled) OR c.state._recycled = null)';

export type Scope = 'mine' | 'tenant';

export interface Refusal {
  ok: false;
  error: string;
  remediation?: string;
  code?: string;
}

interface VisibleWorkspace {
  id: string;
  name: string;
  description?: string;
  domainId: string | null;
  relationship: 'owned' | 'shared' | 'tenant';
  /** Populated for scope:'tenant' only (admin remit). */
  ownerOid?: string;
}

interface Resolved {
  scope: Scope;
  workspaces: VisibleWorkspace[];
  scopeNote?: string;
}

interface ListArgs {
  scope?: unknown;
  workspaceId?: unknown;
  itemType?: unknown;
  resolverStatus?: unknown;
  cursor?: unknown;
  pageSize?: unknown;
}

const str = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || undefined;
};

const MINE_NOTE =
  'Scope is the workspaces you can access: owned plus directly shared. Workspaces shared with you only through a ' +
  'group membership are not enumerated here (pass workspaceId to open one); a tenant admin can pass scope:"tenant" ' +
  'for the whole tenant.';
const TENANT_NOTE =
  'Scope is every workspace stamped with your Entra tenant. Workspaces created before tenant stamping (no tid) are ' +
  'excluded; /admin/workspaces reports how many.';

// ---------------------------------------------------------------- audit ----

function audit(
  ctx: ToolContext,
  action: string,
  tid: string | undefined,
  outcome: 'success' | 'failure' | 'denied',
  detail: Record<string, unknown>,
  targetId: string,
): void {
  const claims = ctx.session.claims;
  // Read telemetry: stays inside the boundary (webhook:false), per audit-stream.
  emitAuditEvent(
    {
      actorOid: ctx.userOid,
      actorUpn: claims.upn || claims.email || ctx.userOid,
      action,
      targetType: 'workspace-inventory',
      targetId,
      outcome,
      detail,
      tenantId: tid || '',
    },
    { webhook: false },
  );
}

// ------------------------------------------------------------ scope/authz --

async function authorizeTenantScope(
  ctx: ToolContext,
): Promise<{ ok: true; callerTid: string; groups?: string[] } | Refusal> {
  const ambient = await ambientAccessOptsFor(ctx.userOid);
  // Same mechanism as `loom_resolve_gate`: `checkCapability` (tenant admins pass
  // via its built-in bypass), on the capability that gates the tenant-wide
  // workspace inventory (`admin.workspaces`, the /admin/workspaces page). The
  // ambient request session adds the group-claim admins the tool context
  // cannot see. Evaluated on the tool context first so a group-less session
  // still resolves a bootstrap admin.
  const cap = await checkCapability(ctx.session as unknown as SessionPayload, 'admin.workspaces', 'Admin');
  if (!cap.allow && ambient.tenantAdmin !== true) {
    return {
      ok: false,
      code: 'admin_only',
      error:
        'forbidden - scope:"tenant" lists every workspace in the tenant and is available to tenant admins only. ' +
        'Nothing was listed.',
      remediation:
        'Omit scope (or pass scope:"mine") to list the workspaces you can access, or ask a tenant admin to run this.',
    };
  }
  const callerTid = ambient.callerTid;
  if (!callerTid) {
    return {
      ok: false,
      code: 'tenant_unconfirmed',
      error:
        'scope:"tenant" was refused: this session carries no Entra tenant (tid) claim, so the tenant-wide read cannot ' +
        'be limited to your tenant and Loom will not run it unscoped. Nothing was listed.',
      remediation: 'Sign out and sign in again to mint a session that carries tid, then retry.',
    };
  }
  return { ok: true, callerTid, groups: ambient.groups };
}

function toVisible(w: Workspace, relationship: VisibleWorkspace['relationship'], withOwner: boolean): VisibleWorkspace {
  return {
    id: w.id,
    name: w.name,
    ...(w.description ? { description: w.description } : {}),
    domainId: w.domain ?? null,
    relationship,
    ...(withOwner ? { ownerOid: w.ownerOid ?? w.tenantId } : {}),
  };
}

async function resolveVisible(
  ctx: ToolContext,
  scope: Scope,
  workspaceId: string | undefined,
  tenantAuth: { callerTid: string; groups?: string[] } | null,
): Promise<Resolved> {
  const oid = ctx.userOid;

  if (workspaceId) {
    // ONE point read through the full resolver (owner, ACL incl. groups, tid
    // boundary, admin-open). No enumeration, so no per-row resolution.
    const opts: WorkspaceAccessOpts = tenantAuth
      ? { callerTid: tenantAuth.callerTid, groups: tenantAuth.groups, tenantAdmin: true }
      : await ambientAccessOptsFor(oid);
    const access = await resolveWorkspaceAccessByOid(oid, workspaceId, opts);
    if (!access) {
      return {
        scope,
        workspaces: [],
        scopeNote: 'No accessible workspace has that id (it does not exist, or you hold no role on it).',
      };
    }
    const rel = access.via === 'owner' ? 'owned' : access.via === 'acl' ? 'shared' : 'tenant';
    return { scope, workspaces: [toVisible(access.workspace, rel, scope === 'tenant')] };
  }

  if (scope === 'tenant' && tenantAuth) {
    const ws = await workspacesContainer();
    const { resources } = await ws.items
      .query<Workspace>({
        query:
          'SELECT c.id, c.name, c.description, c.domain, c.tenantId, c.ownerOid FROM c WHERE c.tid = @tid',
        parameters: [{ name: '@tid', value: tenantAuth.callerTid }],
      })
      .fetchAll();
    return { scope, workspaces: (resources ?? []).map((w) => toVisible(w, 'tenant', true)), scopeNote: TENANT_NOTE };
  }

  const opts = await ambientAccessOptsFor(oid);
  const list = await listAccessibleWorkspaces(oid, opts);
  return {
    scope,
    workspaces: list.map((w) => toVisible(w, w.tenantId === oid ? 'owned' : 'shared', false)),
    scopeNote: MINE_NOTE,
  };
}

// ----------------------------------------------------------- item reads ----

interface RawItemRow {
  id: string;
  workspaceId: string;
  itemType: string;
  displayName: string;
  [alias: string]: unknown;
}

const IDS_PER_QUERY = 100;
const PATH_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

/**
 * Read items for an already-AUTHORIZED set of workspace ids. Bracket notation
 * on every segment: a key such as `database` or `container` must not be parsed
 * as a SQL keyword. Chunked `IN` queries bound the cross-partition fan-out by
 * the predicate; a single id is a partition read.
 */
async function readItems(
  workspaceIds: readonly string[],
  opts: { itemType?: string; keyPaths?: readonly string[] },
): Promise<{ rows: RawItemRow[]; aliasToPath: Map<string, string> }> {
  const aliasToPath = new Map<string, string>();
  const projections = (opts.keyPaths ?? []).map((p, i) => {
    if (!PATH_RE.test(p)) throw new Error(`refusing to project non-literal key path ${JSON.stringify(p)}`);
    const alias = `k${i}`;
    aliasToPath.set(alias, p);
    return `c.state${p.split('.').map((seg) => `["${seg}"]`).join('')} AS ${alias}`;
  });
  const select = ['c.id', 'c.workspaceId', 'c.itemType', 'c.displayName', ...projections].join(', ');
  const container = await itemsContainer();
  const rows: RawItemRow[] = [];
  for (let i = 0; i < workspaceIds.length; i += IDS_PER_QUERY) {
    const chunk = workspaceIds.slice(i, i + IDS_PER_QUERY);
    const parameters = chunk.map((id, j) => ({ name: `@w${j}`, value: id as string }));
    let query = `SELECT ${select} FROM c WHERE c.workspaceId IN (${parameters.map((p) => p.name).join(', ')}) AND ${NOT_RECYCLED_SQL}`;
    if (opts.itemType) {
      query += ' AND c.itemType = @t';
      parameters.push({ name: '@t', value: opts.itemType });
    }
    const { resources } = await container.items
      .query<RawItemRow>({ query, parameters }, chunk.length === 1 ? { partitionKey: chunk[0] } : undefined)
      .fetchAll();
    rows.push(...(resources ?? []));
  }
  return { rows, aliasToPath };
}

// ------------------------------------------------------------ plumbing -----

/** Parse, authorize, resolve, audit, and turn every failure into an honest error. */
async function runListTool(
  ctx: ToolContext,
  args: ListArgs,
  auditAction: string,
  build: (resolved: Resolved) => Promise<{ envelope: Record<string, unknown>; total: number; returned: number }>,
): Promise<unknown> {
  const rawScope = str(args.scope)?.toLowerCase();
  if (rawScope !== undefined && rawScope !== 'mine' && rawScope !== 'tenant') {
    return { ok: false, error: `scope must be "mine" or "tenant" (got ${JSON.stringify(rawScope)}).` };
  }
  const scope: Scope = rawScope === 'tenant' ? 'tenant' : 'mine';
  const workspaceId = str(args.workspaceId);

  let tenantAuth: { callerTid: string; groups?: string[] } | null = null;
  if (scope === 'tenant') {
    const auth = await authorizeTenantScope(ctx);
    if (!auth.ok) {
      audit(ctx, auditAction, undefined, 'denied', { scope, code: auth.code, workspaceId: workspaceId ?? null }, workspaceId ?? 'tenant');
      return auth;
    }
    tenantAuth = auth;
  }

  try {
    const resolved = await resolveVisible(ctx, scope, workspaceId, tenantAuth);
    const built = await build(resolved);
    if (tenantAuth) {
      audit(
        ctx,
        auditAction,
        tenantAuth.callerTid,
        'success',
        { scope, workspaceId: workspaceId ?? null, itemType: str(args.itemType) ?? null, total: built.total, returned: built.returned },
        workspaceId ?? 'tenant',
      );
    }
    return built.envelope;
  } catch (e) {
    if (tenantAuth) {
      audit(ctx, auditAction, tenantAuth.callerTid, 'failure', { scope, workspaceId: workspaceId ?? null, error: (e as Error)?.message ?? String(e) }, workspaceId ?? 'tenant');
    }
    if (e instanceof InvalidCursorError) {
      return { ok: false, error: e.message };
    }
    // R7: state what happened, not a cause that was not established.
    return {
      ok: false,
      error: `Loom could not read the inventory: ${(e as Error)?.message ?? String(e)}. No rows were returned and this is NOT an empty estate.`,
      remediation:
        'Retry; if it persists, check /admin/readiness for the Cosmos DB (data plane) gate and the Console identity data-plane role.',
    };
  }
}

function page<T>(rows: T[], keyOf: (r: T) => string, args: ListArgs, tool: string) {
  const p = paginate(rows, keyOf, { cursor: str(args.cursor), pageSize: clampPageSize(args.pageSize) });
  const hint = pagingHint(p, tool);
  return { p, hint };
}

// ----------------------------------------------------------------- tools ---

export async function workspaceListTool(ctx: ToolContext, args: ListArgs): Promise<unknown> {
  return runListTool(ctx, args, 'copilot.workspace_list.tenant', async (resolved) => {
    const { p, hint } = page(resolved.workspaces, (w) => `${w.name.toLowerCase()}|${w.id}`, args, 'workspace_list');
    return {
      total: p.total,
      returned: p.returned,
      envelope: {
        ok: true,
        scope: resolved.scope,
        workspaces: p.rows,
        total: p.total,
        returned: p.returned,
        truncated: p.truncated,
        nextCursor: p.nextCursor,
        ...(hint ? { hint } : {}),
        ...(resolved.scopeNote ? { scopeNote: resolved.scopeNote } : {}),
      },
    };
  });
}

export async function itemListTool(ctx: ToolContext, args: ListArgs): Promise<unknown> {
  return runListTool(ctx, args, 'copilot.item_list.tenant', async (resolved) => {
    const names = new Map(resolved.workspaces.map((w) => [w.id, w.name]));
    const { rows } = resolved.workspaces.length
      ? await readItems([...names.keys()], { itemType: str(args.itemType) })
      : { rows: [] as RawItemRow[] };
    const shaped = rows.map((it) => ({
      id: it.id,
      itemType: it.itemType,
      displayName: String(it.displayName ?? '').slice(0, 200),
      workspaceId: it.workspaceId,
      workspaceName: names.get(it.workspaceId) ?? null,
    }));
    const { p, hint } = page(shaped, (r) => `${r.workspaceId}|${r.id}`, args, 'item_list');
    return {
      total: p.total,
      returned: p.returned,
      envelope: {
        ok: true,
        scope: resolved.scope,
        items: p.rows,
        total: p.total,
        returned: p.returned,
        truncated: p.truncated,
        nextCursor: p.nextCursor,
        ...(hint ? { hint } : {}),
        ...(resolved.scopeNote ? { scopeNote: resolved.scopeNote } : {}),
      },
    };
  });
}

export interface InventoryRow extends Omit<BackingResolution, 'reason'> {
  itemId: string;
  itemType: string;
  workspaceId: string;
  workspaceName: string | null;
  domainId: string | null;
  /** Why `resolverStatus` is `no-backing-key` (null otherwise). */
  reason: BackingResolution['reason'];
  /**
   * `null` = NOT YET MEASURED. Nothing populates these until the enrollment
   * service (W2+) records bindings; do not read null as "false".
   */
  governance: { registered: boolean | null; scanned: boolean | null };
}

const RESOLVER_STATUSES: readonly ResolverStatus[] = ['resolved', 'no-backing-key', 'not-applicable'];

export async function governanceInventoryTool(ctx: ToolContext, args: ListArgs): Promise<unknown> {
  const wantStatus = str(args.resolverStatus)?.toLowerCase();
  if (wantStatus && !RESOLVER_STATUSES.includes(wantStatus as ResolverStatus)) {
    return { ok: false, error: `resolverStatus must be one of ${RESOLVER_STATUSES.join(', ')} (got ${JSON.stringify(wantStatus)}).` };
  }
  return runListTool(ctx, args, 'governance.inventory', async (resolved) => {
    const byId = new Map(resolved.workspaces.map((w) => [w.id, w]));
    const { rows, aliasToPath } = resolved.workspaces.length
      ? await readItems([...byId.keys()], { itemType: str(args.itemType)?.toLowerCase(), keyPaths: allKeyPaths() })
      : { rows: [] as RawItemRow[], aliasToPath: new Map<string, string>() };

    const all: InventoryRow[] = rows.map((it) => {
      const values: Record<string, unknown> = {};
      for (const [alias, path] of aliasToPath) if (it[alias] !== undefined) values[path] = it[alias];
      const ws = byId.get(it.workspaceId);
      const { reason, ...backing } = resolveBacking(it.itemType, values);
      return {
        itemId: it.id,
        itemType: it.itemType,
        workspaceId: it.workspaceId,
        workspaceName: ws?.name ?? null,
        domainId: ws?.domainId ?? null,
        ...backing,
        reason,
        governance: { registered: null, scanned: null },
      };
    });
    const filtered = wantStatus ? all.filter((r) => r.resolverStatus === wantStatus) : all;

    // Summary over the WHOLE filtered set (not just this page), so a model can
    // see the gap list without paging. `noBackingKey` is what W2 must fix.
    const byStatus: Record<ResolverStatus, number> = { resolved: 0, 'no-backing-key': 0, 'not-applicable': 0 };
    const gap = new Map<string, { itemType: string; reason: InventoryRow['reason']; count: number }>();
    for (const r of filtered) {
      byStatus[r.resolverStatus] += 1;
      if (r.resolverStatus === 'no-backing-key') {
        const k = `${r.itemType}|${r.reason}`;
        const cur = gap.get(k) ?? { itemType: r.itemType, reason: r.reason, count: 0 };
        cur.count += 1;
        gap.set(k, cur);
      }
    }

    const { p, hint } = page(filtered, (r) => `${r.workspaceId}|${r.itemId}`, args, 'governance_inventory');
    return {
      total: p.total,
      returned: p.returned,
      envelope: {
        ok: true,
        scope: resolved.scope,
        items: p.rows,
        total: p.total,
        returned: p.returned,
        truncated: p.truncated,
        nextCursor: p.nextCursor,
        ...(hint ? { hint } : {}),
        summary: { byResolverStatus: byStatus, noBackingKey: [...gap.values()] },
        ...(resolved.scopeNote ? { scopeNote: resolved.scopeNote } : {}),
      },
    };
  });
}
