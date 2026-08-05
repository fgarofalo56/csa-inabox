/**
 * #2988 — EXECUTION-coordinate binding for the `databricks-notebook` run family.
 *
 * THE HOLE THIS CLOSES. `POST /api/items/databricks-notebook/[id]/command` took
 * a caller-chosen `clusterId`, a caller-chosen `contextId`, and an ARBITRARY
 * `command` string, and ran NO workspace authorization at all — its handler did
 * not even accept `ctx.params`, so `[id]` was not merely unenforced, it was
 * never read. `[id]/context` was identical. The Console's UAMI holds
 * workspace-wide access to the ONE shared Databricks workspace every Loom tenant
 * sits on, so any signed-in user could execute arbitrary code AS THE CONSOLE on
 * a shared cluster. That is arbitrary code execution, not information
 * disclosure: it subsumes every data-access hole in this family, because
 * anything reachable from a Databricks execution context — other tenants'
 * notebooks, mounted storage, cluster-scoped secrets — is reachable from a
 * single `command`.
 *
 * Sibling of `_lib/notebook-path-scope.ts` (#2977/#2985), which binds the
 * WORKSPACE-PATH coordinate. This module binds the two EXECUTION coordinates the
 * path module does not cover, and the same two-layer rule applies — both layers
 * are required, neither is sufficient:
 *
 *   LAYER 1 — AUTHORIZE THE CALLER against the notebook ITEM.
 *     {@link authorizeNotebookItem} runs the canonical `authorizeItemWorkspace`
 *     ladder (owner → tenant-admin → shared-ACL), WRITE-scoped: `allowReadRoles`
 *     is deliberately never passed, because every handler here EXECUTES. A
 *     read-only Viewer must not be able to run code merely because a read was
 *     made to work. The workspace is resolved FROM THE ITEM when the caller
 *     omits `workspaceId`, so authorization cannot be skipped by dropping a
 *     parameter.
 *
 *   LAYER 2 — BIND THE COORDINATES to that authorized item. Authorizing the
 *     caller alone is NOT sufficient — that is exactly the `[id]/schedule`
 *     defect called out in #2988, where an authorized caller could still
 *     schedule a job running ANOTHER tenant's notebook path. Concretely here:
 *
 *       * `clusterId` — {@link resolveAuthorizedClusterId}. Omitted, it is
 *         DERIVED server-side from the platform's own resolver (never a 400 the
 *         caller can route around). Supplied, it is validated against the set of
 *         clusters this deployment is actually entitled to run — a cluster id
 *         from a different workspace, or a JOB/PIPELINE/SQL-source cluster
 *         (another tenant's dedicated compute, which may carry cluster-scoped
 *         secrets or credential passthrough), is refused.
 *
 *       * `contextId` — {@link mintExecContextHandle} /
 *         {@link verifyExecContextHandle}. A REPL execution context is LIVE
 *         STATE: variables, imports, temp views, and any credentials a previous
 *         command materialised in it. A raw, guessable/replayable context id let
 *         a caller attach to a context another tenant's session created and
 *         inherit all of it. Contexts are therefore never handed out raw — the
 *         route returns an HMAC handle bound to (item, cluster, language), and
 *         only a handle that verifies against THIS item's scope is honoured.
 *
 * Both are enforced AFTER layer 1, so an unauthorized caller never reaches
 * either.
 */
import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { listClusters, isAllPurposeCluster } from '@/lib/azure/databricks-client';
import { ensureRunnableCluster } from '@/lib/azure/databricks-default-cluster';
import { DBX_NOTEBOOK_ITEM_TYPE, loadNotebookItemRaw } from './notebook-path-scope';
import type { WorkspaceItem } from '@/lib/types/workspace';

/** The 404 wording these routes already use — kept so the editor's handling is unchanged. */
export const NOTEBOOK_NOT_FOUND = 'notebook not found';

// ── Layer 1: authorize the caller against the item ───────────────────────────

export type NotebookAuthz =
  | { item: WorkspaceItem; denied?: undefined }
  | { item?: undefined; denied: NextResponse };

