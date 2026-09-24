/**
 * SERVER-DERIVED SCOPE (#4619) — the guard that keeps a security-relevant scope
 * independent of the caller it bounds.
 *
 * Extracted from `item-crud.ts`, which crossed the monolith-creep ratchet
 * (`scripts/ci/check-file-size.mjs`, merge-blocking through the required
 * `guardrails` job) at 1546 LOC against a 1500 threshold. The alternative was an
 * ALLOWLIST entry, and `check-file-size.mjs:48` is explicit that such an entry
 * IS the exception request rather than a formality — so the split was the
 * honest answer, not the cheap one.
 *
 * It is also where this belongs. The enumeration of wholesale `state` writers
 * has now been restated wrongly twice inside one docblock ("at both writers",
 * then a four-item list 230 lines below the seven-item one that corrects it),
 * and both times because the same claim lived in two places in a 1500-line
 * file. **This module is the single home for that enumeration.** If you find
 * yourself restating the writer list anywhere else, link here instead.
 *
 * `item-crud.ts` re-exports every public name below, so all seven call sites
 * and every `vi.mock` factory that names `@/app/api/items/_lib/item-crud`
 * continue to work unchanged.
 */

/** Bounds recursion over caller-supplied JSON. Shared with `item-crud.ts`'s
 *  `collectServerOwned`, which is why it lives here rather than there: both
 *  walkers must agree on the depth, and a second copy would be free to drift. */
export const MAX_STATE_DEPTH = 12;

/** Thrown when a request body tries to write state the server owns. */
export class ServerOwnedStateError extends Error {
  status = 400;
  constructor(public readonly key: string, detail: string) {
    super(detail);
    this.name = 'ServerOwnedStateError';
  }
}

/** JSON with sorted keys, so key ORDER never reads as a value change.
 *  Exported because `item-crud.ts`'s `collectServerOwned` compares SERVER_OWNED
 *  values with the same serialiser — the two walkers must agree on both the
 *  depth bound and the encoding, and a second copy would be free to drift. */
export function stableStringify(v: unknown, depth = 0): string {
  if (depth > MAX_STATE_DEPTH || v === null || typeof v !== 'object') return JSON.stringify(v ?? null) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => stableStringify(x, depth + 1)).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableStringify(x, depth + 1)}`).join(',')}}`;
}

