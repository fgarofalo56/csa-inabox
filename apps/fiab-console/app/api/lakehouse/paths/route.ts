/**
 * GET /api/lakehouse/paths
 *   ?container=&prefix=                          — list an explicit container path
 *   ?lakehouseId=&workspaceId=&prefix=           — list a LAKEHOUSE's own root (#3904)
 *
 * Flat directory listing of an ADLS Gen2 path.
 *
 * ITEM-BOUND LISTING (#3904). Without `container` the route resolves the
 * caller's lakehouse to the container + root the provisioner actually wrote to,
 * via `resolveLakehouseAbfss` — the SAME resolver `/api/lakehouse/tables` uses.
 * The editor used to open on `containers[0]` (`bronze`) and list the container
 * ROOT, i.e. a different container and a path the lakehouse never occupied, so
 * first open 404'd. The response echoes the resolved `container` + `root` so the
 * client adopts the binding rather than deriving a second opinion. The
 * lakehouse is authorized through `resolveItemAccessByOid` (404, not 403, so an
 * id cannot be probed for existence across tenants) exactly as the tables route
 * does — the id is caller-supplied and must never become an existence oracle.
 *
 * ERROR TRANSLATION (#3904). A listing failure is CLASSIFIED here and answered
 * with an honest remediation. It used to forward `e?.message` verbatim, which
 * put the storage SDK's `RequestId:… Time:…` in front of the user under "List
 * failed" — a `no-vaporware.md` honest-gate violation, and useless to them.
 * `getMetadata` (adls-client.ts) already models the 404-tolerant read. Per
 * `deploy-integrity.md` R7 the message states only what the code ESTABLISHED:
 * a 404 says the directory is absent and says plainly that Loom does not know
 * why; an unclassified failure says it could not be classified. The raw error
 * is logged server-side, never returned.
 *
 * EH-P1-OBO (#1800): when the global OBO data-plane mode is `on`
 * (LOOM_OBO_DATA_PLANE — default `off`, see lib/azure/data-access-mode.ts),
 * the listing is attempted AS THE SIGNED-IN USER via their delegated Azure
 * Storage token (adls-user-client); per that mode's documented contract a
 * missing delegated token FALLS BACK to the shared service identity (never
 * fails the call vs. today), and the response reports which `identity` served
 * it. With the mode off (default) the behavior is byte-identical to before.
 */

import { NextRequest, NextResponse } from 'next/server';
import { KNOWN_CONTAINERS, listPaths, type KnownContainer, type PathEntry } from '@/lib/azure/adls-client';
import { listPathsAsUser, AdlsUserTokenError } from '@/lib/azure/adls-user-client';
import { oboMode } from '@/lib/azure/data-access-mode';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { withSession } from '@/lib/api/route-toolkit';
import { apiError } from '@/lib/api/respond';
import { logSafe } from '@/lib/util/log-safe';
import { trimSlashes } from '@/lib/util/trim';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STORAGE_NOT_CONFIGURED =
  'No lakehouse storage is configured for this deployment — set LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL '
  + '(deployed by the DLZ Bicep) and grant the Console UAMI Storage Blob Data Contributor on the container.';

/** Codes Azure Storage uses for "that path/filesystem is not there". */
const NOT_FOUND_CODES = new Set([
  'PathNotFound', 'BlobNotFound', 'ContainerNotFound', 'FilesystemNotFound', 'ResourceNotFound',
]);
/** Codes Azure Storage uses for "the identity may not do that here". */
const DENIED_CODES = new Set([
  'AuthorizationPermissionMismatch', 'AuthorizationFailure', 'AuthenticationFailed',
  'InsufficientAccountPermissions', 'AuthorizationResourceTypeMismatch',
]);

function errStatus(e: unknown): number {
  const n = (e as { statusCode?: unknown })?.statusCode;
  return typeof n === 'number' ? n : 0;
}

function errCode(e: unknown): string {
  const direct = (e as { code?: unknown })?.code;
  if (typeof direct === 'string') return direct;
  const detail = (e as { details?: { errorCode?: unknown } })?.details?.errorCode;
  return typeof detail === 'string' ? detail : '';
}

/** An Azure Storage error code as the service documents it: a short PascalCase token. */
const CODE_SHAPE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/**
 * Bound what leaves through `code`.
 *
 * `code` is the ONE field on the failure payload sourced from the SDK, so it is
 * the one remaining way SDK text could reach a browser. `e.code` and
 * `e.details.errorCode` are typed `string` and nothing guarantees they are the
 * short token the service documents — a provider that stuffed
 * `"PathNotFound RequestId:<guid> Time:<ts>"` in there would have walked
 * straight past every `not.toContain('RequestId')` assertion in the suite,
 * because those all use clean codes. Known code, else documented shape, else a
 * generic token. Defensive, not observed — and it makes the PR's claim ("nothing
 * from the SDK reaches the client") true of the code rather than merely likely.
 */
function safeCode(raw: string, fallback: string): string {
  if (!raw) return fallback;
  if (NOT_FOUND_CODES.has(raw) || DENIED_CODES.has(raw)) return raw;
  return CODE_SHAPE.test(raw) ? raw : fallback;
}

