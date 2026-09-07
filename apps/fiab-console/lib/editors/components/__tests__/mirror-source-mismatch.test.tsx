/**
 * MirrorSourceWizard — the source-type / connection-type trap.
 *
 * The wizard hardcoded `useState('AzureSqlDatabase')` while step 1 said "Choose
 * a source", and the connection picker deliberately offers EVERY saved
 * connection (including incompatible ones, under "Other connections" — a prior
 * fix, because strictly filtering used to hide connections the operator had just
 * created). Those two together let a Snowflake connection be bound to a mirror
 * typed Azure SQL, which the BFF then read over TDS against a hostname it
 * constructed. See lib/azure/mirror-source-compat.ts for the full incident.
 *
 * These tests pin the wizard half of the fix: no guessed default, and a
 * connection whose type has exactly one home MOVES the source type rather than
 * letting the mismatch travel into a create.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MirrorSourceWizard } from '../mirror-source-wizard';
import { installFetchMock } from '../../__tests__/test-helpers';

/** An obviously-fake Snowflake connection — never a real account identifier. */
const SNOWFLAKE_CONN = {
  id: 'conn-snow', name: 'snowflake-prod', type: 'snowflake',
  authMethod: 'key-pair', hasSecret: true, host: 'fakeorg-fakeacct999', database: 'SALES_DB',
};
const SQL_CONN = {
  id: 'conn-sql', name: 'azure-sql-prod', type: 'azure-sql',
  authMethod: 'sql-password', hasSecret: true, host: 'srv.database.windows.net', database: 'appdb',
};

function mountNew() {
  return render(
    <MirrorSourceWizard
      open
      editing={false}
      workspaceId="ws-1"
      onClose={() => {}}
      onCreated={() => {}}
      onUpdated={() => {}}
    />,
  );
}

