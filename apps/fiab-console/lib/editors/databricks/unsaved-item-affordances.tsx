'use client';

/**
 * UNSAVED-ITEM AFFORDANCES for the Databricks SQL warehouse surface (#3669).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PR #3665 put an honest 200 gate (`{ ok:false, code:'unsaved_item' }`) on the
 * five destructive `databricks-sql-warehouse` routes — edit / start / stop
 * (`state` POST) / delete / clone. `sql-warehouse-editor.tsx` had NO notion of
 * an unsaved item at all (`grep -c isNew` was 0), so on
 * `/items/databricks-sql-warehouse/new` all five stayed live and the user
 * clicked a real-looking control to be told no. That is the dead end
 * `auto-bind-by-default.md` forbids and the day-one error state
 * `ux-baseline.md` forbids ("new-item first-open is clean").
 *
 * WHY THIS IS REACHABLE AT ALL, measured rather than assumed: `[id]/warehouses`
 * is session-only — it takes no `ctx` and ignores `[id]` entirely — so on an
 * unsaved item it still returns the real warehouse list, the editor's mount
 * effect sets `warehouseId` from `list[0].id`, and `refreshState` therefore
 * fires. The gate body carries NO `state`, so the editor's `state` falls
 * through to `'UNKNOWN'` — and its `canStart` ADMITS `'UNKNOWN'`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * STATED AS A COUNTERFACTUAL, because the obvious phrasing is FALSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An earlier revision of this code shipped the claim "Start was enabled BECAUSE
 * of the gate". That is wrong, and it was repeated into a PR body and upstream
 * before a reviewer measured it. Start was enabled under ALL THREE route shapes:
 *
 *   - Pre-#3665 (`b9ca620b~1`): the `[id]/state` GET was `getSession()`-only and
 *     ignored `[id]`, so it returned the REAL warehouse state — `STOPPED` — and
 *     `canStart` was true through the `STOPPED` clause.
 *   - Layer 1 with no gate: `guardSynapseItemRequest` fails closed with
 *     `{ok:false, error}` at 404 (`_lib/synapse-item-scope.ts:384`) — no
 *     `state` either, so `'UNKNOWN'`, so true.
 *   - With the gate: `'UNKNOWN'` again, so true.
 *
 * What #3665 changed is the MECHANISM (`STOPPED` → `UNKNOWN`) and, far more
 * importantly, the CONSEQUENCE: an action that actually STARTED a caller-named
 * warehouse became one that only dead-ends. This module closes the dead end; it
 * is not what stopped the destructive call.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A SEPARATE MODULE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two reasons, and the second is the load-bearing one:
 *
 *   1. `sql-warehouse-editor.tsx` is ratchet-frozen at 2200 LOC by
 *      `scripts/ci/check-file-size.mjs`. Adding this inline breached it. The
 *      ceiling is not the thing to edit.
 *   2. `/clone` has TWO entry points — the ribbon "Clone table" action and the
 *      per-table hover action in the schema tree — and a reviewer found the
 *      second one unguarded. With the predicate defined ONCE here and consumed
 *      by both, a mutation that removes the guard removes it from every path,
 *      so the specs cannot pass by covering only one call site.
 */

import { useMemo } from 'react';
import {
  MessageBar, MessageBarBody, MessageBarTitle,
} from '@fluentui/react-components';

/**
 * The route id an UNSAVED editor carries. `/items/<type>/new` is the create
 * route, so `[id]` is the literal string `new` until first save. It can never
 * collide with a real item: `createOwnedItem` mints ids with
 * `crypto.randomUUID()` (`_lib/item-crud.ts:467`). Same literal the routes match
 * (`UNSAVED_ITEM_ID` in `_lib/synapse-item-scope.ts`).
 */
export const UNSAVED_ITEM_ID = 'new';

