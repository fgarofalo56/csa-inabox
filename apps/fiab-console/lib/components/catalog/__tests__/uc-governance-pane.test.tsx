/**
 * UcGovernancePane (LU-5) — BEHAVIOUR contract, not DOM strings.
 *
 * Every assertion here is about what the pane SENDS to the BFF or what it
 * REFUSES to render, because those are the properties a regression would
 * actually break:
 *
 *   - a GOVERNED tag's value is a dropdown over the tenant vocabulary and
 *     NEVER a free text box (loom_no_freeform_config; the BFF re-validates, so
 *     a free box here would be a UI that invites a 400 it cannot explain);
 *   - `securableType` is derived from how deep the picker goes — it feeds the
 *     BFF's securableType allow-list, so catalog/schema/table must be exact;
 *   - "Save note" re-sends the CURRENT rung, which is what makes the model's
 *     certification-provenance rule ("re-stamp by/at only when the rung MOVES")
 *     reachable from the UI at all;
 *   - only DIRTY attributes are sent, so one editor cannot silently rewrite
 *     another's attribute values;
 *   - a Purview INFRA gate renders the shared HonestGate (G2 — inline Fix it),
 *     while a non-infra reason stays an informational bar;
 *   - a freshly picked, ungoverned securable opens CLEAN — no error banner
 *     (ux-baseline "new-item first-open is clean").
 *
 * NOTE (no-vaporware): this is unit coverage of the component contract. It is
 * NOT a browser E2E receipt and does not claim to be one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const clientFetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({ clientFetch: (...a: any[]) => clientFetchMock(...a) }));

import { UcGovernancePane } from '../uc-governance-pane';

const json = (body: unknown, status = 200) =>
  ({ status, json: async () => body }) as unknown as Response;

/** Mutable fixtures the URL router below serves. */
let vocabulary: any[];
let overlay: any;
let attributeGroups: any[];
let governancePost: any;
let governanceGetOk: { ok: boolean; error?: string };

const EMPTY_OVERLAY = {
  identity: 'uc:main.sales.orders', fullName: 'main.sales.orders',
  securableType: 'table', tenantId: 't1', tags: [], attributes: {},
};

function routeFetch(url: string, init?: RequestInit) {
  const u = String(url);
  if (u.includes('/unity-catalog/catalogs')) return json({ ok: true, catalogs: [{ name: 'main' }] });
  if (u.includes('/unity-catalog/schemas')) return json({ ok: true, schemas: [{ name: 'sales' }] });
  if (u.includes('/unity-catalog/tables')) return json({ ok: true, tables: [{ name: 'orders' }] });
  if (u.includes('/api/catalog/unity/governed-tags')) return json({ ok: true, tags: vocabulary });
  if (u.includes('/api/catalog/unity/governance')) {
    if (init?.method === 'POST') return json(governancePost);
    if (!governanceGetOk.ok) return json({ ok: false, error: governanceGetOk.error });
    return json({ ok: true, overlay, columnOverlays: [], vocabulary, attributeGroups });
  }
  return json({ ok: true });
}

/** Body of the last POST to the governance route. */
function lastGovernancePost(): any {
  const calls = clientFetchMock.mock.calls.filter(
    ([u, i]: any[]) => String(u).includes('/api/catalog/unity/governance') && i?.method === 'POST',
  );
  return calls.length ? JSON.parse(calls[calls.length - 1][1].body) : null;
}

function mount(oss = false) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <UcGovernancePane oss={oss} />
    </FluentProvider>,
  );
}

/** Drive the picker down to the requested depth. */
async function pick(user: ReturnType<typeof userEvent.setup>, depth: 'catalog' | 'schema' | 'table') {
  await user.click(screen.getByRole('combobox', { name: /catalog/i }));
  await user.click(await screen.findByRole('option', { name: 'main' }));
  if (depth === 'catalog') return;
  await user.click(screen.getByRole('combobox', { name: /^schema$/i }));
  await user.click(await screen.findByRole('option', { name: 'sales' }));
  if (depth === 'schema') return;
  await user.click(screen.getByRole('combobox', { name: /^table$/i }));
  await user.click(await screen.findByRole('option', { name: 'orders' }));
}

