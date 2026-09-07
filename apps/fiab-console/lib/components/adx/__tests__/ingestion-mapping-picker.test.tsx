/**
 * IngestionMappingPicker — the FOUR states its hint distinguishes (vitest, jsdom).
 *
 * #3519 round 2 (PR #4348 review). The component was already careful to keep
 * "still reading" (`mappings === null`) apart from "this database genuinely has
 * none" (`[]`), but the unsaved-item short-circuit collapsed into the SECOND of
 * those: `itemId === 'new'` did `setMappings([])`, so an item nothing had been
 * read for rendered *"This database has no ingestion mappings yet."* — an
 * absence the code never established (deploy-integrity R7), and the same shape
 * the rest of the component avoids.
 *
 * These cases hold the distinction from both sides: the unsaved state must NOT
 * make an absence claim and must NOT issue a read, and the saved state must
 * still populate from the real route shape (the positive control, without which
 * "no absence claim" would pass on a component that rendered nothing at all).
 *
 * The fetch stub answers with the VERBATIM body of
 * `app/api/adx/ingestion-mappings/route.ts` GET
 * (`{ ok, database, mappings: [{name, kind, table, mapping}] }`), per
 * no-vaporware.md — no invented shape.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { IngestionMappingPicker, selectMappings } from '../ingestion-mapping-picker';
import { UNSAVED_ITEM_ID as SERVER_UNSAVED_ITEM_ID } from '@/app/api/items/_lib/synapse-item-scope';

/** VERBATIM from app/api/adx/ingestion-mappings/route.ts GET, the success branch. */
const MAPPINGS_OK = {
  ok: true,
  database: 'telemetry',
  mappings: [
    { name: 'EventsJsonMap', kind: 'Json', table: 'Events', mapping: '[]' },
    { name: 'AnyTableMap', kind: 'Json', mapping: '[]' },
  ],
};

function installFetch(body: unknown, status = 200) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }) as Response,
  );
}

function renderPicker(itemId: string) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <IngestionMappingPicker
        itemId={itemId}
        table="Events"
        value=""
        onChange={() => {}}
        label="Ingestion mapping"
      />
    </FluentProvider>,
  );
}

const ABSENCE_CLAIMS = [
  /has no ingestion mappings yet/i,
  /No ingestion mapping is defined for/i,
];

describe('#3519 IngestionMappingPicker — an unsaved item is not an empty database', () => {
  let fetchMock: ReturnType<typeof installFetch>;

  beforeEach(() => {
    fetchMock = installFetch(MAPPINGS_OK);
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('the local UNSAVED_ITEM_ID is the same literal the server module exports', () => {
    // The component cannot import that module (it pulls next/server + Cosmos
    // across the client boundary), so the two are pinned here instead. This
    // test is the reason the re-declaration is safe.
    expect(SERVER_UNSAVED_ITEM_ID).toBe('new');
  });

  it('an unsaved item claims no absence, and issues no read', async () => {
    renderPicker('new');
    // The hint says what is true: nothing has been read because there is
    // nothing to read from yet.
    expect(await screen.findByText(/Save this database first/i)).toBeTruthy();
    for (const claim of ABSENCE_CLAIMS) {
      expect(screen.queryByText(claim)).toBeNull();
    }
    // Nor does it claim to be loading — no request was ever issued.
    expect(screen.queryByText(/Reading the database’s ingestion mappings/i)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL — a saved item does read, and populates from the route body', async () => {
    renderPicker('kqldb-1');
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/adx/ingestion-mappings?id=kqldb-1');
    // 2 mappings survive the Events filter: the table's own + the
    // database-scoped one. If this stayed at the unsaved hint, the case above
    // would be passing on a component that never renders anything else.
    expect(await screen.findByText(/2 mappings available/i)).toBeTruthy();
    expect(screen.queryByText(/Save this database first/i)).toBeNull();
  });

  it('a saved item whose database really has none DOES say so', async () => {
    vi.stubGlobal('fetch', installFetch({ ok: true, database: 'telemetry', mappings: [] }));
    renderPicker('kqldb-1');
    expect(
      await screen.findByText(/No ingestion mapping is defined for Events/i),
    ).toBeTruthy();
    expect(screen.queryByText(/Save this database first/i)).toBeNull();
  });

  it('a FAILED read says the read failed, not that the database is empty', async () => {
    vi.stubGlobal(
      'fetch',
      installFetch({ ok: false, error: 'ADX cluster is not provisioned in this deployment.' }, 503),
    );
    renderPicker('kqldb-1');
    expect(await screen.findByText(/ADX cluster is not provisioned/i)).toBeTruthy();
    for (const claim of ABSENCE_CLAIMS) {
      expect(screen.queryByText(claim)).toBeNull();
    }
  });

  it('selectMappings keeps database-scoped mappings and drops other tables’', () => {
    const picked = selectMappings(MAPPINGS_OK.mappings, 'Events').map((m) => m.name);
    expect(picked).toEqual(['EventsJsonMap', 'AnyTableMap']);
    expect(selectMappings(MAPPINGS_OK.mappings, 'Alerts').map((m) => m.name)).toEqual(['AnyTableMap']);
  });
});
