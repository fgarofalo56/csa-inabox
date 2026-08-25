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
  fireEvent.click(screen.getByRole('combobox', { name: '' }) ?? screen.getAllByRole('combobox')[0]);
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
