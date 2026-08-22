/**
 * `hasPersistedItemState` — the ONE definition of "this record actually carries
 * saved state", shared by both `useItemState` hooks (#3687).
 *
 * ## Why this predicate exists rather than an inline `if (doc.state)`
 *
 * Every item GET route normalises the response with `state: item.state || {}`:
 *
 *   app/api/items/_lib/palantir-crud.ts:183      (makeItemRoute — palantir family)
 *   app/api/items/variable-library/[id]/route.ts:34
 *   app/api/items/user-data-function/[id]/route.ts:34
 *   …and the same line in plan / ontology / map / graph-model / data-agent /
 *      operations-agent / graphql-api / synthetic-data / agent-flow / …
 *
 * So `doc.state` is **never `undefined` over the wire** — a brand-new item
 * sends `{}`. Any check of the form `if (doc.state && typeof doc.state ===
 * 'object')` is therefore ALWAYS TRUE, and its `else` branch is unreachable
 * through the real routes.
 *
 * That is the trap this file exists to close. A fix for #3687 keyed on `state`
 * being ABSENT would test green against a hand-written fixture that omits
 * `state` and do **nothing whatsoever** in production — a guard with zero
 * population. The population is `{}`, so the predicate keys on `{}`.
 *
 * Azure-native, no Fabric. Pure — no React, no I/O, trivially testable.
 */

/**
 * Does this `doc.state` represent content that was genuinely SAVED?
 *
 * `false` for every shape that means "nothing has been persisted yet":
 * `undefined`, `null`, a non-object, and — the case that actually occurs in
 * production — the empty object `{}`.
 *
 * NOTE: this answers "is there saved content", NOT "did the read succeed".
 * Those are different questions and conflating them is the C19 data-loss bug
 * (see `use-item-doc-state.tsx`). Callers must establish that the read
 * succeeded BEFORE consulting this predicate.
 */
export function hasPersistedItemState(state: unknown): boolean {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  return Object.keys(state as Record<string, unknown>).length > 0;
}
