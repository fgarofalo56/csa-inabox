/**
 * The Unity Catalog **Grants pane copy** — the empty-state line and the
 * explanatory caption — as a pure, backend-aware function (#2651).
 *
 * WHY THIS IS A MODULE AND NOT INLINE JSX. The strings it returns are factual
 * claims on an ACCESS-REVIEW surface: "nobody holds any privilege here — no
 * direct grant, no inherited grant, no owner" is an answer to a governance
 * question, and it used to be selected purely on `effective` / `forPrincipal` /
 * `closureResolved` — never on which backend answered. On Databricks that made
 * it a claim Loom had never checked: the native `effective-permissions` endpoint
 * does not report ownership at all ("Azure Databricks doesn't explicitly grant
 * the ALL PRIVILEGES privilege to the owner … you won't see ALL PRIVILEGES
 * returned when listing permissions using the Databricks API",
 * learn.microsoft.com/azure/databricks/data-governance/unity-catalog/access-control/permissions-concepts#ownership),
 * so a catalog with a real owner rendered as "no owner".
 *
 * Pulling the selection out of `app/catalog/unity/page.tsx` makes every branch
 * assertable in a unit test, which is the only way a copy regression of this
 * class gets caught before an operator reads it as fact.
 *
 * Pure: no imports, no I/O, no Fluent — safe in the client bundle.
 */

export type UcGrantsBackend = 'databricks' | 'oss';

export interface UcEffectiveEmptyStateInput {
  /** Which server actually produced the (empty) answer. */
  backend: UcGrantsBackend;
  /** The securable type the question was asked about, for a concrete sentence. */
  securableType: string;
  /** Set when the query was scoped to one principal. */
  forPrincipal?: string;
  /** True only when the transitive group closure was ACTUALLY resolved from the
   *  directory — never assert "nor through any group" off `[principal]`. */
  closureResolved?: boolean;
  /** The owner Loom read alongside the answer, when there is one. */
  owner?: string;
  /** True when the owner read was attempted and FAILED — so the pane must not
   *  claim the securable is unowned OR name an owner. */
  ownerUnreadable?: boolean;
}

/** What is (and is not) part of the Databricks effective-permissions answer.
 *  Always states the omission; names the owner only when Loom actually read
 *  one, and says so explicitly when it could not. */
function databricksOwnershipNote(i: UcEffectiveEmptyStateInput): string {
  const type = i.securableType.toLowerCase();
  if (i.ownerUnreadable) {
    return 'Ownership is not part of that answer, and Loom could not read this '
      + `${type}'s owner (see the warning above) — so this is not evidence that it is unowned.`;
  }
  if (i.owner) {
    return `Ownership is not part of that answer: ${i.owner} owns this ${type}, and Azure Databricks `
      + "never returns an owner's implied privileges from the permissions APIs.";
  }
  return 'Ownership is not part of that answer — Azure Databricks never returns an '
    + "owner's implied privileges from the permissions APIs.";
}

/**
 * The empty-state line for the effective-permissions grid.
 *
 * On the OSS / Loom Unity backend the BFF resolver itself folds ownership,
 * inheritance and the group closure into the assignments, so an empty grid
 * really does mean "nothing, including no owner" — that copy is unchanged.
 * On Databricks the grid is a passthrough of a narrower answer, and the line
 * says only what that answer covered.
 */
export function ucEffectiveEmptyState(i: UcEffectiveEmptyStateInput): string {
  const principal = (i.forPrincipal || '').trim();
  if (i.backend === 'databricks') {
    const note = databricksOwnershipNote(i);
    return principal
      ? `Databricks reported no effective privilege for ${principal} here. ${note}`
      : `Databricks reported no privilege assignments here. ${note}`;
  }
  if (principal) {
    return i.closureResolved
      // Only claim the group dimension when the directory ACTUALLY answered.
      // With Graph unavailable the closure is just [principal].
      ? `${principal} holds no privileges here — not directly, not from a parent, not through ownership, and not through any group it belongs to.`
      : `${principal} holds no privileges here from any grant, parent or owner that Loom could read. Group memberships were NOT resolved (see the warning above), so a privilege held via a group would not appear.`;
  }
  return 'Nobody holds any privilege here — no direct grant, no inherited grant, no owner.';
}

/**
 * The caption above the grid. In effective mode it must describe what the
 * ANSWERING backend computed — the old text described the OSS resolver's
 * semantics ("add what ownership implies … check the USE CATALOG / USE SCHEMA
 * prerequisites … union in its transitive group memberships") and then appended
 * "Resolved by the Databricks effective-permissions API", promising work the
 * Databricks path does not do.
 */
export function ucGrantsCaption(i: { effective: boolean; backend: UcGrantsBackend }): string {
  if (!i.effective) {
    return 'Showing the grants recorded directly on this securable. Tick “Effective (inherited)” to include everything inherited from its parents and from ownership.';
  }
  if (i.backend === 'databricks') {
    return 'Answered by the Databricks effective-permissions API: the privileges recorded on this '
      + 'securable plus everything inherited down the containment chain (catalog → schema → object), '
      + 'for every principal — or scoped to one principal. Loom does not re-compute any of it. '
      + "Ownership is NOT part of that answer: Azure Databricks never grants an owner ALL PRIVILEGES "
      + 'explicitly, so an owner’s implied privileges never appear in it. Loom reads the owner '
      + 'separately and reports it alongside the grid.';
  }
  return 'Effective permissions resolve inheritance down the containment chain (catalog → schema → object), '
    + 'expand ALL PRIVILEGES, add what ownership implies (the owner of THIS securable holds everything '
    + 'applicable to it; the owner of a PARENT gets MANAGE on it and nothing more — ownership does not '
    + 'inherit downward in Unity Catalog), check the USE CATALOG / USE SCHEMA prerequisites, and — with a '
    + 'principal — union in its transitive group memberships. Resolved by the Loom BFF from the OSS '
    + 'catalog’s direct grants.';
}