/**
 * SERVER-DERIVED SCOPE — TOP-LEVEL item-state keys a REQUEST BODY may never
 * introduce or change (#4619).
 *
 * WHAT THESE ARE. `state.provisioning` is the receipt the provisioning engine
 * stamps AFTER it has created or attached an item's backing Azure object;
 * `state.storageAccount` names the account a lakehouse is bound to when its lake
 * lives outside the DLZ. Both are read as a SCOPE — the bounds a later request's
 * caller-supplied path, database, job or account is narrowed against.
 *
 * THEY ARE NOT THE SAME KIND OF THING, and an earlier version of this comment
 * said they were ("Neither is user data. Both are records of work the SERVER
 * did."). That is true of `provisioning` and FALSE of `storageAccount`: measured
 * across `apps/fiab-console` (excluding `copilot-corpus`), every top-level
 * `state.storageAccount` site is a READ and NO server path writes it, so it is
 * not a record of work the server did — it is a binding supplied at CREATE that
 * the server then grants against. The rule covers it because of what READS it,
 * not because of what wrote it.
 *
 * THAT MEASUREMENT WAS A KEY-NAME GREP, AND IT MISSED THREE WRITERS. Named
 * here because the instrument matters more than the result: a WHOLESALE writer
 * never mentions the key — that is this rule's entire premise — so "every
 * `state.storageAccount` site is a READ" could not have produced a hit on the
 * writers that matter. It found four, and only because those four read the key
 * by name. The correct instrument is a SHAPE enumeration: every site that
 * writes a whole item document, classified by whether its `state` is
 * caller-derived or server-computed. Run at `18b4a063` over 206 shape-matched
 * `replace<WorkspaceItem>` / `items.create` sites, that yields SEVEN wholesale
 * writers of caller-derived state, not four:
 *
 *   1. `items/[type]/[id]` PATCH                    assert + carry
 *   2. `cosmos-items/[type]/[id]` PATCH             assert + carry
 *   3. `cosmos-items/[type]` POST                   assert only (CREATE)
 *   4. {@link updateOwnedItem}                      assert + carry
 *   5. `items/[type]/[id]/definition` PUT           assert + carry  (PAT-reachable)
 *   6. `items/[type]/[id]/versions/[id]/restore`    carry only
 *   7. workspace bundle import, OVERWRITE arm       carry only
 *
 * 6 and 7 carry without asserting on purpose: neither caller SUPPLIES state so
 * much as SELECTS it (a stored snapshot; a bulk bundle apply), so a refusal
 * would break the feature on a difference that is normal rather than hostile.
 * Each says so at its own site. Everything else that writes `state` is either a
 * narrow server-computed merge (`{ ...item.state, oneField }`) or a CREATE.
 *
 * WHAT THIS BOUND IS, EXACTLY. An earlier version of this comment said
 * `state.storageAccount` was "neither changeable nor clearable through any
 * generic writer" and that re-binding "has no supported path today". BOTH WERE
 * FALSE when written: writers 5, 6 and 7 were unguarded, and 5 is published in
 * `lib/openapi/spec.ts` as `updateItemDefinition`, so a `loom_pat_` token could
 * change the key on a GET/PUT round trip and clear it by omitting it. The bound
 * now holds across all seven, and is stated as a bound over an ENUMERATED set
 * rather than over "any generic writer" — the phrase that made an unmeasured
 * claim sound like a measured one. {@link createOwnedItem} is still exempt.
 *
 * THE COST OF THAT BOUND, disclosed rather than discovered later: with no
 * server writer and now no client writer, `state.storageAccount` is settable
 * only through {@link createOwnedItem}. Re-binding an existing lakehouse to a
 * different account has no supported path today, and version-restore — the
 * intuitive affordance for rolling one back — deliberately no longer does it.
 * That is a real affordance loss, accepted because a write that silently
 * re-points a grant coordinate is worse. Tracked on #4619.
 *
 * ALSO UNDISCLOSED UNTIL NOW, and narrow: a save that round-trips a STALE
 * receipt is refused with a 400 rather than merged. That happens when an editor
 * loaded `state` before a re-provision (`apps/[id]/install`, `learn/notebook-import`)
 * stamped a new receipt underneath it. It fails CLOSED and a reload fixes it,
 * but the message does not currently say "reload the item" — see the per-key
 * reason strings below.
 *
 * Measured readers on this tree:
 *
 *   state.provisioning.secondaryIds.{adlsRoot,container,rootPath}
 *        → lib/azure/lakehouse-abfss.ts  resolveLakehouseAbfss()
 *   state.provisioning.secondaryIds.database
 *        → items/_lib/adx-item-scope.ts, items/_lib/synapse-item-scope.ts
 *   state.provisioning.secondaryIds.jobId
 *        → items/databricks-job/_lib/job-scope.ts
 *   state.provisioning.secondaryIds.notebookPath
 *        → items/databricks-notebook/_lib/notebook-path-scope.ts
 *   state.storageAccount
 *        → lib/azure/lakehouse-abfss.ts, api/lakehouse/references/**, and
 *          api/storage/_lib/authorize.ts, where it IS the T3 grant coordinate.
 *
 * Every one of those writers replaces `state` WHOLESALE from the request body
 * with no schema validation. The set is the enumeration above; this paragraph
 * deliberately does not repeat it. A scope derived from these keys was
 * therefore not independent of the caller it bounds, and a containment
 * comparison against it was weaker than it reads.
 *
 * THIS PARAGRAPH USED TO CARRY ITS OWN FOUR-ITEM LIST — written before the
 * shape enumeration found writers 5, 6 and 7, and not updated when it did. So
 * the docblock stated the set correctly at the top and STALELY here, and the
 * two disagreed across a single comment. No needle scan caught it: the stale
 * copy was a REWORDING, not a repeated string, and an eight-needle sweep whose
 * own control fired 8/8 still matched none of it. A reviewer found it by
 * reading. That is the second time this docblock has restated the writer set
 * and been wrong, and it is the reason the rule in this module's header is
 * "link, do not restate".
 *
 * WHY A TOP-LEVEL KEY RULE AND NOT {@link SERVER_OWNED_STATE_KEYS}. That list is
 * matched BY KEY NAME at ANY DEPTH, which is right for `secretRef` (a distinctive
 * name that is never user data wherever it appears) and WRONG here. `container`
 * and `storageAccount` are ordinary words other item types legitimately carry as
 * user-AUTHORED config. Measured, not assumed:
 * `lib/apps/content-bundles/app-direct-lake-replacement.ts:120-137` puts BOTH on
 * an eventstream source's `config`, and `lib/editors/phase3/eventstream-editor.tsx:1634`
 * / `lib/editors/stream-analytics-editor.tsx:667` are the inputs a user types
 * them into. Adding those names to the depth-blind list would refuse a sink edit
 * that has nothing to do with any scope above. The scopes are read at FIXED
 * PATHS, so the rule is written at those paths.
 *
 * SEMANTICS, matching the block above: reject on INTRODUCE-or-CHANGE, never on
 * presence. A body that round-trips the same value is unaffected, which is what
 * keeps the near-universal `{ ...item.state, oneField: x }` save pattern working.
 * OMISSION IS ALLOWED AND NO LONGER DELETES. The assert below permits a body
 * that leaves a guarded key out — making omission an error would break every
 * caller that builds a fresh state object — but `state` is replaced WHOLESALE,
 * so an omitted key used to be DROPPED. That was the bypass, and it defeated
 * the resolver-side precedence fix outright: ONE request could edit
 * `state.database` and drop `state.provisioning`, leaving no receipt to
 * prefer. {@link carryServerDerivedScope} now rebases those keys onto whatever
 * the item already carries, at ALL SIX UPDATE WRITERS enumerated above. This
 * sentence has been wrong twice, in the same direction both times, and the
 * count is the tell: it said "at both writers" while wired into two of three,
 * then "at all three" while three more writers existed that no key-name grep
 * could see. Each time the missing writer was a route that builds and writes
 * its OWN document instead of calling {@link updateOwnedItem}, so the
 * helper-level carry never reached it. That is the shape to look for, and it is
 * why the list above is an enumeration rather than a number.
 * `cosmos-items/[type]` POST is the seventh wholesale writer and is a CREATE:
 * there is no prior value to rebase onto, so it asserts and does not carry, by
 * construction. Assert first, carry second wherever both apply: an attempted
 * CHANGE stays a 400 rather than becoming a silent substitution, which
 * `adx-item-scope.ts` forbids in as many words.
 *
 * WHAT THAT DOES NOT CLOSE, measured and open: an item with NO successful
 * receipt resolves to whatever it declares, at every reader, because there is
 * no server record to carry forward. `synapse-item-scope.ts` and
 * `notebook-path-scope.ts` then read TOP-LEVEL `state.database` /
 * `state.databaseName` / `state.notebookPath`, which are client-writable and
 * are NOT in {@link SERVER_DERIVED_SCOPE_KEYS}. Guarding those names is not a
 * list entry — it needs the same per-item-type analysis done above for
 * `container` and `storageAccount`, since `database` is ordinary user-authored
 * config on other item types and a blanket top-level rule would refuse
 * legitimate edits.
 *
 * THIS IS DEFENCE IN DEPTH, NOT THE PRIMARY CONTROL — the same position the
 * block above takes, for the same reason: the primary control belongs at the
 * SINK, where it holds for every writer including the ones this helper
 * deliberately does not cover. `api/storage/_lib/authorize.ts` and
 * `items/_lib/databricks-resource-binding.ts` are the two sink-side precedents
 * already on this tree, and the latter says in as many words that item state is
 * a CLAIM, not an ATTESTATION. That stays true after this change.
 *
 * NOT COVERED, and the first two are gaps rather than choices:
 *   - {@link createOwnedItem} — unchanged, and ~20 collection routes pass a raw
 *     request body straight into it (`items/graph-model/route.ts:45`,
 *     `items/_lib/palantir-crud.ts:162` for the whole Palantir family,
 *     `admin/workspaces/[id]/git/branch-out/route.ts:195`). `promote.ts` seeds a promotion target
 *     from the SOURCE item's whole state through it, and that is the create half
 *     of a path that has to keep working — but a rule binding only the UPDATE
 *     routes is satisfiable by creating a fresh item instead. OPEN.
 *   - The TOP-LEVEL scope coordinates `state.database`, `state.databaseName`,
 *     `state.databases[]` and `state.notebookPath`, which three of the four
 *     readers above PREFER over the provisioning receipt when the receipt is
 *     absent. See the omission note above. OPEN.
 *   - `state.ownedContainers`, which also steers branch 3's container choice.
 *     An earlier version of this note said its range is already bounded to
 *     `KNOWN_CONTAINERS` by `isKnownContainer`. That is FALSE at
 *     `api/lakehouse/references/paths/route.ts:72-76`, where a non-empty
 *     `state.ownedContainers` REPLACES `KNOWN_CONTAINERS` as the allowlist
 *     rather than being checked against it. OPEN — deliberately not added to
 *     the list above, because it has ZERO production writers (every tracked
 *     site is a read, a type field, a comment or a fixture), so listing it
 *     would freeze a key nobody writes, and because it is a declaration rather
 *     than a server record. The remedy is sink-side: intersect with
 *     `KNOWN_CONTAINERS` at that route the way `lakehouse-abfss.ts:64-67`
 *     already does. Not done here, and the reason is weaker than it first
 *     looks and is stated at its true strength: that route also serves
 *     EXTERNAL-ACCOUNT reference lakehouses (`account = state.storageAccount`),
 *     where a container outside `KNOWN_CONTAINERS` could legitimately exist and
 *     would start returning 404 — but by the same census that found no writers,
 *     NOTHING ON THIS TREE PRODUCES that configuration. So the risk is to a
 *     hand-built or externally-created item, not to any shipped flow, and the
 *     honest summary is "unmeasured against real data", not "known to break".
 *
 * All three are tracked; none is closed by this rule, and this comment is the
 * place that says so rather than implying coverage by omission.
 */
