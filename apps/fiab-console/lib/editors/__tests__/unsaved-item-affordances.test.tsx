/**
 * #3669 (editor half) — NO CONTROL IS OFFERED ON AN UNSAVED ITEM THAT THE ROUTE
 * WILL ONLY GATE.
 *
 * PR #3665 put an honest 200 gate (`{ ok:false, code:'unsaved_item' }`) on the
 * five destructive `databricks-sql-warehouse` routes — edit / start / stop
 * (`state` POST) / delete / clone — and the shared `[type]/[id]/{alerts,
 * sql-security}` routes carry the same idea. The EDITORS did not, so on
 * `/items/<type>/new` the user clicked a live-looking control and was told no.
 *
 * WHAT THESE SPECS PROVE, AND WHAT THEY DO NOT.
 *
 * They prove the DISABLED STATE and the REMEDIATION are computed correctly from
 * the same signals the routes emit, and — via the saved-item half of every pair
 * — that the guard is not simply "always off". They do NOT prove the surface
 * renders correctly, that the tooltip is reachable with a mouse, or that the
 * flow works end-to-end: only an in-browser walk does that (`ux-baseline.md`
 * G1), and three PRs in this series shipped a dead end that reasoning from call
 * sites missed. No browser E2E was run for this change.
 *
 * Every assertion is written as a PAIR — unsaved: DISABLED, saved: ENABLED — so
 * that deleting the guard under test turns the spec red rather than merely
 * un-asserting it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import { DatabricksSqlWarehouseEditor } from '../databricks/sql-warehouse-editor';
import { WarehouseEditor } from '../phase3/warehouse-editor';
import { SynapseServerlessSqlPoolEditor, SynapseDedicatedSqlPoolEditor } from '../synapse-sql-editors';
import { SqlSecurityPanel } from '@/lib/panes/sql-security-panel';
import { makeItem, installFetchMock, renderWithProviders } from './test-helpers';

/**
 * UNMOUNT BEFORE RESTORING THE FETCH MOCK — the sibling idiom
 * (`ai-red-team.test.tsx:21-24`), and load-bearing here rather than cosmetic.
 *
 * `vitest.config.ts` sets `globals: false`, so @testing-library does NOT
 * auto-register its cleanup; `vitest.setup.ts:34` registers one globally, but an
 * `afterEach` declared inside a `describe` runs FIRST. Restoring `global.fetch`
 * while these editors are still mounted let their in-flight `clientFetch` calls
 * land on the real undici `fetch` carrying a jsdom `AbortSignal`, which rejects
 * with `Expected signal to be an instance of AbortSignal` — 7 unhandled
 * rejections that failed the run (exit 1) while all 18 tests passed.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The `[id]/state` gate body, copied from `state/route.ts:119-127`. */
const UNSAVED_STATE_GATE = {
  ok: false,
  code: 'unsaved_item',
  error:
    'Save this SQL warehouse item first — its warehouse state is read and changed in the name '
    + 'of the saved item, and an unsaved item has no owner to check that against yet.',
};

/** One real warehouse, so `warehouseId` is populated exactly as it is live. */
const WAREHOUSES = { ok: true, gov: false, warehouses: [{ id: 'wh-1', name: 'analytics-wh', state: 'STOPPED', cluster_size: 'Small' }] };

/** A SAVED item's `[id]/state` — the control case. STOPPED so Start is offered. */
const SAVED_STATE = { ok: true, state: 'STOPPED', name: 'analytics-wh', cluster_size: 'Small', warehouse_type: 'PRO' };