/**
 * FALLBACK ONLY — used when the server has not answered yet. The real text is
 * the route's own `error`, so the surface never invents its own remediation.
 *
 * Deliberately NOT the string any spec fixture uses: `unsaved-item-affordances.
 * test.tsx` sets a DIFFERENT server remediation precisely so that "the gate text
 * is on screen" proves `/state` resolved, and so the specs can prove which of
 * the two strings is rendered. Making a fixture equal to this constant silently
 * destroys both properties.
 */
export const UNSAVED_WAREHOUSE_FALLBACK =
  'Save this SQL warehouse item first — its warehouse state is read and changed in the '
  + 'name of the saved item, and an unsaved item has no owner to check that against yet.';

/** The subset of the `[id]/state` response this module reads. */
export interface UnsavedGateSource {
  code?: string;
  error?: string;
}

export interface UnsavedWarehouseAffordances {
  /** The item has not been saved, so the lifecycle routes will only gate. */
  isUnsavedItem: boolean;
  /** The route's own remediation, falling back to the constant above. */
  unsavedRemediation: string;
  /**
   * The single `/clone` guard, consumed by BOTH the ribbon action and the
   * schema-tree hover action, and by `openCloneForTable` itself.
   */
  cloneBlocked: boolean;
}

/**
 * TWO SIGNALS, ONE MEANING, and both are deliberate:
 *
 *   - `id === UNSAVED_ITEM_ID` is known SYNCHRONOUSLY at mount, so no control is
 *     briefly live during the round trip `/state` takes to answer. It is the
 *     same literal the routes match, and the mechanism the sibling
 *     `phase3/warehouse-editor.tsx:130` already uses.
 *   - `state?.code === 'unsaved_item'` is the SERVER's own verdict — the
 *     discriminator #3655 keyed on in `warehouse-alerts.tsx:286`. Keying on it
 *     too means the editor follows the route rather than re-deriving it, so if
 *     the gate's id vocabulary ever changes this surface tracks it.
 */
export function useUnsavedWarehouseAffordances(
  id: string,
  state: UnsavedGateSource | null | undefined,
): UnsavedWarehouseAffordances {
  const code = state?.code;
  const error = state?.error;
  return useMemo(() => {
    const isUnsavedItem = id === UNSAVED_ITEM_ID || code === 'unsaved_item';
    return {
      isUnsavedItem,
      unsavedRemediation: (isUnsavedItem && error) || UNSAVED_WAREHOUSE_FALLBACK,
      cloneBlocked: isUnsavedItem,
    };
  }, [id, code, error]);
}

/**
 * THE GUIDED STATE THAT MAKES THE DISABLED CONTROLS HONEST.
 *
 * Disabling Start / Stop / Edit / Delete / Clone without saying why is the dead
 * end `auto-bind-by-default.md` forbids, and it is NOT covered by the ribbon
 * tooltips: `lib/components/ribbon.tsx:254-264` renders a plain ribbon Button
 * with `title={dead ? … : undefined}` and never applies the action's own
 * `title`, so a `disabled` ribbon action's explanation is DISCARDED today
 * (filed as #3673 — that file is not in this change's ownership). This
 * MessageBar is therefore the channel the remediation actually reaches the user
 * through.
 *
 * Render it ABOVE the editor's TabList, not inside a tab: the ribbon controls
 * are disabled on EVERY tab, so an explanation scoped to one tab leaves the
 * others showing five dead controls and no reason.
 *
 * `intent="warning"`, never error: per `ux-baseline.md` a freshly created item
 * must not open on a red banner, and nothing has failed here — the item simply
 * has not been saved yet.
 */
export function UnsavedItemGate({ show, remediation }: { show: boolean; remediation: string }) {
  if (!show) return null;
  return (
    <MessageBar intent="warning">
      <MessageBarBody>
        <MessageBarTitle>Save this item first</MessageBarTitle>
        {remediation}
      </MessageBarBody>
    </MessageBar>
  );
}
