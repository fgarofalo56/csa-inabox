/**
 * LOOM BRAIN ACTIONS — the ARM TAG WRITE primitive for the ownership backfill
 * (#4255 W2).
 *
 * Sibling of `./arm.ts` and built to the same rules: no hand-rolled credential
 * chain (`uamiArmCredential()` is the sanctioned factory — the
 * ws-credential-adoption ratchet), host and scope from `cloud-endpoints.ts` so
 * the same code runs in Commercial, GCC, GCC-High, IL5 and DoD
 * (`cloud-parity.md`), and R7 honesty on failure: the status and the response
 * body travel verbatim, and this module NEVER converts "I could not reach ARM"
 * into "the tag was written".
 *
 * ── THERE IS NO READER HERE, DELIBERATELY ──────────────────────────────────
 * The tag READ is `createManifestTagReader()` from
 * `lib/estate/pause-orchestrator.ts` — the established, 429-aware reader the
 * pause path already trusts for exactly these manifest entries. A second
 * reader in this file would be a second answer to "what tags does this
 * resource carry", and the two would eventually disagree. One reader, one
 * writer.
 *
 * ── WHY THE GENERIC TAGS API AND NOT A PER-TYPE UPDATE ─────────────────────
 * The backfill tags whatever the deploy manifest names: a Synapse SQL pool, a
 * Kusto cluster, an Analysis Services server, a VM scale set — and whatever
 * the manifest grows next. A per-type update would need a per-type
 * api-version, a per-type request body, and a per-type role. The tags
 * extension resource
 *
 *     {resourceId}/providers/Microsoft.Resources/tags/default
 *
 * is type-agnostic, has ONE api-version, and needs only
 * `Microsoft.Resources/tags/write` — the built-in **Tag Contributor** role —
 * a far narrower grant than Contributor on every backing service. The repo
 * already reasons about this exact extension resource in
 * `platform/fiab/bicep/modules/admin-plane/registry.bicep`.
 *
 * ── WHY `Merge` AND NOT `Replace` ──────────────────────────────────────────
 * `Merge` adds/updates ONLY the keys in the request and leaves every other tag
 * untouched, server-side and atomically. A read-modify-write that PUT the whole
 * bag back would clobber any tag written between our GET and our PUT, which on
 * a live estate is a real race (policy engines and cost-allocation automation
 * both write tags). So the request body carries exactly ONE key, and the
 * receipt separately records the PRIOR bag — read immediately before — so an
 * untag or a rollback has the value it needs.
 *
 * Idempotence is therefore structural: merging `loom-estate-id: X` onto a
 * resource that already carries `loom-estate-id: X` is a no-op, and the caller
 * does not even reach here in that case (`already-tagged` is not a candidate).
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';
import { BrainActionArmError } from './arm';

/** The tags extension-resource api-version. One version, every resource type. */
export const BRAIN_ACTIONS_TAGS_API = '2021-04-01';

let _credential: ReturnType<typeof uamiArmCredential> | null = null;
function credential() {
  if (!_credential) _credential = uamiArmCredential();
  return _credential;
}

/** Test seam — drop the cached credential. */
export function resetBrainActionTagCredential(): void {
  _credential = null;
}

function tagsUrl(resourceId: string): string {
  const id = String(resourceId || '').trim();
  if (!id.startsWith('/subscriptions/')) {
    throw new BrainActionArmError(
      400,
      undefined,
      `ownership backfill: '${id}' is not an ARM resource id. Refusing.`,
    );
  }
  return (
    `${armBase()}${id}/providers/Microsoft.Resources/tags/default` +
    `?api-version=${BRAIN_ACTIONS_TAGS_API}`
  );
}

interface TagsEnvelope {
  readonly properties?: { readonly tags?: Record<string, string> };
}

/**
 * MERGE one tag onto a resource, leaving every other tag untouched.
 *
 * Returns the FULL merged bag exactly as ARM reports it after the write — a
 * real `after` for the receipt, read from the authoritative plane rather than
 * assembled locally from what we hoped happened.
 */
export async function armMergeTag(
  resourceId: string,
  key: string,
  value: string,
): Promise<Readonly<Record<string, string>>> {
  const url = tagsUrl(resourceId);
  if (!key.trim() || !value.trim()) {
    throw new BrainActionArmError(
      400,
      undefined,
      `ownership backfill: refusing to write an empty tag key or value onto ${resourceId}.`,
    );
  }
  const token = await credential().getToken(armScope());
  if (!token?.token) {
    throw new BrainActionArmError(
      401,
      undefined,
      'Failed to acquire an ARM token for the ownership backfill. NOTHING was tagged.',
    );
  }
  const r = await fetchWithTimeout(url, {
    // `Merge` is the whole safety argument — see the module doc-block. Never
    // `Replace`: it would drop every tag not named in this body.
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ operation: 'Merge', properties: { tags: { [key]: value } } }),
  });
  const text = await r.text().catch(() => '');
  if (r.status !== 200) {
    throw new BrainActionArmError(
      r.status,
      text,
      `ARM refused to merge '${key}' onto ${resourceId} (status ${r.status}). The tag was ` +
        'NOT confirmed written. The console identity needs the Tag Contributor role ' +
        '(Microsoft.Resources/tags/write) at this resource’s scope. Raw: ' +
        `${text.slice(0, 300)}`,
    );
  }
  let body: TagsEnvelope;
  try {
    body = text ? (JSON.parse(text) as TagsEnvelope) : {};
  } catch (e) {
    throw new BrainActionArmError(
      r.status,
      text.slice(0, 300),
      `ARM returned a 200 for the tag merge on ${resourceId} whose body could not be ` +
        `parsed (${e instanceof Error ? e.message : String(e)}). The write may or may not ` +
        'have landed; that is stated as UNCONFIRMED rather than claimed either way.',
    );
  }
  return body.properties?.tags ?? {};
}

export { BrainActionArmError };