/**
 * Session → WRITE-scoped workspace authorization → the resolved item.
 *
 * `allowReadRoles` is intentionally NOT a parameter. Every consumer of this
 * module executes code or mutates Databricks state, so there is no read-only
 * caller to admit; making it inexpressible means a future edit cannot widen the
 * scope of an executing route by adding one word (the `allowReadRoles: true`
 * regression class this program has already hit once).
 *
 * `authorizeItemWorkspace`'s one permissive case — an `[id]` naming no item of
 * this type anywhere in the estate — is closed here rather than inherited: with
 * no item there is no scope to bind coordinates to, so we return the route's own
 * 404 instead of proceeding to Databricks unbound. Fail closed, not fall through.
 */
export async function authorizeNotebookItem(
  itemId: string,
  workspaceId?: string | null,
): Promise<NotebookAuthz> {
  const session = getSession();
  if (!session) {
    return { denied: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }) };
  }
  const denied = await authorizeItemWorkspace(session, {
    workspaceId: workspaceId ?? null,
    itemId,
    itemType: DBX_NOTEBOOK_ITEM_TYPE,
    notFound: NOTEBOOK_NOT_FOUND,
  });
  if (denied) return { denied };
  const item = await loadNotebookItemRaw(itemId);
  if (!item) {
    return { denied: NextResponse.json({ ok: false, error: NOTEBOOK_NOT_FOUND }, { status: 404 }) };
  }
  return { item };
}

// ── Layer 2a: bind the cluster coordinate ────────────────────────────────────

export type ClusterBinding =
  | { ok: true; clusterId: string }
  | { ok: false; status: number; error: string; remediation?: string };

/**
 * The set of Databricks clusters this deployment is entitled to execute on.
 *
 * `isAllPurposeCluster` is the security-relevant filter, not just a usability
 * one: `clusters/list` also returns JOB / PIPELINE / MODELS / SQL clusters —
 * ephemeral compute created for someone else's workload, which can carry that
 * workload's cluster-scoped secrets and credential passthrough. Only UI/API
 * (all-purpose) clusters are legitimate interactive targets.
 *
 * `LOOM_DATABRICKS_CLUSTER_ID` is unioned in because it is the operator's
 * explicit override and `ensureRunnableCluster` honours it without listing.
 */
async function entitledClusterIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const explicit = (process.env.LOOM_DATABRICKS_CLUSTER_ID || '').trim();
  if (explicit) ids.add(explicit);
  const clusters = await listClusters();
  for (const c of clusters) {
    if (c.cluster_id && isAllPurposeCluster(c)) ids.add(c.cluster_id);
  }
  return ids;
}

/**
 * Resolve the cluster this request may execute on.
 *
 * OMITTED → derived from the platform's own `ensureRunnableCluster` (the same
 * resolver `[id]/ensure-cluster` and the install provisioners use). Deriving
 * rather than 400-ing matters for two reasons: per `auto-bind-by-default.md` the
 * platform picks the compute, not the user; and a required-parameter error is a
 * shape a caller can probe around, whereas a derived value is not caller-influenced
 * at all.
 *
 * SUPPLIED → must be a member of {@link entitledClusterIds}. The notebook editor
 * legitimately lets a user pick from `/api/items/databricks-cluster`, so the
 * choice stays configurable — but only within what the workspace is actually
 * entitled to, which is the "validate it against entitlement" half of #2988.
 *
 * FAIL CLOSED. If the entitled set cannot be enumerated (Databricks unconfigured,
 * UAMI lacks list RBAC), a caller-supplied cluster is REFUSED rather than passed
 * through — an unverifiable coordinate is not an authorized one.
 */
