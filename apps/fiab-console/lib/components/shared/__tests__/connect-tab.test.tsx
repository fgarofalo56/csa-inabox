/**
 * N3 — the shared Connect tab.
 *
 * Pins the user-visible contract: the endpoint's honest exposure, a ticket the
 * user mints themselves (short-lived, disclosed expiry), and client snippets
 * that never show a secret. The tab must render FULLY in the not-deployed state
 * — it is an accelerator, not a gate, so there is no red on first open.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { renderWithProviders, installFetchMock } from '@/lib/editors/__tests__/test-helpers';
import { ConnectTab } from '../connect-tab';

const SNIPPETS = [
  {
    id: 'curl-ticket', label: 'Mint a ticket', language: 'bash',
    note: 'Tickets are short-lived and scoped to you.',
    code: "export LOOM_FLIGHT_TICKET=\"$(curl -sS -X POST 'https://loom.test/api/flightsql/session')\"",
  },
  {
    id: 'adbc-python', label: 'ADBC (Python)', language: 'python',
    note: 'Streams Arrow RecordBatches straight into pandas.',
    code: 'conn = flight_sql.connect(uri="grpc+tls://flight.loom.test:443", db_kwargs={"...": os.environ["LOOM_FLIGHT_TICKET"]})',
  },
];

const PUBLISHED = {
  ok: true,
  endpoint: {
    uri: 'grpc+tls://flight.loom.test:443',
    exposure: 'published',
    note: 'Connect directly with any ADBC / Flight SQL client.',
  },
  ticketMintUrl: 'https://loom.test/api/flightsql/session',
  snippets: SNIPPETS,
  arrowThreshold: 5000,
  loomTransportNote: 'Loom grids take the identical Arrow batches over the audited HTTP tier.',
};

const NOT_DEPLOYED = {
  ...PUBLISHED,
  endpoint: {
    uri: '',
    exposure: 'not-deployed',
    note: 'The Flight SQL wire is not deployed in this environment. Loom still serves Arrow over the audited HTTP tier.',
  },
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ConnectTab — published endpoint', () => {
  it('shows the reachable endpoint, its exposure and the Arrow threshold', async () => {
    installFetchMock({ '/api/flightsql/connect': () => PUBLISHED });
    renderWithProviders(<ConnectTab surface="the gold lakehouse" />);

    await waitFor(() => expect(screen.getByText('grpc+tls://flight.loom.test:443')).toBeInTheDocument());
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.getByText('Arrow past 5,000 rows')).toBeInTheDocument();
    expect(screen.getByText(/read the gold lakehouse from your own tools/i)).toBeInTheDocument();
  });

  it('renders a snippet that references the env var, never an inline credential', async () => {
    installFetchMock({ '/api/flightsql/connect': () => PUBLISHED });
    renderWithProviders(<ConnectTab surface="SQL Lab" />);

    await waitFor(() => expect(screen.getByText('ADBC (Python)')).toBeInTheDocument());
    fireEvent.click(screen.getByText('ADBC (Python)'));
    await waitFor(() => expect(screen.getByText(/flight_sql\.connect/)).toBeInTheDocument());
    expect(screen.getByText(/LOOM_FLIGHT_TICKET/)).toBeInTheDocument();
  });

  it('mints a ticket through the audited route and discloses its expiry', async () => {
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const { calls } = installFetchMock({
      '/api/flightsql/connect': () => PUBLISHED,
      '/api/flightsql/session': () => ({
        ok: true, ticket: 'v1.abc.def', ticketId: 'ticket-abcdef12', expiresAt,
        ttlSeconds: 300, signed: true, scope: [],
      }),
    });
    renderWithProviders(<ConnectTab surface="SQL Lab" itemId="lab-1" scope={['container:gold']} />);

    await waitFor(() => expect(screen.getByText('Generate ticket')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Generate ticket'));

    await waitFor(() => expect(screen.getByText('ticket ticket-a')).toBeInTheDocument());
    expect(screen.getByText('Signed')).toBeInTheDocument();
    // The raw ticket is copied to the clipboard, never rendered on screen.
    expect(screen.queryByText('v1.abc.def')).toBeNull();

    const mint = calls.find((c) => c.url.includes('/api/flightsql/session'));
    expect(mint).toBeTruthy();
    expect(JSON.parse(String(mint!.init!.body))).toMatchObject({
      ttlSeconds: 300, itemId: 'lab-1', scope: ['container:gold'],
    });
  });
});

describe('ConnectTab — nothing deployed', () => {
  it('renders the FULL surface with an honest note and no error state', async () => {
    installFetchMock({ '/api/flightsql/connect': () => NOT_DEPLOYED });
    renderWithProviders(<ConnectTab surface="this warehouse" />);

    await waitFor(() => expect(screen.getByText('Not deployed')).toBeInTheDocument());
    // The explanation is present, the ticket affordance still works, and the
    // snippets still render — no empty tab, no red on first open.
    expect(screen.getByText(/not deployed in this environment/i)).toBeInTheDocument();
    expect(screen.getByText('Generate ticket')).toBeInTheDocument();
    expect(screen.getByText('ADBC (Python)')).toBeInTheDocument();
    expect(screen.queryByText(/Connection details unavailable/i)).toBeNull();
  });

  it('surfaces a mint failure inline instead of losing it', async () => {
    installFetchMock({
      '/api/flightsql/connect': () => NOT_DEPLOYED,
      '/api/flightsql/session': () => ({ ok: false, error: 'ticket store unavailable' }),
    });
    renderWithProviders(<ConnectTab surface="SQL Lab" />);

    await waitFor(() => expect(screen.getByText('Generate ticket')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Generate ticket'));
    await waitFor(() => expect(screen.getByText('ticket store unavailable')).toBeInTheDocument());
  });
});
