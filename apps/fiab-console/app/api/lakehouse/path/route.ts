/**
 * DELETE /api/lakehouse/path?lakehouseId=&container=&path=&recursive=true
 *   Deletes a file or directory.
 *
 * POST   /api/lakehouse/path?lakehouseId=&container=&path=
 *   Creates a directory (idempotent).
 *
 * ── WHAT THE VALIDATION ESTABLISHES ─────────────────────────────────────────
 * Both verbs act on ADLS through the Console identity, at a container + path
 * taken off the query string. `validate()` used to check PRESENCE only: that
 * both params were non-empty and that `container` was one of
 * `KNOWN_CONTAINERS`. `path` was accepted verbatim and tied to no item, so the
 * pair the route handed `deletePath`/`createDirectory` was the one the query
 * string named, validated against nothing the caller owns — and `deletePath` is
 * a HARD delete (`recursive` at the caller's option), not the soft-delete the
 * recycle bin restores from.
 *
 * The pair is now resolved against the caller's OWN lakehouse, the same shape
 * `DELETE /api/onelake/[itemId]` uses for its ADLS hints (#4596):
 *
 *   1. `lakehouseId` is REQUIRED and authorized through `resolveItemAccessByOid`
 *      — 404, never 403, so an id the caller may not see is never confirmed,
 *      exactly as `/api/lakehouse/paths` does for its item-bound listing. A
 *      read-only role is refused: both verbs mutate.
 *   2. That item's container + root come from `resolveLakehouseAbfss`, the ONE
 *      resolver `/api/lakehouse/{paths,tables}` already use. Nothing about the
 *      scope is caller-supplied.
 *   3. The supplied container must BE the resolved one, and the supplied path
 *      must lie strictly BELOW the resolved root — compared segment by segment,
 *      never as a string prefix (`isValidRolePath` in onelake-security-rules.ts
 *      is a prefix test, and a prefix test says `lakehouses/Sales-archive` is
 *      inside `lakehouses/Sales`). The root itself is not a target: removing an
 *      item's whole root belongs to deleting the item, not to its file browser.
 *   4. The path forwarded to ADLS is REBUILT from the resolved root segments
 *      plus the validated remainder, so a differently-spelled-but-equal input
 *      cannot change the string the storage call receives.
 *
 * `pathSegments` refuses `.` and `..` outright rather than folding them away,
 * refuses an absolute form, and refuses an empty result, so no normalisation
 * step can turn a rejected input into an accepted one. Percent-encoding is
 * decoded once by `URLSearchParams` before it is ever seen here, so `%2e%2e`
 * arrives as `..` and is refused in its literal form.
 *
 * Route-toolkit: withSession (R3) — the hand-rolled `getSession()` prologue it
 * carried is the shape that gate exists to retire.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiBadRequest, apiConflict, apiForbidden, apiNotFound, apiOk } from '@/lib/api/respond';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import type { SessionPayload } from '@/lib/auth/session';
import {
  KNOWN_CONTAINERS,
  createDirectory,
  deletePath,
  type KnownContainer,
} from '@/lib/azure/adls-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STORAGE_UNRESOLVED =
  "Loom could not resolve this lakehouse's own storage root, so it did not create or delete anything. "
  + 'Either no lakehouse storage is configured for this deployment (set LOOM_{BRONZE,SILVER,GOLD,LANDING,CSV_IMPORTS}_URL, '
  + 'deployed by the DLZ Bicep) or the item has never been provisioned. Re-run the item provision and retry.';

/**
 * Split a container-relative path into its segments, or null when the input is
 * not one.
 *
 * Backslashes are treated as separators (a folder drag-and-drop on Windows
 * sends them). An ABSOLUTE form is REFUSED, matching the sibling
 * `/api/lakehouse/upload`: this API takes a container-relative path. A `.` or
 * `..` segment, a NUL, or an input with no segments at all is REFUSED too —
 * returning null rather than dropping the segment, so an input that names a
 * relative back-reference can never be rewritten into one that does not.
 *
 * Doubled (`//`) and trailing separators COLLAPSE rather than refuse: the
 * caller's string is never what goes to storage, so a non-canonical spelling of
 * a path that is genuinely inside the scope cannot change the target — the
 * target is rebuilt from these segments.
 */
