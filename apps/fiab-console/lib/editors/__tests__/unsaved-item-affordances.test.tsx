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
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO WAYS THESE SPECS PREVIOUSLY FAILED TO MEASURE WHAT THEY NAMED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. `waitFor` RETRIES UNTIL THE CALLBACK PASSES. A "must be disabled"
 *    assertion inside `waitFor` passed on the very first frame, before
 *    `/warehouses` resolved, where `warehouseId` is `''` and the pre-existing
 *    `!!warehouseId` clause already disabled everything. Removing the guards
 *    under test left the suite GREEN.
 *
 * 2. THE SETTLE MARKER WAS NOT A SETTLE MARKER. The fix above waited for the
 *    gate text — but the editor's hard-coded fallback was BYTE-IDENTICAL to the
 *    fixture's server text, and the MessageBar renders on `isUnsavedItem`, which
 *    is synchronously true for `id === 'new'`. So the marker was in the DOM on
 *    the first frame and the specs only still discriminated by the accident of
 *    `await waitFor` being wrapped in async `act()`, which drained the mock's
 *    microtasks. A macrotask-resolving mock would have silently killed them.
 *
 * So the fixture's remediation is now DELIBERATELY DIFFERENT from the client
 * fallback (`SERVER_REMEDIATION` vs `CLIENT_FALLBACK`). That makes the marker
 * reachable only through a resolved `/state`, and it separately lets these specs
 * prove WHICH string is rendered — the route's, not the editor's invention.
 *
 * WHAT THESE SPECS DO NOT PROVE: that the surface renders correctly. Only an
 * in-browser walk does (`ux-baseline.md` G1). No browser E2E was run.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import { DatabricksSqlWarehouseEditor } from '../databricks/sql-warehouse-editor';
import { WarehouseEditor } from '../phase3/warehouse-editor';
import { SynapseServerlessSqlPoolEditor, SynapseDedicatedSqlPoolEditor } from '../synapse-sql-editors';
import { UnifiedSqlDatabaseEditor } from '../unified-sql-database-editor';
import { SqlSecurityPanel } from '@/lib/panes/sql-security-panel';
import { makeItem, installFetchMock, renderWithProviders, selectOptionValue } from './test-helpers';

/**
 * UNMOUNT BEFORE RESTORING THE FETCH MOCK — the sibling idiom
 * (`ai-red-team.test.tsx:21-24`), and load-bearing rather than cosmetic.
 * `vitest.config.ts` sets `globals: false`, so @testing-library does NOT
 * auto-register cleanup; `vitest.setup.ts:34` registers one globally, but an
 * `afterEach` declared inside a `describe` runs FIRST. Restoring `global.fetch`
 * while these editors are still mounted let in-flight `clientFetch` calls land
 * on real undici carrying a jsdom `AbortSignal` — 7 unhandled rejections that
 * failed the run (exit 1) while every test passed.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * The SERVER's remediation. Deliberately NOT the editor's fallback string — see
 * the header. If these two are ever made equal again, `settledOnServerGate`
 * silently stops being a settle marker and the disabled assertions stop
 * discriminating.
 */
const SERVER_REMEDIATION =
  'TEST-SERVER remediation: save this SQL warehouse item before driving its warehouse.';

/** The editor's hard-coded fallback (`sql-warehouse-editor.tsx`), verbatim. */
const CLIENT_FALLBACK =
  'Save this SQL warehouse item first — its warehouse state is read and changed in the '
  + 'name of the saved item, and an unsaved item has no owner to check that against yet.';

/** The `[id]/state` gate body shape, per `state/route.ts:119-127`. */
const UNSAVED_STATE_GATE = { ok: false, code: 'unsaved_item', error: SERVER_REMEDIATION };

/** One real warehouse, so `warehouseId` is populated exactly as it is live. */
const WAREHOUSES = { ok: true, gov: false, warehouses: [{ id: 'wh-1', name: 'analytics-wh', state: 'STOPPED', cluster_size: 'Small' }] };

/** A SAVED item's `[id]/state` — the control case. STOPPED so Start is offered. */
const SAVED_STATE = { ok: true, state: 'STOPPED', name: 'analytics-wh', cluster_size: 'Small', warehouse_type: 'PRO' };

function buttonsNamed(name: string): HTMLButtonElement[] {
  return screen.queryAllByRole('button', { name }) as HTMLButtonElement[];
}

/**
 * Block until `/state` has resolved. Only reachable through a real response,
 * because `SERVER_REMEDIATION !== CLIENT_FALLBACK`; and `/state` only fires once
 * `/warehouses` populated `warehouseId`, so this settles BOTH mount fetches.
 */