beforeEach(() => {
  vocabulary = [{ key: 'data-sensitivity', allowedValues: ['public', 'internal', 'restricted'] }];
  overlay = { ...EMPTY_OVERLAY };
  attributeGroups = [];
  governancePost = { ok: true };
  governanceGetOk = { ok: true };
  clientFetchMock.mockReset();
  clientFetchMock.mockImplementation(async (u: string, i?: RequestInit) => routeFetch(u, i));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('UcGovernancePane — securable picker', () => {
  it('shows the guided launcher (not a bare div) until a securable is picked', async () => {
    mount();
    expect(await screen.findByText(/pick a securable to govern/i)).toBeInTheDocument();
    // No governance read is attempted with no fullName.
    expect(clientFetchMock.mock.calls.some(([u]: any[]) =>
      String(u).includes('/api/catalog/unity/governance?'))).toBe(false);
  });

  it('surfaces a picker failure honestly instead of rendering an empty dropdown', async () => {
    clientFetchMock.mockImplementation(async (u: string) =>
      String(u).includes('/unity-catalog/catalogs')
        ? json({ ok: false, error: 'LOOM_DATABRICKS_HOSTNAMES is not set' })
        : json({ ok: true, tags: [] }));
    mount();
    expect(await screen.findByText(/LOOM_DATABRICKS_HOSTNAMES is not set/)).toBeInTheDocument();
  });

  it('derives securableType=catalog when only a catalog is picked', async () => {
    const user = userEvent.setup();
    mount();
    await pick(user, 'catalog');
    await waitFor(() => {
      const get = clientFetchMock.mock.calls.map(([u]: any[]) => String(u))
        .find((u) => u.includes('/api/catalog/unity/governance?'));
      expect(get).toContain('securableType=catalog');
      expect(get).toContain('fullName=main');
    });
  });

  it('derives securableType=table for a fully-qualified pick', async () => {
    const user = userEvent.setup();
    mount();
    await pick(user, 'table');
    await waitFor(() => {
      const gets = clientFetchMock.mock.calls.map(([u]: any[]) => String(u))
        .filter((u) => u.includes('/api/catalog/unity/governance?'));
      expect(gets.at(-1)).toContain('securableType=table');
      expect(gets.at(-1)).toContain(encodeURIComponent('main.sales.orders'));
    });
  });

  it('opens CLEAN on a securable with no overlay — no error banner', async () => {
    const user = userEvent.setup();
    mount();
    await pick(user, 'table');
    expect(await screen.findByText(/no tags on this securable yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/governance operation failed/i)).not.toBeInTheDocument();
  });
});

describe('UcGovernancePane — governed tags are never free text', () => {
  it('renders the governed value as a DROPDOWN over the vocabulary, with no free-text value box', async () => {
    const user = userEvent.setup();
    mount();
    await pick(user, 'table');

    await user.click(await screen.findByRole('combobox', { name: /tag key/i }));
    await user.click(await screen.findByRole('option', { name: 'data-sensitivity' }));

    const valueBox = await screen.findByRole('combobox', { name: /value \(governed\)/i });
    await user.click(valueBox);
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getAllByRole('option').map((o) => o.textContent))
      .toEqual(['public', 'internal', 'restricted']);
    // …and the free-text "Value" input is NOT rendered for a governed key.
    expect(screen.queryByPlaceholderText('finance')).not.toBeInTheDocument();
  });

  it('refuses to apply a governed tag until an allowed value is chosen', async () => {
    const user = userEvent.setup();
    mount();
    await pick(user, 'table');
    await user.click(await screen.findByRole('combobox', { name: /tag key/i }));
    await user.click(await screen.findByRole('option', { name: 'data-sensitivity' }));

    expect(screen.getByRole('button', { name: /apply tag/i })).toBeDisabled();

    await user.click(await screen.findByRole('combobox', { name: /value \(governed\)/i }));
    await user.click(await screen.findByRole('option', { name: 'internal' }));
    expect(screen.getByRole('button', { name: /apply tag/i })).toBeEnabled();
  });

  it('POSTs setTags with the securable identity, then clears the composer', async () => {
    const user = userEvent.setup();
    mount();
    await pick(user, 'table');
    await user.click(await screen.findByRole('combobox', { name: /tag key/i }));
    await user.click(await screen.findByRole('option', { name: 'data-sensitivity' }));
    await user.click(await screen.findByRole('combobox', { name: /value \(governed\)/i }));
    await user.click(await screen.findByRole('option', { name: 'restricted' }));
    await user.click(screen.getByRole('button', { name: /apply tag/i }));

    await waitFor(() => {
      expect(lastGovernancePost()).toEqual({
        fullName: 'main.sales.orders',
        securableType: 'table',
        setTags: [{ key: 'data-sensitivity', value: 'restricted' }],
      });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /apply tag/i })).toBeDisabled());
  });

  it('a CUSTOM (free) key may be applied with no value — governed keys may not', async () => {
    const user = userEvent.setup();
    mount();
    await pick(user, 'table');
    await user.click(await screen.findByRole('combobox', { name: /tag key/i }));
    await user.click(await screen.findByRole('option', { name: /custom key/i }));
    await user.type(await screen.findByPlaceholderText('cost-center'), 'cost-center');
    expect(screen.getByRole('button', { name: /apply tag/i })).toBeEnabled();
  });

  it('removing a tag POSTs removeTagKeys for exactly that key', async () => {
    overlay = { ...EMPTY_OVERLAY, tags: [{ key: 'data-sensitivity', value: 'public', governed: true }] };
    const user = userEvent.setup();
    mount();
    await pick(user, 'table');
    await user.click(await screen.findByRole('button', { name: /remove tag data-sensitivity/i }));
    await waitFor(() => {
      expect(lastGovernancePost()).toMatchObject({ removeTagKeys: ['data-sensitivity'] });
    });
  });

  it('surfaces the BFF refusal verbatim when a mutation is denied', async () => {
    governancePost = { ok: false, error: 'admin.security Admin is required to assign a governed tag' };
    const user = userEvent.setup();
    mount();
    await pick(user, 'table');
    await user.click(await screen.findByRole('combobox', { name: /tag key/i }));
    await user.click(await screen.findByRole('option', { name: /custom key/i }));
    await user.type(await screen.findByPlaceholderText('cost-center'), 'x');
    await user.click(screen.getByRole('button', { name: /apply tag/i }));
    expect(await screen.findByText(/admin\.security Admin is required/i)).toBeInTheDocument();
  });
});