export const SERVER_DERIVED_SCOPE_KEYS: readonly string[] = [
  'provisioning',
  'storageAccount',
];

/** Own-property probe that refuses arrays and non-objects — never walks a proto chain. */
function hasOwnStateKey(o: unknown, k: string): o is Record<string, unknown> {
  return !!o && typeof o === 'object' && !Array.isArray(o)
    && Object.prototype.hasOwnProperty.call(o, k);
}

/**
 * Why the refusal text is PER KEY. One shared sentence used to tell every
 * caller that the key it sent "is the provisioning receipt for this item's
 * backing Azure object ... so it can only be written by the provisioning path
 * that produces it." That is true of `provisioning` and FALSE of
 * `storageAccount`, which is a bare account name with NO producing path at all.
 * Measured across `apps/fiab-console` (excluding `copilot-corpus`): every
 * top-level `state.storageAccount` site is a READ — `api/storage/_lib/authorize.ts:120`,
 * `api/lakehouse/references/paths/route.ts:71`, `lib/azure/lakehouse-abfss.ts:130`,
 * `lib/azure/purview-autoonboard.ts:182-183` — and no provisioner or auto-bind
 * path assigns it. `deploy-integrity.md` R7: an error must not state as fact
 * something the code did not establish, so the two keys say different things.
 */