async function settledOnServerGate() {
  await waitFor(() => expect(screen.getByText(SERVER_REMEDIATION)).toBeInTheDocument(), { timeout: 5000 });
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

    /**
     * The ROUTE's text, not the editor's. Measured: with the fixture text
     * distinct from the fallback, the fallback is absent from the DOM — so this
     * pins the PR-body claim "the surface never invents its own remediation",
     * which the previous revision asserted nowhere (both strings were equal, so
     * the test passed on the invented one).
     */
    it('renders the ROUTE remediation in the guided gate, not the client fallback', async () => {
      await settledOnServerGate();
      expect(screen.getByText('Save this item first')).toBeInTheDocument();
      expect(screen.queryByText(CLIENT_FALLBACK), 'the client fallback was rendered instead of the route body').toBeNull();
    });

    /**
     * THE PREMISE CHECK for every "must be disabled" assertion below.
     * "Connection details" is gated on `!!warehouseId` ALONE — it carries no
     * unsaved-item clause — so its being ENABLED proves `warehouseId` is set and
     * therefore that the assertions below are not passing through the
     * pre-existing `!!warehouseId` clause. Without this the suite could go green
     * on a render where no fetch ever landed.
     */
    it('has warehouseId populated — so the disabled assertions below are about the new guards', async () => {
      await settledOnServerGate();
      await expectSomeEnabled('Connection details');
    });

    it('disables Start — a stateless gate body renders as UNKNOWN, which canStart admits', async () => {
      await settledOnServerGate();
      expectAllDisabled('Start');
    });

    it('disables Edit', async () => { await settledOnServerGate(); expectAllDisabled('Edit'); });
    it('disables Delete', async () => { await settledOnServerGate(); expectAllDisabled('Delete'); });
    it('disables Stop', async () => { await settledOnServerGate(); expectAllDisabled('Stop'); });
    it('disables Clone table', async () => { await settledOnServerGate(); expectAllDisabled('Clone table'); });

    /**
     * THE TOOLBAR REMEDIATION, PINNED TO ITS EXACT TEXT.
     *
     * The previous revision asserted only that SOME Edit/Delete button carried
     * ANY `aria-label` or `title` — which the pre-existing "Pick a warehouse
     * first" satisfies, so stripping the remediation from both toolbar Tooltips
     * left the suite GREEN (reviewer's M9). Measured with a probe: Fluent's
     * `Tooltip relationship="label"` puts its content in `aria-label`, so the
     * toolbar Edit and Delete have an ACCESSIBLE NAME equal to the remediation
     * (the ribbon's buttons keep their own labels, and carry no `title` at all —
     * `ribbon.tsx` discards it, filed as #3673).
     *
     * So: exactly two buttons must be named by the route's remediation, and both
     * must be disabled. Any weakening of either Tooltip drops that count.
     */
    it('names the toolbar Edit + Delete with the route remediation, and disables both', async () => {
      await settledOnServerGate();
      const labelled = buttonsNamed(SERVER_REMEDIATION);
      expect(labelled.length, 'toolbar Edit + Delete should both be labelled by the route remediation').toBe(2);
      for (const b of labelled) expect(b.disabled).toBe(true);
    });
  });

  /**
   * CLONE — THE GUARD THE PLAIN CASE CANNOT MEASURE, MADE MEASURABLE.
   *
   * MEASURED: deleting the unsaved clause from the Clone action leaves the plain
   * "disables Clone table" GREEN, because `canRun` requires `state === 'RUNNING'`
   * and the gate body reports no state — so Clone is already off through the
   * pre-existing clause. A control that cannot tell a real guard from a
   * redundant one is not evidence.
   *
   * This drives the branch directly with a `/state` body carrying BOTH the
   * unsaved discriminator AND `state:'RUNNING'`. The live route never emits that
   * combination, so this is explicitly a DEFENCE-IN-DEPTH regression test: if
   * `canRun` ever stops implying "saved", Clone must still refuse.
   */
  describe('RUNNING + unsaved (defence in depth)', () => {
    beforeEach(() => {
      installFetchMock({
        '/warehouses': () => WAREHOUSES,
        '/state': () => ({ ...UNSAVED_STATE_GATE, state: 'RUNNING' }),
        '/schema': (url: string) => {
          if (url.includes('&schema=')) return { ok: true, tables: ['orders'], views: [], functions: [], streamingTables: [], materializedViews: [] };
          if (url.includes('&catalog=')) return { ok: true, schemas: ['sales'] };
          return { ok: true, catalogs: ['main'] };
        },
      });
      renderWithProviders(
        <DatabricksSqlWarehouseEditor item={makeItem('databricks-sql-warehouse', 'Databricks SQL warehouse')} id="new" />,
      );
    });

    it('keeps the ribbon Clone table disabled even though canRun is true', async () => {
      await expectSomeEnabled('Run'); // canRun is provably true
      expectAllDisabled('Clone table');
    });

    /**
     * THE SECOND ENTRY POINT TO `/clone`, found in review: the per-table hover
     * action in the schema tree had no `disabled` at all.
     *
     * NOT ASSERTED THROUGH THE DOM, and that limit is stated rather than hidden.
     * Reaching that button needs Fluent's Tree branch to be EXPANDED (the child
     * `<Tree>` renders only for an open branch), and driving that expansion in
     * jsdom did not work reliably — the drill-down produced no `Clone <table>`
     * button. Rather than ship a test that passes for the wrong reason, the
     * coverage is TRANSITIVE and mechanical: the tree button's `disabled`, the
     * ribbon action's `disabled`, and `openCloneForTable`'s early return all
     * read ONE exported `cloneBlocked` from `unsaved-item-affordances.tsx`, and
     * mutation M3 flips that single definition to `false` — which turns the
     * assertion above red. There is no way for the tree path to diverge from
     * the ribbon path without deleting the shared field.
     */
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
      expect(screen.queryByText(CLIENT_FALLBACK)).toBeNull();
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

describe('#3669 — SQL security triggers (all three editors the route names)', () => {
  // sql-security/route.ts:382 names this trigger as UNCONDITIONAL.
  it('synapse serverless: GRANT / masking is disabled on an unsaved item', async () => {
    installFetchMock({});
    renderWithProviders(<SynapseServerlessSqlPoolEditor item={makeItem('synapse-serverless-sql-pool', 'Serverless SQL pool')} id="new" />);
    await waitFor(() => expect(buttonsNamed('GRANT / masking').length).toBeGreaterThan(0), { timeout: 5000 });
    expectAllDisabled('GRANT / masking');
  });

  it('synapse serverless: GRANT / masking is enabled on a saved item', async () => {
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
   * see `isOnline === false`, which disables this control ANYWAY through the
   * pre-existing clause — the spec would pass with or without the new guard. So
   * it waits until a SIBLING `isOnline`-gated action ("Select into") has gone
   * ENABLED, and only then requires the security trigger to still be off.
   */
  it('synapse dedicated: GRANT / RLS / masking stays disabled on an unsaved item once the pool reports Online', async () => {
    installFetchMock({ '/state': () => ({ ok: true, state: 'Online', status: 'Online' }) });
    renderWithProviders(<SynapseDedicatedSqlPoolEditor item={makeItem('synapse-dedicated-sql-pool', 'Dedicated SQL pool')} id="new" />);
    await expectSomeEnabled('Select into'); // isOnline is now true
    expectAllDisabled('GRANT / RLS / masking');
  });

  it('synapse dedicated: GRANT / RLS / masking is enabled on a saved, Online pool', async () => {
    installFetchMock({ '/state': () => ({ ok: true, state: 'Online', status: 'Online' }) });
    renderWithProviders(<SynapseDedicatedSqlPoolEditor item={makeItem('synapse-dedicated-sql-pool', 'Dedicated SQL pool')} id="4f0f3f4e-0000-4000-8000-abcdefabcdef" />);
    await expectSomeEnabled('GRANT / RLS / masking');
  });

  /**
   * THE THIRD EDITOR, added in review. `sql-security/route.ts:376-381` names it
   * alongside the two Synapse triggers; its trigger gated on
   * `server && database && family === 'azure-sql'` with no `isNew`.
   *
   * FIXTURE SHAPE READ FROM THE COMPONENT'S OWN `Inventory` interface
   * (`unified-sql-database-editor.tsx:258-262`), not guessed: the first attempt
   * used `sql: [...]` and crashed the editor inside `serverFqdn`'s
   * `inv.sql.servers.find(...)`. A fixture that models what the test wishes the
   * code did, rather than what it does, is its own failure mode.
   *
   * THE SERVER AND DATABASE MUST ACTUALLY BE PICKED. Measured: asserting on the
   * freshly mounted editor passes with OR without the new guard, because
   * `server`/`database` are empty and the pre-existing clause disables the
   * trigger anyway — the reviewer's M11 stayed GREEN. So this drives both native
   * `<select>`s through `selectOptionValue` (which waits for the option to exist
   * before firing, per the #2834 flake note) and only then asserts.
   */
  const AZURE_SQL_INV = {
    ok: true,
    sql: { servers: [{ id: '/subscriptions/sub/servers/srv1', name: 'srv1', location: 'eastus2', fqdn: 'srv1.database.windows.net', resourceGroup: 'rg', subscriptionId: 'sub' }] },
    mi: { instances: [] },
    postgres: { servers: [] },
  };

  async function mountUnified(id: string) {
    installFetchMock({
      '/api/items/sql-databases': () => AZURE_SQL_INV,
      '/databases?server=': () => ({ ok: true, databases: [{ name: 'db1', sku: { name: 'GP_S_Gen5' } }] }),
    });
    renderWithProviders(<UnifiedSqlDatabaseEditor item={makeItem('azure-sql-database', 'Azure SQL database')} id={id} />);
    const selects = await waitFor(() => {
      const found = Array.from(document.querySelectorAll('select')) as HTMLSelectElement[];
      expect(found.length, 'the connect-tab pickers never rendered').toBeGreaterThanOrEqual(3);
      return found;
    }, { timeout: 5000 });
    // [0] family, [1] server, [2] database — in DOM order on the Connect tab.
    await selectOptionValue(selects[1], 'srv1');
    await selectOptionValue(selects[2], 'db1');
  }

  it('unified azure-sql: GRANT / RLS / masking is disabled on an unsaved item even with a server + database picked', async () => {
    await mountUnified('new');
    expectAllDisabled('GRANT / RLS / masking');
  });

  it('unified azure-sql: GRANT / RLS / masking is enabled on a saved item with the same selection', async () => {
    await mountUnified('6f0f3f4e-0000-4000-8000-abcdefabcdef');
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
