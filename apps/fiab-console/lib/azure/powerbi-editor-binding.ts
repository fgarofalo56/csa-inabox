/**
 * Power BI workspace binding for an ITEM EDITOR (semantic model, report, …).
 *
 * WHY THIS MODULE EXISTS. The editors bound their Power BI workspace inline with
 *
 *     if (!pbiWorkspaceId && ws.workspaces?.length) setPbiWorkspaceId(ws.workspaces[0].id);
 *
 * i.e. whichever group the tenant listing happened to return FIRST. That is an
 * ARBITRARY third workspace — neither the item's own Loom workspace nor the one
 * an operator mapped in Workspace settings (`pbiWorkspaceMapping`). Every
 * downstream /api/powerbi/{datasets,reports,dashboards,dataflows} call then
 * addressed a group the caller may hold no role on, and Power BI answers those
 * 401 (learn.microsoft.com/power-bi/developer/embedded/troubleshoot-rest-api —
 * "Troubleshoot 401 errors in Power BI REST API calls"). To the operator that
 * reads as "Power BI doesn't map or work".
 *
 * `powerbi-workspace-mapping.ts` already documented the correct precedence
 * (explicit → mapped → env default) for the SERVER side; the editors simply
 * never used it. This module is the CLIENT-side counterpart, extracted as a
 * pure function so it is executable in a unit test WITHOUT the test having to
 * re-implement the rule (a test that re-implements its subject cannot fail).
 *
 * #2968 — THE HALF THE FIRST FIX LEFT BEHIND. The original fix re-ordered the
 * precedence (mapped before first-listed) but KEPT `listed[0].id` as the
 * fallback for a CONFIRMED-unmapped item. On any estate where the Power BI
 * opt-in is on and the item's Loom workspace was never mapped — the common
 * case — that fallback still pinned the arbitrary first-listed group, and the
 * navigator still fanned out /api/powerbi/{datasets,reports,dashboards,
 * dataflows} at it. Under the DEFAULT user-passthrough token (powerbi-client
 * `getToken`) the caller's own Power BI RBAC decides each one, so the endpoints
 * their rights don't cover answer 401 — observed live as a permanent
 *   401 GET /api/powerbi/dashboards?workspaceId=<arbitrary group>
 *   401 GET /api/powerbi/dataflows?workspaceId=<arbitrary group>
 * on EVERY semantic-model open. `.claude/rules/no-fabric-dependency.md` admits
 * a Fabric-family backend only behind an explicit opt-in **plus a bound
 * workspace**; a group picked out of a tenant listing is not a bound workspace.
 * So the fallback is gone for a persisted item: unmapped ⇒ bind NOTHING, make
 * ZERO Power BI calls, and let the operator pick explicitly (WorkspacePicker)
 * or map the workspace once in Workspace settings. An unsaved (`new`) item has
 * no mapping to honour and still binds the first listed group, so authoring
 * comes up bound per `auto-bind-by-default.md`.
 *
 * NO-FABRIC-DEPENDENCY: this only decides WHICH Power BI group an
 * already-opted-in Power BI leg addresses. It is never called on the default
 * Azure-native path (the editors gate the whole Power BI leg behind
 * `useBiBackend().powerBiEnabled`), and it never invents a workspace.
 */

/** A workspace as returned by /api/powerbi/workspaces (only `id` is needed). */
export interface ListedPbiWorkspace {
  id: string;
}

export interface EditorPbiBindingInput {
  /**
   * The Loom-workspace → Power BI-workspace mapping for THIS item:
   *   - `string` (GUID) — mapped;
   *   - `''`            — resolution finished, definitively UNMAPPED;
   *   - `null`          — still resolving.
   *
   * The three-state shape is load-bearing: with a plain `''` default the effect
   * fires on the first render that has a workspace list and pins the arbitrary
   * fallback BEFORE the mapping arrives — the bug would survive the fix.
   */
  mapped: string | null;
  /** Groups the signed-in caller can actually see. */
  listed: ListedPbiWorkspace[];
  /** This item's own Loom workspace id; `''` for an unsaved (`new`) item. */
  loomWorkspaceId: string;
}

/**
 * Resolve the Power BI group an editor should bind, or `undefined` for "bind
 * nothing yet".
 *
 * Order:
 *   1. Nothing listed → bind nothing (never invent a workspace).
 *   2. Mapping still resolving for a PERSISTED item → wait, so the fallback
 *      cannot win the race.
 *   3. The MAPPED group — but only when the caller can actually see it. A stale
 *      mapping pointing at an invisible group would guarantee the very 401 this
 *      is meant to remove.
 *   4. A PERSISTED item that is CONFIRMED unmapped → bind NOTHING (#2968).
 *   5. A `new` item → the first listed group, as before.
 *
 * The asymmetry between 4 and 5 is the point. A persisted item HAS an identity
 * and a Loom workspace, so there is exactly one right answer (its mapping) and
 * guessing produces the live 401s. A `new` item has nothing to map to yet, the
 * operator sees the picked workspace in the WorkspacePicker beside the canvas
 * and can change it, and `auto-bind-by-default.md` requires the authoring
 * surface to come up bound rather than demanding a manual pick first.
 */
export function resolveEditorPbiBinding(input: EditorPbiBindingInput): string | undefined {
  const { mapped, listed, loomWorkspaceId } = input;
  if (!listed || listed.length === 0) return undefined;
  if (mapped === null && loomWorkspaceId) return undefined;
  const visibleMapped = mapped && listed.some((w) => w.id === mapped) ? mapped : '';
  if (visibleMapped) return visibleMapped;
  // Persisted + confirmed unmapped ⇒ bind nothing. This is the #2968 fix: the
  // old `|| listed[0].id` here is what pinned an arbitrary group and fanned
  // /api/powerbi/{datasets,reports,dashboards,dataflows} at it on every open.
  return loomWorkspaceId ? undefined : listed[0].id;
}