/**
 * Translate a storage listing failure into an honest, user-actionable payload.
 *
 * NOTHING from the SDK message reaches the client — that string carries the
 * RequestId/Time pair that used to surface in the UI, and it asserts causes we
 * did not establish. Only the classification, the path we asked for, and (for a
 * classified case) the fix are returned. `code` is the SDK's short token,
 * bounded by `safeCode`.
 *
 * `kind` is the CLASSIFICATION ITSELF, decided here and here only. The UI needs
 * to know whether a failure is "this directory isn't there yet" (a guided state)
 * or a real error, and the first cut of this fix made it re-derive that by
 * regex-matching the English message — a second method for one decision, which
 * is the exact defect #3904 is about, plus a bug: a container or prefix
 * containing the words "not exist" flipped a 403 into a friendly warning. The
 * server states the class; the client reads it.
 */
export type ListFailureKind = 'not-found' | 'denied' | 'unknown';

export function classifyListFailure(
  e: unknown,
  container: string,
  prefix: string,
): { status: number; body: Record<string, unknown> } {
  const status = errStatus(e);
  const code = errCode(e);
  const where = prefix ? `${container}/${prefix}` : container;

  if (status === 404 || NOT_FOUND_CODES.has(code)) {
    return {
      status: 404,
      body: {
        ok: false,
        kind: 'not-found' satisfies ListFailureKind,
        code: safeCode(code, 'PathNotFound'),
        container,
        prefix,
        error: `Nothing is stored at ${where} yet.`,
        remediation:
          `Azure Storage reports that ${where} does not exist. Loom established only that the listing `
          + 'returned 404 — not why the directory is absent. It is either not created yet, or it was '
          + 'removed outside Loom. Create it by uploading a file or adding a folder here, or re-run the '
          + "app install / item provision so the item's root directory is recreated.",
      },
    };
  }

  if (status === 401 || status === 403 || DENIED_CODES.has(code)) {
    return {
      status: 403,
      body: {
        ok: false,
        kind: 'denied' satisfies ListFailureKind,
        code: safeCode(code, 'AuthorizationFailure'),
        container,
        prefix,
        error: `Loom is not authorized to list ${where}.`,
        remediation:
          'Grant the Console managed identity (UAMI) the Storage Blob Data Contributor role on the '
          + `lakehouse storage account, scoped to the ${container} container or above, then retry. If the `
          + 'account is firewalled, confirm the Console subnet / private endpoint is on its network ACL.',
      },
    };
  }

  return {
    status: 502,
    body: {
      ok: false,
      kind: 'unknown' satisfies ListFailureKind,
      code: safeCode(code, 'storage_list_failed'),
      container,
      prefix,
      error: `Azure Storage could not list ${where}${status ? ` (HTTP ${status})` : ''}.`,
      remediation:
        'This was neither a 404 nor an authorization failure, so Loom cannot say what caused it. The '
        + 'full storage error is in the Console container logs (search for "lakehouse/paths list failed"). '
        + 'Retry — transient storage and network faults present this way.',
    },
  };
}

export const GET = withSession(async (req: NextRequest, { session }) => {
  const sp = req.nextUrl.searchParams;
  const lakehouseId = sp.get('lakehouseId')?.trim() || '';
  const requested = Number(sp.get('maxResults') || '200');
  const max = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 200, 1000);

  let container = sp.get('container')?.trim() || '';
  let prefix = trimSlashes(sp.get('prefix') || '');
  // The lakehouse's own root inside the container — echoed so the client binds
  // to it instead of re-deriving one. Null when the caller named a container
  // directly (a deliberate browse of something other than this item's root).
  let root: string | null = null;

  // ── Item-bound resolution (#3904) ───────────────────────────────────────
  if (!container && lakehouseId) {
    const access = await resolveItemAccessByOid(session, lakehouseId, 'lakehouse');
    // 404, not 403: never confirm an id the caller may not see.
    if (!access) return apiError('lakehouse not found', 404);

    const bound = await resolveLakehouseAbfss(lakehouseId, access.item.workspaceId);
    if (!bound) {
      // Honest gate, not an error: there is no configured storage to browse.
      // Mirrors /api/lakehouse/tables' `{ ok: true, tables: [], gate }`.
      return NextResponse.json({
        ok: true, container: null, root: null, prefix: '', paths: [],
        identity: 'service', gate: STORAGE_NOT_CONFIGURED,
      });
    }
    container = bound.container;
    root = bound.root;
    // No explicit prefix → list the lakehouse's own root. An explicit prefix is
    // honoured as given (it is already container-absolute in every caller).
    if (!prefix) prefix = bound.root;
  }

  if (!container) {
    return apiError('container is required', 400);
  }
  if (!(KNOWN_CONTAINERS as readonly string[]).includes(container)) {
    return apiError(`unknown container: ${container}`, 404);
  }

  let paths: PathEntry[];
  let identity: 'user' | 'service' = 'service';
  try {
    if (oboMode() === 'on') {
      try {
        paths = await listPathsAsUser(session.claims.oid, container, prefix, max);
        identity = 'user';
      } catch (e) {
        // Mode-policy fallback (data-access-mode `on`): no delegated token →
        // degrade to the shared service identity, never fail the call vs. today.
        if (!(e instanceof AdlsUserTokenError)) throw e;
        paths = await listPaths(container as KnownContainer, prefix, max);
      }
    } else {
      paths = await listPaths(container as KnownContainer, prefix, max);
    }
  } catch (e) {
    // Log the RAW failure server-side (this is where the RequestId belongs) and
    // answer the client with the classification only.
    const detail = e instanceof Error ? (e.stack || e.message) : String(e);
    // eslint-disable-next-line no-console
    console.error('[api] lakehouse/paths list failed:', logSafe(detail, 4000));
    const { status, body } = classifyListFailure(e, container, prefix);
    return NextResponse.json(body, { status });
  }

  return NextResponse.json({ ok: true, container, root, prefix, paths, identity });
});