const SCOPE_REFUSAL_REASON: Record<string, string> = {
  provisioning:
    'It is the provisioning receipt for this item\'s backing Azure object, which later requests '
    + 'narrow a caller-supplied path, database, job or account against, so it can only be written '
    + 'by the provisioning path that produces it (a direct items.item().replace(), not this route). '
    + 'If you were editing this item while it was being provisioned, reload it and reapply your '
    + 'change — your copy of the receipt is stale, and this refusal is what stops the stale one '
    + 'being written back.',
  storageAccount:
    'It names the storage account this item\'s lake is bound to, and it is the coordinate '
    + 'api/storage/_lib/authorize.ts grants against, so a request that moves it moves a grant. '
    + 'No server path writes it, so on an EXISTING item it is fixed at whatever CREATE set: this '
    + 'request can neither change nor clear it. Re-binding an existing item is tracked on #4619.',
};

/** The subset of {@link SCOPE_REFUSAL_REASON} wording that only makes sense on an
 *  UPDATE. On a CREATE there is no prior value, so nothing is being "changed" or
 *  "cleared" — the request is INTRODUCING a value it is not allowed to set. The
 *  shared string used to be served verbatim on `cosmos-items/[type]` POST, where
 *  "this request can neither change nor clear it" describes nothing that is
 *  happening (`deploy-integrity.md` R7). */
const SCOPE_REFUSAL_ON_CREATE: Record<string, string> = {
  provisioning:
    'It is the provisioning receipt for this item\'s backing Azure object, and it is stamped by '
    + 'the provisioning engine AFTER the backing object exists — so a create cannot supply one. '
    + 'Create the item without it; the receipt appears when provisioning completes.',
  storageAccount:
    'It names the storage account this item\'s lake is bound to, and it is the coordinate '
    + 'api/storage/_lib/authorize.ts grants against. A create may set it only through the '
    + 'item-creation path that owns that binding, not by supplying it in this body.',
};

