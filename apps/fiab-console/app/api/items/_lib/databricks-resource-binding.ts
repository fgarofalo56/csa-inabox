/**
 * #2996 / #2997 — SERVER-ATTESTED ownership binding for the Databricks
 * resources Loom items drive (Jobs 2.1 jobs, Lakeflow DLT pipelines).
 *
 * WHY THIS EXISTS RATHER THAN "READ THE ID OFF THE ITEM".
 *
 * The obvious layer-2 fix for `POST [id]/run?jobId=` is "the jobId must match
 * the one recorded on the item". That fix is INERT, and the reason is worth
 * stating precisely because it is the same class as the `contextId` pivot #2995
 * found — a second coordinate the issue never named.
 *
 * `PATCH /api/cosmos-items/[type]/[id]` replaces an item's `state` WHOLESALE
 * from the request body:
 *
 *     state: 'state' in body && body.state && typeof body.state === 'object'
 *       ? body.state : item.state
 *
 * There is no preservation of `state.provisioning`. So an item's
 * `state.provisioning.secondaryIds.jobId` — and `state.content.pipelineId` —
 * are CLIENT-WRITABLE by anyone authorized for that item, which for their OWN
 * item is everyone. The attack a state-only binding leaves wide open:
 *
 *   1. Attacker creates their own `databricks-job` item A (fully legitimate).
 *   2. Attacker PATCHes `A.state.provisioning.secondaryIds.jobId = <victim job>`.
 *   3. Attacker POSTs `/api/items/databricks-job/A/run` with NO `jobId` param.
 *   4. Layer 1 passes (A is genuinely theirs). A state-only layer 2 passes too
 *      (the id "matches the item"). The victim's job runs.
 *
 * Item state is a CLAIM, not an ATTESTATION. So the binding is anchored where
 * the caller cannot write: on the Databricks resource itself. Loom stamps the
 * owning item id into the resource at creation —
 *
 *   * a job    → `settings.tags['loom_item_id']`      (Jobs 2.1 job tags)
 *   * a DLT pl → `spec.configuration['loom_item_id']` (pipeline configuration)
 *
 * — and every route re-reads it from Databricks and compares. The only Loom
 * code paths that can set that marker are themselves bound, so the marker is
 * server-attested: a caller can claim any id they like in Cosmos and still be
 * refused, because the resource says who owns it.
 *
 * LEGACY RESOURCES (created before this change) carry no marker. Refusing them
 * outright would break every already-installed `databricks-job` item, which is
 * a `no-vaporware.md` regression, so an unmarked resource may be ADOPTED — but
 * only when the claim is EXCLUSIVE: no other item in the estate claims the same
 * resource id. That is what {@link resolveLegacyClaim} enforces, and it degrades
 * the attack above from "run the victim's job" to "make both items refuse until
 * an operator removes the bogus claim". A denial-of-service on an unmarked
 * legacy resource is the residual, and it closes permanently the moment the
 * legitimate owner performs any write (which stamps the marker).
 *
 * Once a resource IS marked, a mismatched claim is refused unconditionally —
 * adoption is never reachable for a marked resource.
 */
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { cosmosIdFromLoomId } from '@/app/api/items/_lib/loom-content-id';

/**
 * The key Loom stamps into a Databricks resource to record which Loom item owns
 * it. Deliberately snake_case and prefixed: Databricks job tag keys and DLT
 * pipeline configuration keys are free-form, so a distinctive key cannot
 * collide with a customer's own tagging scheme.
 */
export const LOOM_OWNER_KEY = 'loom_item_id';

/**
 * The resolution of a caller-supplied (or item-recorded) resource id against the
 * item that claims it. `stamp` is true when the caller is authorized AND the
 * resource carries no marker yet, so a WRITE path should record ownership while
 * it is already writing. Read-only paths ignore it (they must not mutate — see
 * #2973, which found three GETs in this family mutating while polling).
 */
export type BindingVerdict =
  | { ok: true; resourceId: string; stamp: boolean }
  | { ok: false; status: number; error: string };

