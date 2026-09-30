/**
 * Lakehouse item scope — the ONE place `/api/lakehouse/**` routes turn a
 * caller-supplied `lakehouseId` + container + path into the storage location
 * they are allowed to act on.
 *
 *   1. `authorizeLakehouse` — the item is authorized through
 *      `resolveItemAccessByOid`. An item the caller cannot reach answers 404,
 *      never 403, so a response never distinguishes "does not exist" from "not
 *      yours". A write asks for `canWrite` and answers 403 on a read-only role
 *      (the caller can already see the item, so nothing new is disclosed).
 *   2. `resolveLakehouseStorage` derives the item's container + root from the
 *      ITEM's server-recorded state (see `LAKEHOUSE_SERVER_OWNED_STATE_KEYS`),
 *      never from the request. A withheld location is answered by
 *      `lakehouseStorageWithheldResponse`.
 *   3. `scopePathToRoot` confines a caller path to that container and root,
 *      SEGMENT BY SEGMENT — a string-prefix test would call
 *      `lakehouses/Sales-archive` a member of `lakehouses/Sales`. The returned
 *      path is REBUILT from the resolved root segments plus the validated
 *      remainder, so the string handed to storage is the one that was checked.
 *
 * `pathSegments` refuses `.` and `..` outright rather than folding them away,
 * refuses an absolute form, and refuses an empty result, so no normalisation
 * step can turn a refused input into an accepted one.
 */
import { NextResponse } from 'next/server';
import { apiBadRequest, apiConflict, apiError, apiForbidden, apiNotFound } from '@/lib/api/respond';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import {
  lakehouseStorageWithheldFields,
  resolveLakehouseStorage,
  type LakehouseStorageWithheld,
} from '@/lib/azure/lakehouse-abfss';
import type { SessionPayload } from '@/lib/auth/session';
import type { WorkspaceItem } from '@/lib/types/workspace';

/**
 * The response for a lakehouse whose storage location the resolver withheld,
 * or null for `no-storage`, which each route words as its own gate.
 *
 * - `not-found`: 404, the same answer `authorizeLakehouse` gives, so the item
 *   read racing a delete is indistinguishable from any other missing item.
 * - `root-shared` / `root-unverified`: 409 with the resolver's ONE wording
 *   (`lakehouseStorageWithheldMessage`), plus `reason` and, for `root-shared`,
 *   `fixHref` (the readiness page that resolves it). Nothing is listed or
 *   written, and no other container is offered in the item's place.
 */
export function lakehouseStorageWithheldResponse(reason: LakehouseStorageWithheld): NextResponse | null {
  if (reason === 'not-found') return apiNotFound('lakehouse not found');
  const fields = lakehouseStorageWithheldFields(reason);
  if (!fields) return null;
  const { error, ...extra } = fields;
  return apiError(error, 409, extra);
}

/**
 * True when `raw` holds a C0 control character (U+0000-U+001F) or DEL (U+007F).
 * No ADLS path a user can create through Loom contains one, and a path is
 * carried into generated code, log lines and file names, where a line break or
 * other control character changes what the text means. Such a path is refused.
 */