export function pathSegments(raw: string): string[] | null {
  const s = String(raw ?? '');
  if (!s || s.includes('\0')) return null;
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

/** The container + path an already-authorized request is allowed to act on. */
interface ResolvedTarget {
  container: KnownContainer;
  /** Rebuilt from the RESOLVED root segments — never the caller's string. */
  path: string;
}

/**
 * Resolve the caller's request to a target inside their own lakehouse's root,
 * or return the response that refuses it.
 *
 * Order matters: the cheap shape checks run before the two Cosmos reads, and
 * the item authorization runs before anything reports a fact about the item.
 */
async function resolveTarget(
  req: NextRequest,
  session: SessionPayload,
): Promise<ResolvedTarget | NextResponse> {
  const sp = req.nextUrl.searchParams;
  const lakehouseId = (sp.get('lakehouseId') || '').trim();
  const container = (sp.get('container') || '').trim();
  const rawPath = sp.get('path') || '';

  if (!container || !rawPath) return apiBadRequest('container and path are required');
  if (!lakehouseId) {
    return apiBadRequest(
      'lakehouseId is required — this route only creates and deletes paths inside a lakehouse own storage root',
    );
  }
  if (!(KNOWN_CONTAINERS as readonly string[]).includes(container)) {
    return apiNotFound(`unknown container: ${container}`);
  }

  const segments = pathSegments(rawPath);
  if (!segments) {
    return apiBadRequest(
      'invalid path: expected a relative path inside the container, with no leading "/" and no "." or ".." segments',
    );
  }

  // 404, not 403: never confirm an id the caller may not see.
  const access = await resolveItemAccessByOid(session, lakehouseId, 'lakehouse');
  if (!access) return apiNotFound('lakehouse not found');
  if (!access.canWrite) {
    return apiForbidden(
      'Your role on this lakehouse is read-only, so Loom did not create or delete anything. A workspace '
      + 'Member/Admin, or an item grant that includes Edit, can make this change.',
    );
  }

  const bound = await resolveLakehouseAbfss(lakehouseId, access.item.workspaceId);
  const root = bound ? pathSegments(bound.root) : null;
  if (!bound || !root) return apiConflict(STORAGE_UNRESOLVED);

  const own = `${bound.container}/${root.join('/')}`;
  const asked = `${container}/${segments.join('/')}`;
  const outside =
    `${asked} is outside this lakehouse storage root (${own}), so Loom did not act on it. Loom only creates `
    + 'and deletes paths BELOW that root; open the lakehouse that owns the path you meant and act from there.';

  if (bound.container !== container) return apiForbidden(outside);
  // Strictly below the root: `segments.length === root.length` is the root
  // itself, which this route never targets.
  if (segments.length <= root.length) return apiForbidden(outside);
  for (let i = 0; i < root.length; i += 1) {
    // Segment-wise, so `lakehouses/Sales-archive` is NOT inside `lakehouses/Sales`.
    if (segments[i] !== root[i]) return apiForbidden(outside);
  }

  return {
    container: bound.container as KnownContainer,
    path: [...root, ...segments.slice(root.length)].join('/'),
  };
}

function storageFailed(e: any): NextResponse {
  return NextResponse.json(
    { ok: false, error: e?.message || String(e), code: e?.code },
    { status: 502 },
  );
}

export const DELETE = withSession(async (req: NextRequest, { session }) => {
  const target = await resolveTarget(req, session);
  if (target instanceof NextResponse) return target;
  const recursive = req.nextUrl.searchParams.get('recursive') === 'true';
  try {
    await deletePath(target.container, target.path, recursive);
    return apiOk({ container: target.container, path: target.path });
  } catch (e: any) {
    return storageFailed(e);
  }
});

export const POST = withSession(async (req: NextRequest, { session }) => {
  const target = await resolveTarget(req, session);
  if (target instanceof NextResponse) return target;
  try {
    await createDirectory(target.container, target.path);
    return apiOk({ container: target.container, path: target.path }, { status: 201 });
  } catch (e: any) {
    return storageFailed(e);
  }
});
