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
 *   2. Mapping still resolving for a PERSISTED item → wait, so the arbitrary
 *      fallback cannot win the race. A `new` item has no mapping to wait for.
 *   3. The MAPPED group — but only when the caller can actually see it. A stale
 *      mapping pointing at an invisible group would guarantee the very 401 this
 *      is meant to remove.
 *   4. Otherwise the first listed group (the previous behavior), which is now
 *      only reached once the item is CONFIRMED unmapped.
 */
export function resolveEditorPbiBinding(input: EditorPbiBindingInput): string | undefined {
  const { mapped, listed, loomWorkspaceId } = input;
  if (!listed || listed.length === 0) return undefined;
  if (mapped === null && loomWorkspaceId) return undefined;
  const visibleMapped = mapped && listed.some((w) => w.id === mapped) ? mapped : '';
  return visibleMapped || listed[0].id;
}