describe('UcGovernancePane — certification', () => {
  it('"Save note" re-sends the CURRENT rung so the note edit cannot silently demote', async () => {
    overlay = {
      ...EMPTY_OVERLAY,
      certification: { rung: 'certified', note: 'old', by: 'alice@x', at: '2026-01-01T00:00:00.000Z' },
    };
    const user = userEvent.setup();
    mount();
    await pick(user, 'table');
    const note = await screen.findByPlaceholderText(/reviewed by the data office/i);
    await user.clear(note);
    await user.type(note, 'reviewed again');
    await user.click(screen.getByRole('button', { name: /save note/i }));
    await waitFor(() => {
      expect(lastGovernancePost()).toMatchObject({
        certification: { rung: 'certified', note: 'reviewed again' },
      });
    });
  });

  it('shows WHO certified and when (the provenance the model preserves)', async () => {
    overlay = {
      ...EMPTY_OVERLAY,
      certification: { rung: 'certified', note: 'n', by: 'alice@contoso.com', at: '2026-01-01T00:00:00.000Z' },
    };
    const user = userEvent.setup();
    mount();
    await pick(user, 'table');
    expect(await screen.findByText(/alice@contoso\.com/)).toBeInTheDocument();
  });

  it('moving the rung POSTs the new rung with the current note', async () => {
    const user = userEvent.setup();
    mount();
    await pick(user, 'table');
    await user.click(await screen.findByRole('combobox', { name: /status/i }));
    await user.click(await screen.findByRole('option', { name: /^promoted$/i }));
    await waitFor(() => {
      expect(lastGovernancePost()).toMatchObject({ certification: { rung: 'promoted' } });
    });
  });
});