function buttonsNamed(name: string): HTMLButtonElement[] {
  return screen.queryAllByRole('button', { name }) as HTMLButtonElement[];
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY EVERY "MUST BE DISABLED" ASSERTION WAITS FOR A SETTLE MARKER FIRST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The first version of this file wrapped the disabled-check in `waitFor`, and
 * MEASURED GREEN UNDER MUTATION — removing the `canStart` and `canEditWarehouse`
 * guards outright left all 18 tests passing. `waitFor` RETRIES UNTIL THE
 * CALLBACK PASSES, and on the very first render — before `/warehouses` has
 * resolved — `warehouseId` is `''`, so every control is disabled by the
 * pre-existing `!!warehouseId` clause. The assertion passed on that transient
 * frame and never observed the state the guard actually governs.
 *
 * That is a spec that cannot fail. So: wait for a marker that proves BOTH mount
 * fetches have landed, then assert synchronously on the settled DOM.
 */
async function settledOnGate(gateText: string) {
  // The gate text only renders once `/state` resolved, and `/state` only fires
  // once `/warehouses` populated `warehouseId`. One marker, both fetches.
  await waitFor(() => expect(screen.getByText(gateText)).toBeInTheDocument(), { timeout: 5000 });
}

/** Assert at least one button carries the name, and that ALL of them are disabled. */
function expectAllDisabled(name: string) {
  const btns = buttonsNamed(name);
  expect(btns.length, `no button named "${name}" rendered at all`).toBeGreaterThan(0);
  for (const b of btns) expect(b.disabled, `"${name}" was ENABLED on an unsaved item`).toBe(true);
}

/** Assert at least one button carries the name and is ENABLED (the control case). */
async function expectSomeEnabled(name: string) {
  await waitFor(() => {
    const btns = buttonsNamed(name);
    expect(btns.length, `no button named "${name}" rendered at all`).toBeGreaterThan(0);
    expect(btns.some((b) => !b.disabled), `"${name}" was disabled on a SAVED item — the guard is unconditional, not a gate`).toBe(true);
  }, { timeout: 5000 });
}

describe('#3669 — databricks-sql-warehouse editor on an unsaved item', () => {


  describe('id="new" (the route returns code:unsaved_item)', () => {
    beforeEach(() => {
      installFetchMock({
        '/warehouses': () => WAREHOUSES,
        '/state': () => UNSAVED_STATE_GATE,
      });
      renderWithProviders(
        <DatabricksSqlWarehouseEditor item={makeItem('databricks-sql-warehouse', 'Databricks SQL warehouse')} id="new" />,
      );
    });

    it('renders the guided gate rather than leaving the disabled controls unexplained', async () => {
      // The remediation must reach the user. `lib/components/ribbon.tsx:254-264`
      // discards a ribbon action's `title`, so the MessageBar is the channel.
      await waitFor(() => expect(screen.getByText('Save this item first')).toBeInTheDocument(), { timeout: 5000 });
      expect(screen.getByText(UNSAVED_STATE_GATE.error)).toBeInTheDocument();
    });

    it('disables Start — the gate body renders as state UNKNOWN, which canStart used to ADMIT', async () => {
      await settledOnGate(UNSAVED_STATE_GATE.error);
      expectAllDisabled('Start');
    });

    it('disables Edit (ribbon + toolbar)', async () => {
      await settledOnGate(UNSAVED_STATE_GATE.error);
      expectAllDisabled('Edit');
    });

    it('disables Delete (ribbon + toolbar)', async () => {
      await settledOnGate(UNSAVED_STATE_GATE.error);
      expectAllDisabled('Delete');
    });

    it('disables Stop', async () => {
      await settledOnGate(UNSAVED_STATE_GATE.error);
      expectAllDisabled('Stop');
    });

    it('disables Clone table', async () => {
      await settledOnGate(UNSAVED_STATE_GATE.error);
      expectAllDisabled('Clone table');
    });

    it('carries the route remediation on the toolbar Edit/Delete tooltips', async () => {
      await settledOnGate(UNSAVED_STATE_GATE.error);
      const labelled = [...buttonsNamed('Edit'), ...buttonsNamed('Delete')]
        .filter((b) => b.getAttribute('aria-label') || b.getAttribute('title'));
      expect(labelled.length, 'no Edit/Delete button carried an accessible remediation').toBeGreaterThan(0);
    });
  });

  /**
   * CLONE — THE ONE GUARD THE TEST ABOVE CANNOT MEASURE, MADE MEASURABLE.
   *
   * MEASURED, not assumed: deleting `|| isUnsavedItem` from the Clone action
   * leaves "disables Clone table" GREEN. `canRun` requires `state === 'RUNNING'`,
   * and the gate body reports no state at all, so Clone is already off through
   * the pre-existing clause. A control that cannot tell a real guard from a
   * redundant one is not evidence, so the redundancy is stated rather than
   * papered over.
   *
   * This case drives the branch directly: a `/state` body carrying BOTH the
   * unsaved discriminator AND `state:'RUNNING'`. The live route never emits that
   * combination — it returns the gate alone — so this is explicitly a
   * DEFENCE-IN-DEPTH regression test, not a claim about today's traffic. It pins
   * the property the clause exists for: if `canRun` ever stops implying "saved",
   * Clone must still refuse.
   */
  it('keeps Clone table disabled even if the warehouse reports RUNNING while the item is unsaved', async () => {
    installFetchMock({
      '/warehouses': () => WAREHOUSES,
      '/state': () => ({ ...UNSAVED_STATE_GATE, state: 'RUNNING' }),
    });
    renderWithProviders(
      <DatabricksSqlWarehouseEditor item={makeItem('databricks-sql-warehouse', 'Databricks SQL warehouse')} id="new" />,
    );
    // Settle on a RUNNING-only affordance so `canRun` is provably true first.
    await expectSomeEnabled('Run');
    expectAllDisabled('Clone table');
  });

  describe('a SAVED item id (the control case)', () => {
    beforeEach(() => {
      installFetchMock({
        '/warehouses': () => WAREHOUSES,
        '/state': () => SAVED_STATE,
      });
      renderWithProviders(
        <DatabricksSqlWarehouseEditor item={makeItem('databricks-sql-warehouse', 'Databricks SQL warehouse')} id="1f0f3f4e-0000-4000-8000-abcdefabcdef" />,
      );
    });

    it('does NOT render the unsaved gate', async () => {
      await waitFor(() => expect(buttonsNamed('Edit').length).toBeGreaterThan(0), { timeout: 5000 });
      expect(screen.queryByText('Save this item first')).toBeNull();
    });

    it('enables Start', () => expectSomeEnabled('Start'));
    it('enables Edit', () => expectSomeEnabled('Edit'));
    it('enables Delete', () => expectSomeEnabled('Delete'));
  });
});

describe('#3669 — phase3 warehouse editor Alerts trigger', () => {
  // `isNew` is known synchronously at mount, so the only settle step needed is
  // "the ribbon rendered". Waiting for the BUTTON (not for it to be disabled)
  // keeps the assertion discriminating: with the guard removed the button is
  // enabled on that same first frame and the synchronous check fails.
  it('is disabled on an unsaved item (isNew was computed at :130 and used everywhere but here)', async () => {
    installFetchMock({});
    renderWithProviders(<WarehouseEditor item={makeItem('warehouse', 'Warehouse')} id="new" />);
    await waitFor(() => expect(buttonsNamed('Alerts').length).toBeGreaterThan(0), { timeout: 5000 });
    expectAllDisabled('Alerts');
  });

  it('is enabled on a saved item', async () => {
    installFetchMock({});
    renderWithProviders(<WarehouseEditor item={makeItem('warehouse', 'Warehouse')} id="2f0f3f4e-0000-4000-8000-abcdefabcdef" />);
    await expectSomeEnabled('Alerts');
  });
});

describe('#3669 — synapse SQL security triggers', () => {
  // sql-security/route.ts:382 names this trigger as UNCONDITIONAL.
  it('serverless: GRANT / masking is disabled on an unsaved item', async () => {
    installFetchMock({});
    renderWithProviders(<SynapseServerlessSqlPoolEditor item={makeItem('synapse-serverless-sql-pool', 'Serverless SQL pool')} id="new" />);
    await waitFor(() => expect(buttonsNamed('GRANT / masking').length).toBeGreaterThan(0), { timeout: 5000 });
    expectAllDisabled('GRANT / masking');
  });

  it('serverless: GRANT / masking is enabled on a saved item', async () => {
    installFetchMock({});
    renderWithProviders(<SynapseServerlessSqlPoolEditor item={makeItem('synapse-serverless-sql-pool', 'Serverless SQL pool')} id="3f0f3f4e-0000-4000-8000-abcdefabcdef" />);
    await expectSomeEnabled('GRANT / masking');
  });

  /**
   * sql-security/route.ts:386 records WHY `isOnline` is not a sufficient guard:
   * the dedicated `[id]/state` GET takes no `ctx` at all and is env-derived, so
   * it reports Online for `id === 'new'` too.
   *
   * THE SETTLE MARKER IS LOAD-BEARING. Asserting before `/state` resolves would
   * see `isOnline === false`, which disables this control ANYWAY via the
   * pre-existing clause — the spec would pass with or without the new guard.
   * So it waits until a SIBLING `isOnline`-gated action ("Select into") has
   * gone ENABLED, which proves `isOnline` is true, and only then requires the
   * security trigger to still be off.
   */
  it('dedicated: GRANT / RLS / masking stays disabled on an unsaved item even once the pool reports Online', async () => {
    installFetchMock({ '/state': () => ({ ok: true, state: 'Online', status: 'Online' }) });
    renderWithProviders(<SynapseDedicatedSqlPoolEditor item={makeItem('synapse-dedicated-sql-pool', 'Dedicated SQL pool')} id="new" />);
    await expectSomeEnabled('Select into'); // isOnline is now true
    expectAllDisabled('GRANT / RLS / masking');
  });

  it('dedicated: GRANT / RLS / masking is enabled on a saved, Online pool', async () => {
    installFetchMock({ '/state': () => ({ ok: true, state: 'Online', status: 'Online' }) });
    renderWithProviders(<SynapseDedicatedSqlPoolEditor item={makeItem('synapse-dedicated-sql-pool', 'Dedicated SQL pool')} id="4f0f3f4e-0000-4000-8000-abcdefabcdef" />);
    await expectSomeEnabled('GRANT / RLS / masking');
  });
});

describe('#3669 — SqlSecurityPanel titles its gate truthfully', () => {


  const ROUTE_GATE = {
    ok: false,
    gated: true,
    error: 'Save this item first — the SQL security wizards run against the saved item\'s bound database, and an unsaved item has nothing to bind to yet.',
  };

  it('says "Save this item first" for an unsaved item, not "Configuration required"', async () => {
    installFetchMock({ '/sql-security': () => ROUTE_GATE });
    renderWithProviders(<SqlSecurityPanel itemType="synapse-serverless-sql-pool" itemId="new" />);
    await waitFor(() => expect(screen.getByText('Save this item first')).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.queryByText('Configuration required')).toBeNull();
  });

  it('still says "Configuration required" for a genuine config gate on a saved item', async () => {
    installFetchMock({ '/sql-security': () => ({ ok: false, gated: true, error: 'Set LOOM_SYNAPSE_WORKSPACE on the Console container app.' }) });
    renderWithProviders(<SqlSecurityPanel itemType="synapse-serverless-sql-pool" itemId="5f0f3f4e-0000-4000-8000-abcdefabcdef" />);
    await waitFor(() => expect(screen.getByText('Configuration required')).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.queryByText('Save this item first')).toBeNull();
  });
});
