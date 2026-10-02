/**
 * Stable `code` and `remediation` fields on the refusals the shared lakehouse
 * helpers return.
 *
 * `authorizeLakehouse`, `scopeItemPath` and `authorizeAndBind` answer with
 * `{ ok: false, error }` only. A caller that wants to branch on the refusal, or
 * show the next step, needs a stable code and a remediation sentence as well.
 * `withRefusalFields` re-issues such a response with both fields added; the
 * status and the `error` text are unchanged. A response that already carries a
 * `code`, or is not a refusal, is returned as it is.
 *
 * The helpers `authorizeItem`, `scopeItem` and `authorizeAndBindItem` are the
 * same calls with the fields added, for routes that return the refusal as-is.
 */
import { NextResponse } from 'next/server';
import { lakehouseStorageWithheldMessage } from '@/lib/azure/lakehouse-abfss';
import type { SessionPayload } from '@/lib/auth/session';
import { authorizeAndBind, NO_BINDING_MESSAGE, type BoundLakehouse } from './item-binding';
import { authorizeLakehouse, scopeItemPath, type LakehouseAccess, type ScopedItemPath } from './item-scope';

export interface RefusalFields {
  code: string;
  remediation: string;
}

/** Leading words of the default read-only refusal in `authorizeLakehouse`. */
export const DEFAULT_READ_ONLY_PREFIX = 'Your role on this lakehouse is read-only';

const READ_ONLY_REMEDIATION =
  'Ask a workspace Member or Admin to make the change, or to give you an item grant that includes Edit.';

/**
 * The code and remediation for one refusal, from its status and text, or null
 * when the response is not one of the shared helpers' refusals.
 */
export function refusalFieldsFor(
  status: number,
  error: string,
  opts: { readOnlyMessage?: string } = {},
): RefusalFields | null {
  if (status === 400) {
    return { code: 'bad_request', remediation: 'Correct the value named in the message and retry.' };
  }
  if (status === 404) {
    return {
      code: 'item_not_found',
      remediation:
        'Check that the lakehouse still exists and that you have access to it in its workspace, then reopen it.',
    };
  }
  if (status === 403) {
    if (error.startsWith(DEFAULT_READ_ONLY_PREFIX) || (opts.readOnlyMessage && error === opts.readOnlyMessage)) {
      return { code: 'read_only', remediation: READ_ONLY_REMEDIATION };
    }
    if (error.includes('is outside this lakehouse storage root')) {
      return {
        code: 'outside_item_root',
        remediation: 'Open the lakehouse that owns this path and run the action from its editor.',
      };
    }
    if (error.startsWith('This path is not tied to a lakehouse')) {
      return {
        code: 'item_required',
        remediation: 'Open the lakehouse and run the action from its editor, so the request names the item.',
      };
    }
    return null;
  }
  if (status === 409) {
    if (error === lakehouseStorageWithheldMessage('root-shared')) {
      return {
        code: 'storage_root_shared',
        remediation: 'An administrator assigns this lakehouse a dedicated storage location from Admin > Readiness.',
      };
    }
    if (error === lakehouseStorageWithheldMessage('root-unverified')) {
      return { code: 'storage_root_unverified', remediation: 'Retry in a moment.' };
    }
    if (error === NO_BINDING_MESSAGE) {
      return {
        code: 'no_storage_binding',
        remediation: 'Re-run the item provision from the lakehouse editor, then retry.',
      };
    }
    if (error.startsWith('Loom found a storage binding for this lakehouse, but its recorded root')) {
      return {
        code: 'storage_root_unusable',
        remediation: 'Re-run the item provision to rewrite the binding, then retry.',
      };
    }
  }
  return null;
}

/**
 * `res` with `code` and `remediation` added to its JSON body when it is a
 * shared-helper refusal without a code; otherwise `res` itself.
 */
export async function withRefusalFields(
  res: NextResponse,
  opts: { readOnlyMessage?: string } = {},
): Promise<NextResponse> {
  if (res.status < 400) return res;
  let body: Record<string, unknown>;
  try {
    body = (await res.clone().json()) as Record<string, unknown>;
  } catch {
    return res;
  }
  if (!body || typeof body !== 'object' || body.code) return res;
  const fields = refusalFieldsFor(res.status, typeof body.error === 'string' ? body.error : '', opts);
  if (!fields) return res;
  return NextResponse.json({ ...body, ...fields }, { status: res.status });
}

/** `authorizeLakehouse` with `code` and `remediation` on its refusals. */
export async function authorizeItem(
  session: SessionPayload,
  lakehouseId: string,
  opts: { write?: boolean; readOnlyMessage?: string } = {},
): Promise<LakehouseAccess | NextResponse> {
  const out = await authorizeLakehouse(session, lakehouseId, opts);
  return out instanceof NextResponse ? withRefusalFields(out, opts) : out;
}

/** `scopeItemPath` with `code` and `remediation` on its refusals. */
export async function scopeItem(
  session: SessionPayload,
  params: { lakehouseId: string; container: string; rawPath: string },
  opts: { write?: boolean; readOnlyMessage?: string; knownContainers: readonly string[] },
): Promise<ScopedItemPath | NextResponse> {
  const out = await scopeItemPath(session, params, opts);
  return out instanceof NextResponse ? withRefusalFields(out, opts) : out;
}

/** `authorizeAndBind` with `code` and `remediation` on its refusals. */
export async function authorizeAndBindItem(
  session: SessionPayload,
  lakehouseId: string,
  opts: { write?: boolean; readOnlyMessage?: string } = {},
): Promise<BoundLakehouse | NextResponse> {
  const out = await authorizeAndBind(session, lakehouseId, opts);
  return out instanceof NextResponse ? withRefusalFields(out, opts) : out;
}

/**
 * The response for a `scopePathToRoot` refusal: 400 for an invalid path, 409
 * for an unusable recorded root, 403 for a path outside the item root — each
 * with its `code` and `remediation`.
 */
export function pathScopeRefusal(scoped: { reason: 'invalid' | 'root-unusable' | 'outside'; message: string }): NextResponse {
  const status = scoped.reason === 'invalid' ? 400 : scoped.reason === 'root-unusable' ? 409 : 403;
  const fields = refusalFieldsFor(status, scoped.message);
  return NextResponse.json({ ok: false, error: scoped.message, ...(fields ?? {}) }, { status });
}