/**
 * Compare the marker Loom stamped on a Databricks resource against the item
 * claiming it.
 *
 * Returns `null` when the resource is UNMARKED — the caller must then fall
 * through to {@link resolveLegacyClaim}, which is the only path that may admit
 * an unmarked resource. Returning null rather than a permissive verdict keeps
 * "unmarked" from being silently equivalent to "mine".
 */
export function judgeOwnerMarker(
  marker: string | undefined,
  itemId: string,
): { ok: true } | { ok: false; status: number; error: string } | null {
  const owner = typeof marker === 'string' ? marker.trim() : '';
  if (!owner) return null;
  // Route ids arrive in both the raw Cosmos form and the synthetic
  // `loom:<cosmosItemId>` form the bundle-install list route hands editors
  // (#2830), so normalise both sides before comparing.
  if (cosmosIdFromLoomId(owner) === cosmosIdFromLoomId(itemId)) return { ok: true };
  return {
    ok: false,
    status: 403,
    error: 'that Databricks resource belongs to a different Loom item.',
  };
}

/**
 * Admit an UNMARKED (pre-#2996) Databricks resource only when this item's claim
 * on it is EXCLUSIVE across the estate.
 *
 * `paths` are the Cosmos JSON paths where this item family records the resource
 * id — they MUST be the same paths the platform itself resolves from (teardown
 * for jobs, the editor's persisted binding for pipelines), so we authorize the
 * coordinate the platform actually uses rather than inventing a second
 * resolution. That mirrors `notebook-path-scope.ts`, which deliberately matches
 * `resource-teardown.ts`.
 *
 * The query is cross-partition BY DESIGN: a competing claim from ANOTHER
 * tenant's item is exactly what must be detected, and an owner-scoped query
 * would never see it.
 */
export async function resolveLegacyClaim(
  opts: { itemType: string; itemId: string; resourceId: string; paths: string[] },
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { itemType, itemId, resourceId, paths } = opts;
  if (!paths.length) {
    return { ok: false, status: 403, error: 'that Databricks resource is not bound to this item.' };
  }
  const selfId = cosmosIdFromLoomId(itemId);
  const disjunction = paths.map((p) => `${p} = @r`).join(' OR ');
  let competing = 0;
  try {
    const items = await itemsContainer();
    const { resources } = await items.items
      .query<number>({
        query:
          `SELECT VALUE COUNT(1) FROM c WHERE c.itemType = @t AND c.id != @self AND (${disjunction})`,
        parameters: [
          { name: '@t', value: itemType },
          { name: '@self', value: selfId },
          { name: '@r', value: resourceId },
        ],
      })
      .fetchAll();
    competing = Number(resources[0] ?? 0);
  } catch {
    // FAIL CLOSED. An unverifiable exclusivity check is not an authorization —
    // the same rule `notebook-exec-scope.ts` applies when the entitled cluster
    // set cannot be enumerated.
    return {
      ok: false,
      status: 502,
      error: 'could not verify ownership of that Databricks resource.',
    };
  }
  if (competing > 0) {
    return {
      ok: false,
      status: 409,
      error:
        'that Databricks resource is claimed by more than one Loom item — ' +
        'remove the duplicate binding before running it.',
    };
  }
  return { ok: true };
}

/**
 * The full ladder: marker first (authoritative), exclusivity second (legacy
 * only). Kept in one place so both item families apply the SAME order — a
 * family that checked exclusivity first would let a competing claim mask a
 * definitive marker mismatch.
 */
export async function bindResourceToItem(opts: {
  itemType: string;
  itemId: string;
  resourceId: string;
  marker: string | undefined;
  paths: string[];
}): Promise<BindingVerdict> {
  const marked = judgeOwnerMarker(opts.marker, opts.itemId);
  if (marked) {
    return marked.ok
      ? { ok: true, resourceId: opts.resourceId, stamp: false }
      : marked;
  }
  const legacy = await resolveLegacyClaim(opts);
  if (!legacy.ok) return legacy;
  return { ok: true, resourceId: opts.resourceId, stamp: true };
}
