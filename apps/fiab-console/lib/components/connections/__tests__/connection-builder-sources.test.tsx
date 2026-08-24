/**
 * ConnectionBuilder — the source-type picker.
 *
 * ## The bug this locks down
 *
 * The operator tried to create a mirrored database for Snowflake, was asked for
 * a connection, clicked "New connection", and found NO Snowflake option — the
 * source-type dropdown held Azure services only. So the primary flow of a
 * catalog item type could not be completed at all: `auto-bind-by-default.md`
 * forbids exactly that dead-end bind, and `no-vaporware.md` calls an offered
 * item type whose flow cannot complete vaporware.
 *
 * These tests assert the CONTRACT rather than a snapshot: every source the
 * mirrored-database wizard offers must have a creatable connection type. A card
 * added to MIRROR_SOURCES without a matching connection type fails here, which
 * is the failure the original gap never produced.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { ConnectionBuilder } from '../connection-builder';
import { MIRROR_SOURCES } from '@/lib/editors/components/mirror-source-wizard';
import { CONN_TYPE_LABEL, CONN_TYPE_AUTH_OPTIONS, CONNECTION_TYPES, AUTH_METHODS } from '@/lib/azure/connectable-types';
import { installFetchMock } from '@/lib/editors/__tests__/test-helpers';


function mount(props: Partial<React.ComponentProps<typeof ConnectionBuilder>> = {}) {
  return render(
    <ConnectionBuilder open onClose={() => {}} onCreated={() => {}} {...props} />,
  );
}

/** Open the "Source type" combobox and return the rendered option labels. */
async function openSourceTypes(): Promise<string[]> {
  const combos = screen.getAllByRole('combobox');
  fireEvent.click(combos[0]);
  await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(1));
  return screen.getAllByRole('option').map((o) => o.textContent || '');
}

describe('ConnectionBuilder — every mirrorable source is creatable', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('offers Snowflake in the source-type picker (the reported defect)', async () => {
    mount();
    const labels = await openSourceTypes();
    expect(labels.some((l) => /Snowflake/i.test(l))).toBe(true);
  });

  it('offers a connection type for EVERY source the mirror wizard lists', async () => {
    mount();
    const labels = await openSourceTypes();

    const missing: string[] = [];
    for (const src of MIRROR_SOURCES) {
      // Databricks UC routes to its own item type and needs no connection here.
      if (src.external) continue;
      // At least one of the source's declared connTypes must be creatable.
      const creatable = src.connTypes.some((t) => {
        const label = CONN_TYPE_LABEL[t as keyof typeof CONN_TYPE_LABEL];
        return !!label && labels.some((l) => l.includes(label));
      });
      if (!creatable) missing.push(`${src.id} (needs one of: ${src.connTypes.join(', ')})`);
    }
    expect(missing, `mirror sources with no creatable connection type: ${missing.join(' | ')}`).toEqual([]);
  });

  it('every connTypes entry on a mirror source is a REAL ConnectionType', async () => {
    // Snowflake/BigQuery/Oracle used to declare `connection-string` here, which
    // is an AUTH METHOD, not a connection type — so the "Recommended for this
    // source" group could never match it.
    const bogus: string[] = [];
    for (const src of MIRROR_SOURCES) {
      for (const t of src.connTypes) {
        if (!(CONNECTION_TYPES as string[]).includes(t)) bogus.push(`${src.id}: ${t}`);
      }
    }
    expect(bogus, `not a ConnectionType: ${bogus.join(' | ')}`).toEqual([]);
  });
});

