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

describe('the mismatch blocks the WRITE, not just the button (#4039 R4)', () => {
  /**
   * WHAT WAS MISSING. Every assertion above this block reads `toBeDisabled()`,
   * which is a claim about an ATTRIBUTE. Two things stop a mismatched mirror
   * being written from this wizard, and only the first was witnessed:
   *
   *   mirror-source-wizard.tsx  Button `disabled={… || !!connMismatch}`   ← pinned
   *   mirror-source-wizard.tsx  submit()  `if (… || connMismatch) return;` ← not
   *
   * WHY THE OBVIOUS TEST DOES NOT WORK, MEASURED. #4039 proposed stripping the
   * `disabled` attribute from the DOM and clicking, on the theory that
   * `submit()` is the reachable second line of defence. It is not: React decides
   * whether to dispatch `onClick` from the FIBER's props, never from the DOM
   * attribute —
   *
   *     react-dom/cjs/react-dom-client.development.js:3292
   *       (props = !props.disabled) || … "button" === inst …
   *
   * so while `disabled` is still in the React props the handler cannot run, no
   * matter what the attribute says. Measured when this was written: deleting
   * `|| connMismatch` from `submit()` leaves this whole file GREEN (mutation R4,
   * RC=0, 12/12 passed). That is recorded here rather than hidden — a suite that
   * claims to witness a line it cannot reach is worse than one that says so.
   *
   * WHAT THESE TESTS DO ESTABLISH: with a mismatch on screen, NO write leaves
   * the wizard — through the affordance, or with the affordance stripped out of
   * the DOM by devtools or automation — and the positive control proves the same
   * click DOES write once the mismatch is repaired, so the absence is the guard
   * and not a wizard that could never write.
   *
   * The enforcement a DOM-bypassing client actually meets is server-side, and it
   * IS witnessed, in the two suites written alongside this one:
   *   app/api/items/mirrored-database/[id]/__tests__/patch-effective-pair.test.ts
   *   app/api/items/mirrored-database/[id]/sources/__tests__/post-effective-connection.test.ts
   */
  /** A `generic-sql` connection has SEVERAL homes, so the wizard leaves the
   *  source type alone and the mismatch survives into create mode. */
  const GENERIC_SQL_CONN = {
    id: 'conn-gen', name: 'onprem-sqlserver', type: 'generic-sql',
    authMethod: 'sql-password', hasSecret: true, host: 'sql.contoso.local', database: 'appdb',
  };

  it('a mismatched CREATE writes nothing even with the disabled attribute removed', async () => {
    const { calls } = installFetchMock({
      '/api/connections': () => ({ ok: true, connections: [GENERIC_SQL_CONN] }),
      '/api/items/mirrored-database': () => ({ ok: true, mirroredDatabase: { id: 'must-not-exist' } }),
    });
    mountNew();
    await waitFor(() => expect(screen.getByText(/Choose a source/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText('Snowflake'));
    await waitFor(() => expect(screen.getByPlaceholderText('myorg-account123')).toBeInTheDocument());
    await pickConnection('onprem-sqlserver');
    await waitFor(() => expect(screen.getByText(/Source type does not match this connection/i)).toBeInTheDocument());

    // A NAME is required by submit() independently of the mismatch, so without
    // this the absence of a write below would prove only that the name was
    // blank. The positive control at the end of this block re-checks that.
    fireEvent.change(screen.getByPlaceholderText('prod-sales-mirror'), { target: { value: 'snow-mirror' } });

    const create = screen.getByRole('button', { name: /Create mirror/i });
    expect(create).toBeDisabled();

    // The mutation this test is built to catch, performed on the DOM instead of
    // on the source: take the affordance away and see whether anything else is
    // holding the line.
    create.removeAttribute('disabled');
    expect(create).toBeEnabled();
    fireEvent.click(create);

    // Give any dispatched submit a turn to reach fetch before asserting absence.
    await waitFor(() => expect(screen.getByText(/Source type does not match this connection/i)).toBeInTheDocument());
    const writes = calls.filter(
      (c) => c.url.includes('/api/items/mirrored-database')
        && ['POST', 'PATCH'].includes(String(c.init?.method || '').toUpperCase()),
    );
    expect(writes).toEqual([]);
  });

  it('POSITIVE CONTROL: the same click DOES write once the mismatch is repaired', async () => {
    // Without this arm the test above would still pass if the wizard could not
    // write at all — "nothing happened" is not evidence that the guard is what
    // stopped it. Same fixture, same click, mismatch resolved.
    const { calls } = installFetchMock({
      '/api/connections': () => ({ ok: true, connections: [GENERIC_SQL_CONN] }),
      '/api/items/mirrored-database': () => ({ ok: true, mirroredDatabase: { id: 'm-new' } }),
    });
    mountNew();
    await waitFor(() => expect(screen.getByText(/Choose a source/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText('Snowflake'));
    await waitFor(() => expect(screen.getByPlaceholderText('myorg-account123')).toBeInTheDocument());
    await pickConnection('onprem-sqlserver');
    await waitFor(() => expect(screen.getByText(/Source type does not match this connection/i)).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('prod-sales-mirror'), { target: { value: 'snow-mirror' } });

    fireEvent.click(screen.getAllByRole('button', { name: /^Switch to / })[0]);
    await waitFor(() => expect(screen.queryByText(/Source type does not match this connection/i)).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /Create mirror/i }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.url.includes('/api/items/mirrored-database')
          && String(c.init?.method || '').toUpperCase() === 'POST'),
      ).toBe(true));
  });

  it('a mismatched EDIT saves nothing either, disabled attribute removed', async () => {
    const { calls } = installFetchMock({
      '/api/connections': () => ({ ok: true, connections: [SNOWFLAKE_CONN] }),
      '/api/items/mirrored-database': () => ({ ok: true, mirroredDatabase: { id: 'm-broken' } }),
    });
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

    const save = screen.getByRole('button', { name: /Save changes/i });
    expect(save).toBeDisabled();
    save.removeAttribute('disabled');
    fireEvent.click(save);

    await waitFor(() => expect(screen.getByText(/Source type does not match this connection/i)).toBeInTheDocument());
    expect(
      calls.filter((c) => String(c.init?.method || '').toUpperCase() === 'PATCH'),
    ).toEqual([]);
  });

  it('POSITIVE CONTROL: with the mismatch repaired, the same click DOES write', async () => {
    // Without this arm the two tests above would still pass if the wizard could
    // never write at all — "nothing happened" is not evidence that the guard is
    // what stopped it.
    const { calls } = installFetchMock({
      '/api/connections': () => ({ ok: true, connections: [SNOWFLAKE_CONN] }),
      '/api/items/mirrored-database': () => ({ ok: true, mirroredDatabase: { id: 'm-broken' } }),
    });
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
    fireEvent.click(screen.getByRole('button', { name: /Switch to Snowflake/i }));
    await waitFor(() => expect(screen.queryByText(/Source type does not match this connection/i)).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    await waitFor(() =>
      expect(
        calls.some((c) => String(c.init?.method || '').toUpperCase() === 'PATCH'),
      ).toBe(true));
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