export async function resolveAuthorizedClusterId(
  requested: unknown,
  opts?: { autoStart?: boolean },
): Promise<ClusterBinding> {
  const asked = typeof requested === 'string' ? requested.trim() : '';

  if (!asked) {
    const res = await ensureRunnableCluster({ autoStart: opts?.autoStart ?? true });
    if (res.gate || !res.clusterId) {
      return {
        ok: false,
        status: 502,
        error: res.gate?.reason || 'No runnable Databricks cluster could be resolved.',
        ...(res.gate?.remediation ? { remediation: res.gate.remediation } : {}),
      };
    }
    return { ok: true, clusterId: res.clusterId };
  }

  let entitled: Set<string>;
  try {
    entitled = await entitledClusterIds();
  } catch (e: any) {
    return {
      ok: false,
      status: 502,
      error: `Could not verify the requested cluster: ${e?.message || String(e)}`,
      remediation:
        'Grant the Console UAMI workspace access on the Databricks workspace (SCIM bootstrap) ' +
        'so it can list clusters, or set LOOM_DATABRICKS_CLUSTER_ID.',
    };
  }
  if (!entitled.has(asked)) {
    return {
      ok: false,
      status: 403,
      error: 'clusterId is not an all-purpose cluster this workspace is entitled to run.',
    };
  }
  return { ok: true, clusterId: asked };
}

// ── Layer 2b: bind the execution-context coordinate ──────────────────────────

/** Opaque-handle prefix. Distinct from any other Loom token so it cannot be cross-used. */
export const EXEC_CTX_PREFIX = 'loom_dbxctx_';

/** The (item, cluster, language) triple a context handle is bound to. */
export interface ExecContextScope {
  itemId: string;
  clusterId: string;
  language: string;
}

/**
 * HMAC key, HKDF-derived from the already-required `SESSION_SECRET` under a
 * DISTINCT `info` label — the same pattern `session.ts` and `embed-token.ts`
 * use. So a context handle can never be replayed as a session cookie or an embed
 * token (or vice-versa), and this adds NO new secret to the deployment.
 */
function execCtxKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not configured');
  const ab = crypto.hkdfSync(
    'sha256',
    Buffer.from(secret, 'utf-8'),
    Buffer.alloc(32),
    Buffer.from('loom-dbx-exec-context-v1'),
    32,
  );
  return Buffer.from(ab as ArrayBuffer);
}

/** Canonical signing input — the scope is signed WITH the context id, so a valid
 *  signature for one item is not a valid signature for another. */
function ctxPayload(scope: ExecContextScope, contextId: string): string {
  return Buffer.from(
    JSON.stringify({
      c: contextId,
      i: scope.itemId,
      k: scope.clusterId,
      l: scope.language,
    }),
    'utf-8',
  ).toString('base64url');
}

/**
 * Mint the opaque handle a route returns in place of the raw Databricks context
 * id. The editor round-trips `contextId` verbatim (it only ever stores and
 * re-sends what the route gave it), so this is wire-compatible.
 */
export function mintExecContextHandle(scope: ExecContextScope, contextId: string): string {
  const payload = ctxPayload(scope, contextId);
  const sig = crypto.createHmac('sha256', execCtxKey()).update(payload).digest('base64url');
  return `${EXEC_CTX_PREFIX}${payload}.${sig}`;
}

/**
 * Verify a caller-supplied handle against the scope THIS request authorized, and
 * return the underlying Databricks context id — or `null` for ANY failure
 * (missing, malformed, wrong signature, or signed for a different item / cluster
 * / language). Never throws: a bad handle is simply a denied reuse.
 *
 * The scope fields are BOTH signed and re-compared. Signature alone would let a
 * handle minted for item A be replayed against item B; the comparison alone
 * would be forgeable. Both together mean a caller can only ever reuse a context
 * this platform minted for this exact item + cluster + language.
 */
export function verifyExecContextHandle(
  scope: ExecContextScope,
  handle: unknown,
): string | null {
  const raw = typeof handle === 'string' ? handle.trim() : '';
  if (!raw.startsWith(EXEC_CTX_PREFIX)) return null;
  const rest = raw.slice(EXEC_CTX_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot >= rest.length - 1) return null;
  const payload = rest.slice(0, dot);
  const providedB64 = rest.slice(dot + 1);

  let expected: Buffer;
  try {
    expected = crypto.createHmac('sha256', execCtxKey()).update(payload).digest();
  } catch {
    return null;
  }
  let provided: Buffer;
  try {
    provided = Buffer.from(providedB64, 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;

  let claims: { c?: unknown; i?: unknown; k?: unknown; l?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object') return null;
  if (claims.i !== scope.itemId || claims.k !== scope.clusterId || claims.l !== scope.language) {
    return null;
  }
  return typeof claims.c === 'string' && claims.c ? claims.c : null;
}