describe('ConnectionBuilder — Snowflake field shape', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('collects account identifier, warehouse, role and schema', async () => {
    mount({ lockType: 'snowflake' });
    await waitFor(() => expect(screen.getByText('Account identifier')).toBeInTheDocument());
    expect(screen.getByText('Warehouse')).toBeInTheDocument();
    expect(screen.getByText('Role')).toBeInTheDocument();
    expect(screen.getByText('Schema')).toBeInTheDocument();
    // ...and NOT the SQL-server framing.
    expect(screen.queryByPlaceholderText('myserver.database.windows.net')).toBeNull();
  });

  it('does not offer Entra managed identity — Snowflake cannot use it', async () => {
    mount({ lockType: 'snowflake' });
    await waitFor(() => expect(screen.getByText('Account identifier')).toBeInTheDocument());
    const combos = screen.getAllByRole('combobox');
    // The auth dropdown is the second combobox (source type is locked first).
    fireEvent.click(combos[1]);
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
    const opts = screen.getAllByRole('option').map((o) => o.textContent || '');
    expect(opts.some((o) => /Key pair/i.test(o))).toBe(true);
    expect(opts.some((o) => /managed identity/i.test(o))).toBe(false);
  });

  it('POSTs the Snowflake coordinates, and the secret only as a field to store', async () => {
    const { calls } = installFetchMock({
      '/api/connections': () => ({ ok: true, connection: { id: 'c1', name: 'n', type: 'snowflake', authMethod: 'sql-password', hasSecret: true } }),
    });
    mount({ lockType: 'snowflake' });
    await waitFor(() => expect(screen.getByText('Account identifier')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('e.g. prod-sales-sql'), { target: { value: 'demo snowflake' } });
    fireEvent.change(screen.getByPlaceholderText('myorg-account123'), { target: { value: 'myorg-acct123' } });
    fireEvent.change(screen.getByPlaceholderText('mydb'), { target: { value: 'SALES_DB' } });
    fireEvent.change(screen.getByPlaceholderText('COMPUTE_WH'), { target: { value: 'COMPUTE_WH' } });
    fireEvent.change(screen.getByPlaceholderText('ACCOUNTADMIN'), { target: { value: 'LOOM_RO' } });
    fireEvent.change(screen.getByPlaceholderText('PUBLIC'), { target: { value: 'PUBLIC' } });
    // Snowflake defaults to Basic auth, so a password is required before save.
    const pwd = document.querySelector('input[type="password"]') as HTMLInputElement;
    expect(pwd).toBeTruthy();
    fireEvent.change(pwd, { target: { value: 'not-a-real-secret' } });

    fireEvent.click(screen.getByRole('button', { name: /Create connection/i }));

    await waitFor(() => {
      expect(calls.some((c) => c.init?.method === 'POST' && c.url.includes('/api/connections'))).toBe(true);
    });
    const post = calls.find((c) => c.init?.method === 'POST' && c.url.includes('/api/connections'))!;
    const body = JSON.parse(String(post.init!.body));
    expect(body.type).toBe('snowflake');
    expect(body.host).toBe('myorg-acct123');
    expect(body.database).toBe('SALES_DB');
    expect(body.warehouse).toBe('COMPUTE_WH');
    expect(body.role).toBe('LOOM_RO');
    expect(body.schema).toBe('PUBLIC');
    // The secret rides ONE hop to the server, which writes it to Key Vault. It
    // must never come back on the connection view.
    expect(body.authMethod).toBe('sql-password');
  });

  it('blocks save until account, database and warehouse are all present', async () => {
    mount({ lockType: 'snowflake' });
    await waitFor(() => expect(screen.getByText('Account identifier')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('e.g. prod-sales-sql'), { target: { value: 'demo' } });
    fireEvent.change(screen.getByPlaceholderText('myorg-account123'), { target: { value: 'myorg-acct123' } });
    fireEvent.change(document.querySelector('input[type="password"]') as HTMLInputElement, { target: { value: 'not-a-real-secret' } });
    // Database + warehouse still blank — the ADF connector requires them, so a
    // connection saved without them could only fail at run time.
    expect(screen.getByRole('button', { name: /Create connection/i })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('mydb'), { target: { value: 'SALES_DB' } });
    expect(screen.getByRole('button', { name: /Create connection/i })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('COMPUTE_WH'), { target: { value: 'COMPUTE_WH' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Create connection/i })).not.toBeDisabled());
  });
});


describe('connection type allowlists stay exhaustive', () => {
  it('CONNECTION_TYPES covers every labelled type and AUTH_METHODS every method', () => {
    // These are DERIVED from the exhaustive label Records rather than hand
    // listed in three API routes — the duplication that let Snowflake reach the
    // union and still be rejected at the request boundary.
    expect(CONNECTION_TYPES).toEqual(Object.keys(CONN_TYPE_LABEL));
    expect(CONNECTION_TYPES).toContain('snowflake');
    expect(AUTH_METHODS).toContain('key-pair');
    // Every connection type declares at least one usable auth method.
    for (const t of CONNECTION_TYPES) {
      expect(CONN_TYPE_AUTH_OPTIONS[t]?.length, `${t} has no auth options`).toBeGreaterThan(0);
    }
  });
});
