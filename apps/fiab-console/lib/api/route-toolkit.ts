/**
 * WS-D1 — route-handler toolkit: higher-order wrappers that factor out the
 * session / owner / gate / error boilerplate every BFF route hand-rolls today.
 *
 * The idioms these capture (grounded in the real routes, not invented):
 *   - `const s = getSession(); if (!s) return 401`                → withSession
 *   - `… ; const item = await loadOwnedItem(id, type, s.claims.oid);
 *      if (!item) return 404`                                     → withWorkspaceOwner
 *   - `const g = xConfigGate(); if (g) return 503 not_configured` → withBackendGate
 *   - `… ; const gate = requireTenantAdmin(s); if (gate) return gate` → withTenantAdmin
 *   - `… ; const denied = await denyIfNoDlzAccess(s, pane);
 *      if (denied) return denied`                                  → withDlzAccess
 *
 * They COMPOSE with — never replace — the response helpers in ./respond
 * (`apiOk` / `apiError` / `apiUnauthorized` / `apiNotFound` / `apiServerError` /
 * `apiHonestError`) and the gate envelope in ./gate-envelope. The wrapped
 * handler receives an augmented context carrying the already-resolved
 * `session` (and, for owner routes, the already-loaded `item`) so the body is
 * pure work — no repeated auth plumbing.
 *
 * Authorization is REAL (no-vaporware / no weakening): `withSession` runs the
 * exact cookie `getSession()`; `withWorkspaceOwner` runs the exact
 * `loadOwnedItem` owner/workspace-ACL check (write-scoped by default, read-role
 * opt-in) that the checker recognizes as a guard signal; `withBackendGate` runs
 * the registry `gateStatus` env-presence check. Adopting a wrapper leaves a
 * route's auth + responses byte-compatible.
 *
 * Server-only: imports the Cosmos-backed item-crud helpers — never import into a
 * client component.
 */
import type { NextRequest, NextResponse } from 'next/server';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { denyIfNoDlzAccess, type DlzPane } from '@/lib/auth/dlz-gate';
import { apiUnauthorized, apiNotFound, apiServerError } from './respond';
import { backendGateResponse, type GateEnvelopeOpts } from './gate-envelope';

/** Next.js route context — `params` is a Promise in the app router. */
export interface RouteContext<P> {
  params: Promise<P>;
}

/** A raw Next.js route handler (what gets exported as GET/POST/…). */
export type RouteHandler<P> = (
  req: NextRequest,
  ctx: RouteContext<P>,
) => Promise<Response> | Response;

/** Context handed to a session-scoped handler — session + resolved params. */
export interface SessionContext<P> {
  session: SessionPayload;
  /** The awaited route params ({} for a no-param route). */
  params: P;
}

/** Context handed to an owner-scoped handler — adds the loaded, owned item. */
export interface OwnerContext<P> extends SessionContext<P> {
  item: WorkspaceItem;
}

type SessionHandler<P> = (
  req: NextRequest,
  ctx: SessionContext<P>,
) => Promise<Response> | Response;

type OwnerHandler<P> = (
  req: NextRequest,
  ctx: OwnerContext<P>,
) => Promise<Response> | Response;

async function resolveParams<P>(ctx: RouteContext<P> | undefined): Promise<P> {
  if (ctx && ctx.params) return ctx.params;
  return {} as P;
}

/**
 * Require a signed-in session. Returns `apiUnauthorized()` (401 `{ ok:false,
 * error:'unauthenticated' }`) when there is none, otherwise invokes `handler`
 * with the resolved session + params. This is the base every other wrapper
 * composes on. An unexpected throw from `handler` is genericized through
 * `apiServerError` (safe 500 + server-side log) — the same try/catch → 500
 * discipline the hand-rolled routes use, so no stack trace / SQL leaks.
 */
export function withSession<P = Record<string, string>>(handler: SessionHandler<P>): RouteHandler<P> {
  return async (req, ctx) => {
    const session = getSession();
    if (!session) return apiUnauthorized();
    try {
      const params = await resolveParams(ctx);
      return await handler(req, { session, params });
    } catch (e) {
      return apiServerError(e);
    }
  };
}

/** Options forwarded to `loadOwnedItem` (read-role opt-in for GET routes). */
export interface WorkspaceOwnerOpts {
  /** Admit shared read-only (Viewer/Contributor) roles — use on read-only GETs. */
  allowReadRoles?: boolean;
}