describe('UcGovernancePane — custom attributes', () => {
  const GROUPS = [{
    id: 'g1', name: 'Stewardship', attributes: [
      { id: 'a1', name: 'Tier', fieldType: 'Single choice', choices: ['gold', 'silver'] },
      { id: 'a2', name: 'Steward', fieldType: 'Text' },
    ],
  }];

  it('offers the guided launcher (with a real link) when the tenant has no groups', async () => {
    const user = userEvent.setup();
    mount();
    await pick(user, 'table');
    expect(await screen.findByText(/no attribute groups defined for this tenant/i)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /define custom attributes/i }).length).toBeGreaterThan(0);
  });

  it('renders a Single choice as a DROPDOWN limited to its choices (never free text)', async () => {
    attributeGroups = GROUPS;
    const user = userEvent.setup();
    mount();
    await pick(user, 'table');
    await user.click(await screen.findByRole('combobox', { name: /tier/i }));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getAllByRole('option').map((o) => o.textContent)).toEqual(['gold', 'silver']);
  });

  it('Save is disabled until a value actually changes, and sends ONLY the dirty ids', async () => {
    attributeGroups = GROUPS;
    overlay = { ...EMPTY_OVERLAY, attributes: { a1: 'gold', a2: 'bob' } };
    const user = userEvent.setup();
    mount();
    await pick(user, 'table');

    const save = await screen.findByRole('button', { name: /save attributes/i });
    expect(save).toBeDisabled();

    await user.click(await screen.findByRole('combobox', { name: /tier/i }));
    await user.click(await screen.findByRole('option', { name: 'silver' }));
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);

    await waitFor(() => {
      const body = lastGovernancePost();
      expect(body.attributes).toEqual({ a1: 'silver' }); // a2 untouched -> NOT sent
    });
  });
});

describe('UcGovernancePane — Purview fold-in (G2)', () => {
  it('an INFRA gate renders the shared HonestGate with an inline Fix it', async () => {
    governancePost = {
      ok: true,
      purview: {
        synced: false,
        reason: 'Microsoft Purview is not provisioned: set LOOM_PURVIEW_ACCOUNT.',
        classifications: [], businessMetadataKeys: [],
      },
    };
    const user = userEvent.setup();
    mount();
    await pick(user, 'table');
    await user.click(await screen.findByRole('button', { name: /sync to purview/i }));
    expect(await screen.findByRole('button', { name: /fix it/i })).toBeInTheDocument();
  });

  it('a NON-infra reason stays an informational bar — no Fix it wizard offered', async () => {
    governancePost = {
      ok: true,
      purview: {
        synced: false,
        reason: 'No Purview asset is registered for main.sales.orders. Register it first.',
        classifications: [], businessMetadataKeys: [],
      },
    };
    const user = userEvent.setup();
    mount();
    await pick(user, 'table');
    await user.click(await screen.findByRole('button', { name: /sync to purview/i }));
    expect(await screen.findByText(/no purview asset is registered/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /fix it/i })).not.toBeInTheDocument();
  });

  it('reports what was actually written on a successful sync', async () => {
    governancePost = {
      ok: true,
      purview: {
        synced: true, guid: 'g1',
        classifications: ['Loom_deadbeef_data_sensitivity_public'],
        businessMetadataKeys: ['loom_certification'],
      },
    };
    const user = userEvent.setup();
    mount();
    await pick(user, 'table');
    await user.click(await screen.findByRole('button', { name: /sync to purview/i }));
    expect(await screen.findByText(/Loom_deadbeef_data_sensitivity_public/)).toBeInTheDocument();
    expect(screen.getByText(/loom_certification/)).toBeInTheDocument();
  });

  it('the sync POST carries syncPurview:true and the securable identity', async () => {
    const user = userEvent.setup();
    mount();
    await pick(user, 'table');
    await user.click(await screen.findByRole('button', { name: /sync to purview/i }));
    await waitFor(() => {
      expect(lastGovernancePost()).toEqual({
        fullName: 'main.sales.orders', securableType: 'table', syncPurview: true,
      });
    });
  });
});