export function hasPathControlChar(raw: string): boolean {
  const s = String(raw ?? '');
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

/** The 400 reason for a path `pathSegments` refused, naming the rule it broke. */
export function invalidPathMessage(raw: string): string {
  if (hasPathControlChar(raw)) {
    return 'invalid path: it contains a control character (such as a line break or tab). Storage paths '
      + 'cannot contain control characters; rename the file or folder and retry.';
  }
  return 'invalid path: expected a relative path inside the container, with no leading "/" and no "." or ".." segments';
}

/**
 * Split a container-relative path into its segments, or null when the input is
 * not one.
 *
 * Backslashes are treated as separators (a folder drag-and-drop on Windows
 * sends them). An ABSOLUTE form is REFUSED, matching the sibling
 * `/api/lakehouse/upload`: this API takes a container-relative path. A `.` or
 * `..` segment, a control character (`hasPathControlChar`, which includes NUL),
 * or an input with no segments at all is REFUSED too — returning null rather
 * than dropping the segment, so an input that names a relative back-reference
 * can never be rewritten into one that does not.
 *
 * Doubled (`//`) and trailing separators COLLAPSE rather than refuse: the
 * caller's string is never what goes to storage, so a non-canonical spelling of
 * a path that is genuinely inside the scope cannot change the target — the
 * target is rebuilt from these segments.
 */
export function pathSegments(raw: string): string[] | null {
  const s = String(raw ?? '');
  if (!s || hasPathControlChar(s)) return null;
  // Single-character class, no quantifier — linear, not the quadratic
  // trailing-run shape lib/util/trim.ts exists to replace.
  const normalized = s.replace(/\\/g, '/');
  if (normalized.charCodeAt(0) === 47 /* '/' */) return null;
  const out: string[] = [];
  for (const part of normalized.split('/')) {
    if (part === '') continue;
    if (part === '.' || part === '..') return null;
    out.push(part);
  }
  return out.length ? out : null;
}

/**
 * Is `segments` inside `root`, compared segment by segment? `strict` excludes
 * the root itself (a write route never targets a whole lakehouse root); a
 * listing passes `strict: false` so the root can be listed.
 *
 * An EMPTY root is never a container: `segments.length <= 0` would make every
 * path "inside" it, so an empty root answers false.
 */
export function segmentsWithin(segments: readonly string[], root: readonly string[], strict: boolean): boolean {
  if (root.length === 0) return false;
  if (strict ? segments.length <= root.length : segments.length < root.length) return false;
  for (let i = 0; i < root.length; i += 1) {
    if (segments[i] !== root[i]) return false;
  }
  return true;
}

export interface LakehouseAccess {
  item: WorkspaceItem;
  canWrite: boolean;
}

/**
 * Authorize `lakehouseId` for this session, or return the response that
 * refuses it: 404 when the caller cannot reach the item (or it is not a
 * lakehouse), 403 when `write` is asked for and the caller's role is read-only.
 */
export async function authorizeLakehouse(
  session: SessionPayload,
  lakehouseId: string,
  opts: { write?: boolean; readOnlyMessage?: string } = {},
): Promise<LakehouseAccess | NextResponse> {
  if (!lakehouseId) return apiNotFound('lakehouse not found');
  const access = await resolveItemAccessByOid(session, lakehouseId, 'lakehouse');
  if (!access) return apiNotFound('lakehouse not found');
  if (opts.write && !access.canWrite) {
    return apiForbidden(
      opts.readOnlyMessage
        || 'Your role on this lakehouse is read-only, so Loom did not change anything. A workspace '
        + 'Member/Admin, or an item grant that includes Edit, can make this change.',
    );
  }
  return { item: access.item as WorkspaceItem, canWrite: access.canWrite };
}

/** A lakehouse's resolved storage location, as `resolveLakehouseAbfss` reports it. */
export interface LakehouseBound {
  container: string;
  root: string;
}

export type ScopedPath =
  | { ok: true; container: string; path: string; rootSegments: string[] }
  | { ok: false; reason: 'invalid' | 'root-unusable' | 'outside'; message: string };

/**
 * Confine a caller-supplied container + container-relative path to the
 * lakehouse's own container and root.
 *
 * - `container` empty → the bound container.
 * - `rawPath` empty → the root itself (only when `strict` is false).
 * - A different container, or a path not inside the root, is `outside`.
 */
export function scopePathToRoot(
  bound: LakehouseBound,
  container: string,
  rawPath: string,
  strict: boolean,
): ScopedPath {
  const root = pathSegments(bound.root);
  if (!root) {
    return {
      ok: false,
      reason: 'root-unusable',
      message:
        'Loom found a storage binding for this lakehouse, but its recorded root '
        + `(${JSON.stringify(String(bound.root ?? ''))}) is not a usable path inside the container. `
        + 'Re-run the item provision to rewrite the binding.',
    };
  }
  const own = `${bound.container}/${root.join('/')}`;
  const wantContainer = container || bound.container;
  let segments: string[];
  if (!rawPath) {
    if (strict) {
      return { ok: false, reason: 'invalid', message: 'path is required' };
    }
    segments = root;
  } else {
    const parsed = pathSegments(rawPath);
    if (!parsed) {
      return { ok: false, reason: 'invalid', message: invalidPathMessage(rawPath) };
    }
    segments = parsed;
  }
  const asked = `${wantContainer}/${segments.join('/')}`;
  if (wantContainer !== bound.container || !segmentsWithin(segments, root, strict)) {
    return {
      ok: false,
      reason: 'outside',
      message:
        `${asked} is outside this lakehouse storage root (${own}). Open the lakehouse that owns the `
        + 'path you meant and browse it from there.',
    };
  }
  return {
    ok: true,
    container: bound.container,
    path: [...root, ...segments.slice(root.length)].join('/'),
    rootSegments: root,
  };
}

export interface ScopedItemPath {
  container: string;
  path: string;
  /** The authorized item; null only on the tenant-admin storage form. */
  item: WorkspaceItem | null;
  /**
   * The storage account the item is BOUND to, read from its resolved abfss
   * URI. A lakehouse can be bound to an account other than the deployment's
   * primary one (`state.storageAccount`), so a route that builds a storage URL
   * for the item names this account rather than the primary. Null only on the
   * tenant-admin form, which names a path on the primary account.
   */
  account: string | null;
}

/**
 * The storage account named by a resolved `abfss://<container>@<account>.dfs.<suffix>/...`
 * URI, or null when the URI does not have that shape. Account names are 3-24
 * lowercase letters and digits.
 */
export function boundAccountOf(abfss: string): string | null {
  const m = /^abfss:\/\/[^@/]+@([a-z0-9]{3,24})\.dfs\./i.exec(String(abfss ?? ''));
  return m ? m[1].toLowerCase() : null;
}

/**
 * The whole request-level decision for a route that acts on ONE lakehouse path
 * (a file or a table directory):
 *
 * - With `lakehouseId`: authorize the item (404 / 403 as `authorizeLakehouse`),
 *   resolve its binding, and confine `container` + `rawPath` to its root with
 *   `scopePathToRoot(strict: true)` — the root itself is never a file or table.
 * - Without it: the path is not tied to any item, so only a tenant admin may
 *   name it; everyone else gets 403 before any storage call.
 *
 * `rawPath` is REQUIRED in both forms (400 when empty).
 */
export async function scopeItemPath(
  session: SessionPayload,
  params: { lakehouseId: string; container: string; rawPath: string },
  opts: { write?: boolean; readOnlyMessage?: string; knownContainers: readonly string[] },
): Promise<ScopedItemPath | NextResponse> {
  const lakehouseId = params.lakehouseId.trim();
  const container = params.container.trim();
  if (!params.rawPath) return apiBadRequest('path is required');

  if (!lakehouseId) {
    if (!isTenantAdmin(session)) {
      return apiForbidden(
        'This path is not tied to a lakehouse, and naming a storage path directly is limited to tenant '
        + 'admins. Open the lakehouse and browse from its editor.',
      );
    }
    if (!container) return apiBadRequest('container is required');
    if (!opts.knownContainers.includes(container)) return apiNotFound(`unknown container: ${container}`);
    const segments = pathSegments(params.rawPath);
    if (!segments) return apiBadRequest(invalidPathMessage(params.rawPath));
    return { container, path: segments.join('/'), item: null, account: null };
  }

  const access = await authorizeLakehouse(session, lakehouseId, {
    write: opts.write,
    readOnlyMessage: opts.readOnlyMessage,
  });
  if (access instanceof NextResponse) return access;
  const resolved = await resolveLakehouseStorage(lakehouseId, access.item.workspaceId);
  if (!resolved.ok) {
    const withheld = lakehouseStorageWithheldResponse(resolved.reason);
    if (withheld) return withheld;
    return apiConflict(
      'Loom has no lakehouse storage binding for this item. Either no lakehouse storage is configured for '
      + 'this deployment (set LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL, deployed by the DLZ Bicep) or the item has '
      + 'never been provisioned. Re-run the item provision and retry.',
    );
  }
  const scoped = scopePathToRoot(resolved.bound, container, params.rawPath, true);
  if (!scoped.ok) {
    if (scoped.reason === 'invalid') return apiBadRequest(scoped.message);
    if (scoped.reason === 'root-unusable') return apiConflict(scoped.message);
    return apiForbidden(scoped.message);
  }
  const account = boundAccountOf(resolved.bound.abfss);
  if (!account) {
    return apiConflict(
      'Loom found a storage binding for this lakehouse, but could not read a storage account from it '
      + `(${JSON.stringify(String(resolved.bound.abfss ?? ''))}). Re-run the item provision to rewrite the binding.`,
    );
  }
  return { container: scoped.container, path: scoped.path, item: access.item, account };
}