/**
 * Throw {@link ServerOwnedStateError} when `nextState` would INTRODUCE or CHANGE
 * a TOP-LEVEL {@link SERVER_DERIVED_SCOPE_KEYS} value. Pass `undefined` as
 * `currentState` on a CREATE, where there is no prior value and so any supplied
 * one is an introduction.
 */
export function assertNoServerDerivedScopeChange(nextState: unknown, currentState: unknown): void {
  if (!nextState || typeof nextState !== 'object' || Array.isArray(nextState)) return;
  // A CREATE passes `undefined` — there is no prior document at all, which is
  // what selects the create-shaped wording below. An UPDATE whose item merely
  // lacks the key still gets the update wording, because there a value IS being
  // introduced onto something that exists.
  const isCreate = currentState === undefined;
  for (const key of SERVER_DERIVED_SCOPE_KEYS) {
    if (!hasOwnStateKey(nextState, key)) continue; // omission — allowed, and carried forward
    const incoming = stableStringify(nextState[key]);
    if (hasOwnStateKey(currentState, key) && stableStringify(currentState[key]) === incoming) continue;
    const reason = (isCreate ? SCOPE_REFUSAL_ON_CREATE : SCOPE_REFUSAL_REASON)[key] ?? '';
    throw new ServerOwnedStateError(
      key,
      isCreate
        ? `"state.${key}" is recorded by Loom, not by the client: this request would set it. ${reason}`
        : `"state.${key}" is recorded by Loom, not by the client: this request would change it. ${reason}`,
    );
  }
}

/**
 * Return `nextState` with every {@link SERVER_DERIVED_SCOPE_KEYS} key REBASED
 * onto the value the TARGET item already carries (removed when it carries none),
 * so a cross-item state copy satisfies {@link assertNoServerDerivedScopeChange}.
 *
 * SEVEN CALL SITES, two different jobs. Earlier versions of this docblock said
 * "exists for exactly one caller" and then "FOUR CALL SITES"; both were
 * overtaken, the second by a shape enumeration that found three wholesale
 * writers a key-name grep could not see:
 *
 *   1. THE OMISSION REBASE, at every UPDATE writer that replaces `state`
 *      wholesale — `items/[type]/[id]` PATCH, `cosmos-items/[type]/[id]` PATCH,
 *      {@link updateOwnedItem}, `items/[type]/[id]/definition` PUT,
 *      `items/[type]/[id]/versions/[versionId]/restore`, and the OVERWRITE arm
 *      of the workspace bundle import. A body that merely LEAVES OUT a guarded
 *      key would otherwise delete it; here it preserves. The last two carry
 *      WITHOUT an assert, because their callers select stored state rather than
 *      supplying it — see those sites. `cosmos-items/[type]` POST is the
 *      remaining wholesale writer and is deliberately absent: it is a CREATE,
 *      so there is no prior value to rebase onto.
 *   2. THE CROSS-ITEM COPY, at `deployment-pipelines/loom/_lib/promote.ts`,
 *      which builds its patch from the SOURCE item's state and applies it to a
 *      DIFFERENT, already-existing TARGET item. Without this the source's
 *      provisioning receipt would be written over the target's own — which is
 *      both the change this rule refuses AND wrong on the merits, since a
 *      receipt describes the resource the SOURCE is backed by.
 *      `lib/workspace/item-definition.ts:116` already drops `provisioning` when
 *      it exports a PORTABLE definition, for the same reason; a promotion is
 *      that export followed by an import.
 *
 * Both jobs are the same operation because the function can only ever produce
 * the TARGET's own value or remove the key.
 *
 * Deliberately NOT a bypass flag on {@link updateOwnedItem}: a flag would be
 * reachable from every one of its 400+ call sites, whereas rebasing is safe
 * wherever it is used because it can only ever produce the target's OWN value.
 */
export function carryServerDerivedScope<T extends Record<string, unknown>>(
  nextState: T,
  currentState: unknown,
): T {
  const out: Record<string, unknown> = { ...nextState };
  for (const key of SERVER_DERIVED_SCOPE_KEYS) {
    if (hasOwnStateKey(currentState, key)) out[key] = currentState[key];
    else delete out[key];
  }
  return out as T;
}