describe('UcGovernancePane — tenant vocabulary editor', () => {
  it('POSTs the FULL next vocabulary (the route replaces the doc, not appends)', async () => {
    const user = userEvent.setup();
    mount();
    await user.type(await screen.findByPlaceholderText('data-sensitivity'), 'pii');
    await user.type(screen.getByPlaceholderText('public, internal, restricted'), 'yes, no');
    await user.click(screen.getByRole('button', { name: /add governed tag/i }));

    await waitFor(() => {
      const post = clientFetchMock.mock.calls.filter(
        ([u, i]: any[]) => String(u).includes('/governed-tags') && i?.method === 'POST',
      ).at(-1);
      expect(JSON.parse(post![1].body)).toEqual({
        tags: [
          { key: 'data-sensitivity', allowedValues: ['public', 'internal', 'restricted'] },
          { key: 'pii', allowedValues: ['yes', 'no'] },
        ],
      });
    });
  });

  it('re-adding an existing key REPLACES it rather than duplicating', async () => {
    const user = userEvent.setup();
    mount();
    await user.type(await screen.findByPlaceholderText('data-sensitivity'), 'data-sensitivity');
    await user.type(screen.getByPlaceholderText('public, internal, restricted'), 'open, closed');
    await user.click(screen.getByRole('button', { name: /add governed tag/i }));
    await waitFor(() => {
      const post = clientFetchMock.mock.calls.filter(
        ([u, i]: any[]) => String(u).includes('/governed-tags') && i?.method === 'POST',
      ).at(-1);
      expect(JSON.parse(post![1].body).tags).toEqual([
        { key: 'data-sensitivity', allowedValues: ['open', 'closed'] },
      ]);
    });
  });

  it("surfaces a non-admin's 403 verbatim instead of hiding the editor", async () => {
    clientFetchMock.mockImplementation(async (u: string, i?: RequestInit) => {
      if (String(u).includes('/governed-tags') && i?.method === 'POST') {
        return json({ ok: false, error: 'forbidden — tenant admins change the governed-tag vocabulary' });
      }
      return routeFetch(u, i);
    });
    const user = userEvent.setup();
    mount();
    await user.type(await screen.findByPlaceholderText('data-sensitivity'), 'pii');
    await user.type(screen.getByPlaceholderText('public, internal, restricted'), 'yes');
    await user.click(screen.getByRole('button', { name: /add governed tag/i }));
    expect(await screen.findByText(/tenant admins change the governed-tag vocabulary/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add governed tag/i })).toBeInTheDocument();
  });

  it('deleting a governed tag POSTs the vocabulary WITHOUT that key', async () => {
    vocabulary = [
      { key: 'data-sensitivity', allowedValues: ['public'] },
      { key: 'pii', allowedValues: ['yes', 'no'] },
    ];
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /delete governed tag pii/i }));
    await waitFor(() => {
      const post = clientFetchMock.mock.calls.filter(
        ([u, i]: any[]) => String(u).includes('/governed-tags') && i?.method === 'POST',
      ).at(-1);
      expect(JSON.parse(post![1].body).tags).toEqual([
        { key: 'data-sensitivity', allowedValues: ['public'] },
      ]);
    });
  });
});

describe('UcGovernancePane — backend-neutral prose (no-fabric-dependency)', () => {
  it('names the OSS Unity Catalog server on the OSS backend', async () => {
    mount(true);
    expect(await screen.findByText(/OSS Unity Catalog server/i)).toBeInTheDocument();
  });

  it('names Databricks Unity Catalog on the Databricks backend', async () => {
    mount(false);
    expect(await screen.findByText(/Databricks Unity Catalog/i)).toBeInTheDocument();
  });
});