/**
 * Require a signed-in session AND owner/workspace-ACL access to the `[id]` item
 * of `itemType`. Runs the exact `loadOwnedItem(id, itemType, oid, opts)` check
 * (write-scoped by default; pass `{ allowReadRoles: true }` on a read-only GET),
 * returning `apiNotFound()` (404) when the caller can't reach the item — the
 * same 404-not-403 behaviour the hand-rolled routes use so an id can't be probed
 * for existence across tenants.
 *
 * Two call styles:
 *   withWorkspaceOwner('agent-flow', handler)
 *   withWorkspaceOwner('agent-flow', { allowReadRoles: true }, handler)
 */
export function withWorkspaceOwner<P extends { id: string } = { id: string }>(
  itemType: string,
  handler: OwnerHandler<P>,
): RouteHandler<P>;
export function withWorkspaceOwner<P extends { id: string } = { id: string }>(
  itemType: string,
  opts: WorkspaceOwnerOpts,
  handler: OwnerHandler<P>,
): RouteHandler<P>;
export function withWorkspaceOwner<P extends { id: string } = { id: string }>(
  itemType: string,
  optsOrHandler: WorkspaceOwnerOpts | OwnerHandler<P>,
  maybeHandler?: OwnerHandler<P>,
): RouteHandler<P> {
  const opts: WorkspaceOwnerOpts = typeof optsOrHandler === 'function' ? {} : optsOrHandler;
  const handler: OwnerHandler<P> = typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler!;
  return withSession<P>(async (req, sctx) => {
    const id = (sctx.params as { id?: string })?.id;
    if (!id) return apiNotFound();
    const item = await loadOwnedItem(id, itemType, sctx.session.claims.oid, opts);
    if (!item) return apiNotFound();
    return handler(req, { ...sctx, item });
  });
}

/**
 * Require a signed-in session AND tenant-admin standing (P3). Composes on
 * `withSession` (401 first), then runs the exact `requireTenantAdmin(session)`
 * check from `@/lib/auth/feature-gate` — when it returns a response (the
 * canonical 403 `admin_only` envelope with its remediation text) that response
 * is returned unchanged, so adopting the wrapper leaves a route's authorization
 * + error bodies byte-compatible with the hand-rolled
 * `const gate = requireTenantAdmin(s); if (gate) return gate;` idiom.
 *
 * The handler receives the same `SessionContext` as `withSession`, so it nests
 * with `withBackendGate` exactly like the other wrappers:
 *
 *   export const PUT = withTenantAdmin(
 *     withBackendGate('svc-purview', async (req, { session, params }) => { … }),
 *   );
 */
export function withTenantAdmin<P = Record<string, string>>(handler: SessionHandler<P>): RouteHandler<P> {
  return withSession<P>((req, sctx) => {
    const gate = requireTenantAdmin(sctx.session);
    if (gate) return gate;
    return handler(req, sctx);
  });
}

/**
 * Require a signed-in session AND Data-Landing-Zone pane access (P4: tenant
 * admin or domain admin of ≥1 domain). Composes on `withSession` (401 first),
 * then awaits the exact `denyIfNoDlzAccess(session, pane)` check from
 * `@/lib/auth/dlz-gate` — when it returns the canonical 403 response, that
 * response is returned unchanged (byte-compatible with the hand-rolled
 * `const denied = await denyIfNoDlzAccess(s, pane); if (denied) return denied;`
 * idiom).
 *
 * The handler receives the same `SessionContext`, so it nests with
 * `withBackendGate` the same way:
 *
 *   export const GET = withDlzAccess('cost',
 *     withBackendGate('svc-costmgmt', async (req, { session }) => { … }),
 *   );
 */
export function withDlzAccess<P = Record<string, string>>(
  pane: DlzPane,
  handler: SessionHandler<P>,
): RouteHandler<P> {
  return withSession<P>(async (req, sctx) => {
    const denied = await denyIfNoDlzAccess(sctx.session, pane);
    if (denied) return denied;
    return handler(req, sctx);
  });
}

/**
 * Gate a handler on a backend being configured. Evaluates the registry gate
 * `gateId` (the real env-presence check); when blocked it short-circuits with
 * the normalized 503 gate envelope (./gate-envelope), otherwise it runs
 * `handler` unchanged.
 *
 * Generic over the context so it composes INSIDE `withSession` /
 * `withWorkspaceOwner` — session (401) is enforced first, then the gate (503),
 * so an unauthenticated caller never learns the deployment's config state:
 *
 *   export const POST = withSession(
 *     withBackendGate('svc-aisearch', async (req, { session }) => { … }),
 *   );
 */
export function withBackendGate<Ctx>(
  gateId: string,
  handler: (req: NextRequest, ctx: Ctx) => Promise<Response> | Response,
  opts?: GateEnvelopeOpts,
): (req: NextRequest, ctx: Ctx) => Promise<Response> | Response {
  return (req, ctx) => {
    const gated = backendGateResponse(gateId, opts);
    if (gated) return gated;
    return handler(req, ctx);
  };
}