/** Open the connection Dropdown and click an option by its visible name. */
async function pickConnection(name: string) {
  // No `?? getAllByRole(...)[0]` fallback: `getByRole` THROWS when it finds
  // nothing, so the right-hand side was unreachable and only read as if the
  // null case were handled.
  fireEvent.click(screen.getByRole('combobox', { name: '' }));
  await waitFor(() => expect(screen.getByRole('option', { name: new RegExp(name) })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('option', { name: new RegExp(name) }));
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('no source type is chosen for the operator', () => {
  it('does not pre-select Azure SQL Database — steps 2-4 wait for an explicit pick', async () => {
    installFetchMock({ '/api/connections': () => ({ ok: true, connections: [] }) });
    mountNew();
    await waitFor(() => expect(screen.getByText(/Choose a source/i)).toBeInTheDocument());

    // The tell that a default was applied: step 2 renders its connection +
    // server/database form. With no pick, it must not.
    expect(screen.queryByText(/Connection & authentication/i)).toBeNull();
    expect(screen.queryByPlaceholderText('server.database.windows.net')).toBeNull();
    expect(screen.getByText(/Pick a source to continue/i)).toBeInTheDocument();
    // …and nothing can be created without one.
    expect(screen.queryByRole('button', { name: /Create mirror/i })).toBeNull();
  });

  it('reveals the rest of the wizard once a source is picked', async () => {
    installFetchMock({ '/api/connections': () => ({ ok: true, connections: [] }) });
    mountNew();
    await waitFor(() => expect(screen.getByText(/Choose a source/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText('Azure SQL Database'));
    await waitFor(() => expect(screen.getByText(/Connection & authentication/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Create mirror/i })).toBeInTheDocument();
  });

  it('a STORED mirror with no source type recorded is not defaulted to Azure SQL either', async () => {
    // The edit path had its own `|| 'AzureSqlDatabase'` fallback. An unknown
    // stored source type is an unknown: guessing Azure SQL for it is the same
    // mistake as guessing it for a brand-new mirror.
    installFetchMock({ '/api/connections': () => ({ ok: true, connections: [] }) });
    render(
      <MirrorSourceWizard
        open
        editing
        workspaceId="ws-1"
        mirrorId="m-legacy"
        initialSrc={{ sourceType: '', database: 'appdb', displayName: 'legacy-mirror' }}
        onClose={() => {}}
        onCreated={() => {}}
        onUpdated={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Choose a source/i)).toBeInTheDocument());
    expect(screen.getByText(/Pick a source to continue/i)).toBeInTheDocument();
    expect(screen.queryByText(/Connection & authentication/i)).toBeNull();
    expect(screen.queryByPlaceholderText('server.database.windows.net')).toBeNull();
  });
});

describe('a connection with exactly one home moves the source type to it', () => {
  it('picking a Snowflake connection under an Azure SQL mirror switches to Snowflake', async () => {
    installFetchMock({ '/api/connections': () => ({ ok: true, connections: [SNOWFLAKE_CONN, SQL_CONN] }) });
    mountNew();
    await waitFor(() => expect(screen.getByText(/Choose a source/i)).toBeInTheDocument());

    // Reproduce the operator's path exactly: choose Azure SQL Database, then
    // bind the Snowflake connection.
    fireEvent.click(screen.getByText('Azure SQL Database'));
    await waitFor(() => expect(screen.getByText(/Connection & authentication/i)).toBeInTheDocument());
    // Azure SQL's own field shape is on screen at this point…
    expect(screen.getByPlaceholderText('server.database.windows.net')).toBeInTheDocument();

    await pickConnection('snowflake-prod');

    // …and after binding a Snowflake connection the wizard is a SNOWFLAKE
    // wizard: account-identifier field, Iceberg option, and the switch disclosed.
    await waitFor(() => expect(screen.getByPlaceholderText('myorg-account123')).toBeInTheDocument());
    expect(screen.queryByPlaceholderText('server.database.windows.net')).toBeNull();
    expect(screen.getByText(/Include Iceberg tables/i)).toBeInTheDocument();
    expect(screen.getByText(/Source type set to/i)).toBeInTheDocument();
  });

  it('a COMPATIBLE connection changes nothing', async () => {
    installFetchMock({ '/api/connections': () => ({ ok: true, connections: [SNOWFLAKE_CONN, SQL_CONN] }) });
    mountNew();
    await waitFor(() => expect(screen.getByText(/Choose a source/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText('Azure SQL Database'));
    await waitFor(() => expect(screen.getByText(/Connection & authentication/i)).toBeInTheDocument());

    await pickConnection('azure-sql-prod');

    // Still the Azure SQL wizard; no switch banner, no mismatch bar.
    await waitFor(() => expect(screen.getByPlaceholderText('server.database.windows.net')).toBeInTheDocument());
    expect(screen.queryByText(/Source type set to/i)).toBeNull();
    expect(screen.queryByText(/Source type does not match this connection/i)).toBeNull();
  });

  it('does NOT auto-switch when the connection type has SEVERAL homes', async () => {
    // R6 — "exactly one home" must mean exactly one. A `generic-sql` connection
    // legitimately backs SQL Server 2025, SQL Server 2016-2022, Azure SQL DB/MI,
    // Oracle and open mirroring; silently picking the first of those would be
    // the wizard guessing a backend again, which is the whole defect. It must
    // ASK — a Fix-it button per candidate — and leave the source type alone.
    const GENERIC_SQL_CONN = {
      id: 'conn-gen', name: 'onprem-sqlserver', type: 'generic-sql',
      authMethod: 'sql-password', hasSecret: true, host: 'sql.contoso.local', database: 'appdb',
    };
    installFetchMock({ '/api/connections': () => ({ ok: true, connections: [GENERIC_SQL_CONN] }) });
    mountNew();
    await waitFor(() => expect(screen.getByText(/Choose a source/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText('Snowflake'));
    await waitFor(() => expect(screen.getByPlaceholderText('myorg-account123')).toBeInTheDocument());

    await pickConnection('onprem-sqlserver');

    await waitFor(() => expect(screen.getByText(/Source type does not match this connection/i)).toBeInTheDocument());
    // Did NOT silently adopt a source type…
    expect(screen.queryByText(/Source type set to/i)).toBeNull();
    // …still Snowflake…
    expect(screen.getByPlaceholderText('myorg-account123')).toBeInTheDocument();
    // …and offers MORE THAN ONE Fix-it, so the user chooses.
    const switchButtons = screen.getAllByRole('button', { name: /^Switch to / });
    expect(switchButtons.length).toBeGreaterThan(1);
    // Create stays blocked until they do.
    expect(screen.getByRole('button', { name: /Create mirror/i })).toBeDisabled();
  });
});

describe('an ALREADY-SAVED mismatch is surfaced with a Fix-it, not silently rewritten', () => {
  it('opening Edit on the mirror this defect produced blocks Save and offers the switch', async () => {
    installFetchMock({ '/api/connections': () => ({ ok: true, connections: [SNOWFLAKE_CONN] }) });
    render(
      <MirrorSourceWizard
        open
        editing
        workspaceId="ws-1"
        mirrorId="m-broken"
        initialSrc={{
          sourceType: 'AzureSqlDatabase',
          server: 'fakeorg-fakeacct999',
          database: 'SALES_DB',
          connectionId: SNOWFLAKE_CONN.id,
          displayName: 'snow-mirror',
        }}
        onClose={() => {}}
        onCreated={() => {}}
        onUpdated={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText(/Source type does not match this connection/i)).toBeInTheDocument());
    // The refusal names the real cause, not a DNS failure.
    expect(screen.getByText(/no request was sent to either system/i)).toBeInTheDocument();
    // Save is blocked while the mirror contradicts its connection.
    expect(screen.getByRole('button', { name: /Save changes/i })).toBeDisabled();

    // One click repairs it — the source type IS mutable after creation (PATCH
    // persists `sourceType`), so this mirror does not need deleting.
    fireEvent.click(screen.getByRole('button', { name: /Switch to Snowflake/i }));
    await waitFor(() => expect(screen.queryByText(/Source type does not match this connection/i)).toBeNull());
    expect(screen.getByRole('button', { name: /Save changes/i })).toBeEnabled();
  });
});

describe('the refusal is in submit(), not only in the disabled attribute (#4039)', () => {
  /**
   * WHAT THIS PINS, AND WHY GETTING TO IT TOOK THREE ATTEMPTS.
   *
   * `submit()` opens with `if (… || connMismatch) return;` — a real guard on the
   * write path, and the LAST one: everything above it is presentation. Every
   * other test in this file asserts `toBeDisabled()` on the Save button, so
   * deleting `|| connMismatch` from submit() leaves the whole suite green. That
   * clause was correct and completely unwitnessed (#4039).
   *
   * Reaching it turned out to be the hard part, and both dead ends are recorded
   * because each looks like it should work:
   *
   *   1. `fireEvent.click(save)` — jsdom does not dispatch click on a `disabled`
   *      button at all.
   *   2. `save.removeAttribute('disabled')` and then click — MEASURED with the
   *      guard deleted, and the test still passed: `disabled=false` on the node,
   *      and nothing but `/api/connections` in the fetch log. React's
   *      `getListener` refuses mouse events for form elements whose FIBER PROPS
   *      say `disabled`, whatever the DOM attribute says. An assertion that
   *      passes identically with and without the code under test measures
   *      nothing.
   *   3. Calling the DOM node's `__reactProps$.onClick` — that is not `submit`,
   *      it is Fluent's `useARIAButtonProps` wrapper, which short-circuits to
   *      `preventDefault()` when `isDisabled` and never calls through.
   *
   * So the handler is read off the `<Button>` ELEMENT's own props, one fiber
   * above the host node — the `onClick={submit}` the wizard actually wrote. That
   * is the real closure over the real component state in the real mismatch
   * condition, and it is the only vantage point from which submit()'s own guard
   * is observable at all.
   *
   * Worth stating plainly: with those two interception layers, submit() is
   * DEFENCE IN DEPTH rather than the only thing standing between a mismatch and
   * a write. It is still the clause that has to hold if the button is ever
   * enabled, re-used, or driven from a keyboard path, and it is now witnessed.
   */
  const mismatched = () =>
    render(
      <MirrorSourceWizard
        open
        editing
        workspaceId="ws-1"
        mirrorId="m-broken"
        initialSrc={{
          sourceType: 'AzureSqlDatabase',
          server: 'fakeorg-fakeacct999',
          database: 'SALES_DB',
          connectionId: SNOWFLAKE_CONN.id,
          displayName: 'snow-mirror',
        }}
        onClose={() => {}}
        onCreated={() => {}}
        onUpdated={() => {}}
      />,
    );

  /**
   * The `onClick` the WIZARD passed to `<Button appearance="primary">` — i.e.
   * `submit` itself, not Fluent's disabled-aware wrapper around it.
   *
   * React keeps TWO fiber trees and `node.__reactFiber$` can point at the stale
   * one, whose `memoizedProps.onClick` is a `useCallback` closure from an
   * earlier render — measured here, and it silently inverted the result: the
   * captured `submit` had been created before the connections fetch resolved, so
   * its `connMismatch` was still null and it wrote happily. Both trees are
   * therefore searched and the props are DISAMBIGUATED by `disabled`, which must
   * agree with what the button is rendering right now. Ambiguity throws rather
   * than picking one.
   */
  function wizardSubmitHandler(el: HTMLElement): () => unknown {
    const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    expect(fiberKey, 'no React fiber on the Save button — this probe would be inert').toBeTruthy();
    const domDisabled = (el as HTMLButtonElement).disabled;

    const candidates: any[] = [];
    let fiber: any = (el as any)[fiberKey!];
    while (fiber) {
      for (const f of [fiber, fiber.alternate]) {
        const props = f && f.memoizedProps;
        if (props && props.appearance === 'primary' && typeof props.onClick === 'function') {
          candidates.push(props);
        }
      }
      fiber = fiber.return;
    }
    expect(candidates.length, 'the primary Button carrying onClick={submit} was not found').toBeGreaterThan(0);

    const live = candidates.filter((p) => !!p.disabled === domDisabled);
    expect(
      live.length,
      `no Button fiber agrees with the rendered disabled=${domDisabled}; the closure this would ` +
        'capture is from some other render and the assertion below would be meaningless',
    ).toBeGreaterThan(0);
    return live[0].onClick;
  }

  /** Any request that would PERSIST the mirror. */
  const writes = (calls: { url: string; init?: RequestInit }[]) =>
    calls.filter(
      (c) =>
        /\/api\/items\/mirrored-database/.test(c.url) &&
        ['POST', 'PATCH', 'PUT'].includes(String(c.init?.method || 'GET').toUpperCase()),
    );

  it('invoking submit() while the mismatch is live writes NOTHING', async () => {
    const { calls } = installFetchMock({
      '/api/connections': () => ({ ok: true, connections: [SNOWFLAKE_CONN] }),
      '/api/items/mirrored-database': () => ({ ok: true, mirroredDatabase: { id: 'm-broken' } }),
    });
    mismatched();

    await waitFor(() => expect(screen.getByText(/Source type does not match this connection/i)).toBeInTheDocument());
    const save = screen.getByRole('button', { name: /Save changes/i });
    expect(save).toBeDisabled();

    await wizardSubmitHandler(save)();

    expect(writes(calls)).toEqual([]);
  });

  it('CONTROL — once the mismatch is repaired, the SAME handler DOES write', async () => {
    // Without this arm the assertion above would also pass if the wizard could
    // never write at all — a broken fetch mock, a handler that never binds, or
    // a probe that resolved to something inert.
    const { calls } = installFetchMock({
      '/api/connections': () => ({ ok: true, connections: [SNOWFLAKE_CONN] }),
      '/api/items/mirrored-database': () => ({ ok: true, mirroredDatabase: { id: 'm-broken' } }),
    });
    mismatched();

    await waitFor(() => expect(screen.getByText(/Source type does not match this connection/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Switch to Snowflake/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Save changes/i })).toBeEnabled());

    await wizardSubmitHandler(screen.getByRole('button', { name: /Save changes/i }))();

    await waitFor(() => expect(writes(calls).length).toBeGreaterThan(0));
    expect(writes(calls)[0].init?.method).toBe('PATCH');
  });
});

describe('"Load tables" cannot dial a mismatch', () => {
  it('shows the real cause instead of calling the enumerator', async () => {
    const { calls } = installFetchMock({
      '/api/connections': () => ({ ok: true, connections: [SNOWFLAKE_CONN] }),
      '/api/items/mirrored-database/source-tables': () => ({ ok: true, tables: [] }),
    });
    render(
      <MirrorSourceWizard
        open
        editing
        workspaceId="ws-1"
        initialSrc={{
          sourceType: 'AzureSqlDatabase', server: 'fakeorg-fakeacct999', database: 'SALES_DB',
          connectionId: SNOWFLAKE_CONN.id, displayName: 'snow-mirror',
        }}
        onClose={() => {}}
        onCreated={() => {}}
        onUpdated={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Source type does not match this connection/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Load tables/i }));

    await waitFor(() => expect(screen.getAllByText(/no request was sent to either system/i).length).toBeGreaterThan(0));
    // The enumerator was never called — the round-trip that produced the
    // misleading DNS error does not happen at all.
    expect(calls.some((c) => c.url.includes('source-tables'))).toBe(false);
  });
});
