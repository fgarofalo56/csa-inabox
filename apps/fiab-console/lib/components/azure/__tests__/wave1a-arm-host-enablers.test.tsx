/**
 * Wave 1A — the ARM/HOST adoption's own enablers.
 *
 * Wave 0 proved the picker keeps an unresolvable stored value, stays usable on
 * a failed discovery, and carries a Fix-it. This wave adopted it 22 times, and
 * every one of those adoptions inherits those properties THROUGH two things:
 * the field-kind table (which decides the ARM query and what is stored) and
 * PrivateLinkTargetField (the one adoption that needed a new control). Those
 * are what is pinned here.
 *
 * The ARM-ID kinds exist because the loader table stores what a GATE needs —
 * a name or an endpoint — while roughly a third of the hand-typed sites want
 * the resource's full ARM id. Handing an Event Hubs namespace NAME to a Geo-DR
 * API that wants `/subscriptions/…/namespaces/<n>` fails at ARM, not in the UI,
 * so the distinction is load-bearing and is asserted rather than assumed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const fetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({ clientFetch: (...a: any[]) => fetchMock(...a) }));

import { L } from '@/lib/gates/registry/types';
import { AZURE_BACKED_FIELDS, AzureBackedField, UNSERVED_LOADERS } from '../azure-backed-field';
import {
  PrivateLinkTargetField, PRIVATE_LINK_TARGET_TYPES, typeFromArmId, groupIdsForType,
  initialGroupIdsFor,
} from '../private-link-target-field';

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}
function jsonRes(body: unknown, status = 200) {
  return { status, json: async () => body } as any;
}

/** A saved target in a subscription the current caller has no RBAC on. */
const HIDDEN_ID =
  '/subscriptions/other-sub/resourceGroups/rg-locked/providers/Microsoft.KeyVault/vaults/kv-hidden';

const VAULT = {
  id: '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/kv-1',
  name: 'kv-1',
  type: 'microsoft.keyvault/vaults',
  location: 'eastus2',
  resourceGroup: 'rg',
  subscriptionId: 's1',
};

afterEach(cleanup);
// NOT `beforeEach(() => fetchMock.mockReset())` — mockReset RETURNS the mock and
// vitest would treat that return value as a cleanup function.
beforeEach(() => { fetchMock.mockReset(); });

describe('the ARM-id field kinds Wave 1A added', () => {
  it('stores the ARM ID, not the name, for every id-shaped kind', () => {
    for (const kind of ['logic-app', 'private-dns-zone', 'storage-account-id', 'eventhubs-namespace-id', 'adx-cluster-id']) {
      expect(AZURE_BACKED_FIELDS[kind], kind).toBeDefined();
      expect(AZURE_BACKED_FIELDS[kind].valueFrom, kind).toBe('id');
    }
  });

  it('names the ARM type each id-shaped kind queries', () => {
    expect(AZURE_BACKED_FIELDS['logic-app'].sources[0].type).toBe('Microsoft.Logic/workflows');
    expect(AZURE_BACKED_FIELDS['private-dns-zone'].sources[0].type).toBe('Microsoft.Network/privateDnsZones');
    expect(AZURE_BACKED_FIELDS['storage-account-id'].sources[0].type).toBe('Microsoft.Storage/storageAccounts');
    expect(AZURE_BACKED_FIELDS['eventhubs-namespace-id'].sources[0].type).toBe('Microsoft.EventHub/namespaces');
    expect(AZURE_BACKED_FIELDS['adx-cluster-id'].sources[0].type).toBe('Microsoft.Kusto/clusters');
  });

  it('does NOT collide with the name/endpoint loader of the same ARM type', () => {
    // The pair that motivated the split: `eventhubs` is what a GATE stores (a
    // name); the Geo-DR pairing needs the id. Same ARM type, different value.
    expect(AZURE_BACKED_FIELDS.eventhubs.valueFrom).toBe('name');
    expect(AZURE_BACKED_FIELDS['eventhubs-namespace-id'].valueFrom).toBe('id');
    expect(AZURE_BACKED_FIELDS.adxUri.valueFrom).toBe('properties.uri');
    expect(AZURE_BACKED_FIELDS['adx-cluster-id'].valueFrom).toBe('id');
  });

  it('projects the cluster URI ALONGSIDE the ARM id, so one pick fills both leader fields', async () => {
    // The ADX follower wizard asked for the leader's ARM id AND its URI as two
    // separate typed boxes. `select` costs nothing extra — it is a column in
    // the same ARG query — so the URI rides back on the selection.
    expect(AZURE_BACKED_FIELDS['adx-cluster-id'].sources[0].select).toBe('properties.uri');

    const onChange = vi.fn();
    const cluster = {
      id: '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Kusto/clusters/adx-1',
      name: 'adx-1', type: 'microsoft.kusto/clusters', location: 'eastus2',
      resourceGroup: 'rg', subscriptionId: 's1', value: 'https://adx-1.eastus2.kusto.windows.net',
    };
    fetchMock.mockResolvedValue(jsonRes({ ok: true, via: 'user', resources: [cluster], select: 'properties.uri' }));
    wrap(<AzureBackedField kind="adx-cluster-id" onChange={onChange} />);

    await waitFor(() => expect(screen.getByText(/1 resource/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: /adx-1/ }));
    expect(onChange).toHaveBeenCalledWith(
      cluster.id,
      expect.objectContaining({ value: 'https://adx-1.eastus2.kusto.windows.net' }),
    );
  });

  it('the derived-endpoint kinds project the property the surface actually stores', () => {
    expect(AZURE_BACKED_FIELDS['eventgrid-topic-endpoint'].sources[0]).toMatchObject({
      type: 'Microsoft.EventGrid/topics', select: 'properties.endpoint',
    });
    expect(AZURE_BACKED_FIELDS['storage-dfs-endpoint'].sources[0]).toMatchObject({
      type: 'Microsoft.Storage/storageAccounts', select: 'properties.primaryEndpoints.dfs',
    });
  });

  it('sql-host queries Azure SQL AND Synapse, so a Synapse-only estate is not empty', () => {
    const types = AZURE_BACKED_FIELDS['sql-host'].sources.map((s) => s.type);
    expect(types).toEqual(['Microsoft.Sql/servers', 'Microsoft.Synapse/workspaces']);
    // One source per ARM TYPE: the picker keys options on the resource id, so a
    // second Synapse source (the dedicated endpoint) would emit a duplicate key.
    expect(new Set(types).size).toBe(types.length);
  });

  it('issues ONE request per source — never one per resource', async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: true, via: 'user', resources: [VAULT, { ...VAULT, id: `${VAULT.id}-2`, name: 'kv-2' }] }));
    wrap(<AzureBackedField kind="storage-account-id" onChange={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/2 resources/i)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('adds no Fabric or Power BI source', () => {
    const all = JSON.stringify(AZURE_BACKED_FIELDS).toLowerCase();
    expect(all).not.toContain('fabric');
    expect(all).not.toContain('powerbi');
  });

  /**
   * THE DRIFT THIS WAVE INTRODUCED, and the assertion that closes it.
   *
   * Wave 0's control runs one way: every loader in `L` must be a field kind or
   * be named in UNSERVED_LOADERS. It says nothing about a kind that is NOT a
   * loader — which is what the eight kinds added here are. So the reverse
   * drift is open: if the registry later grows a `privateDnsZone` or
   * `eventgridTopic` loader, there would be TWO definitions of the same ARM
   * query and no test would object, which is how the 250 accumulated.
   *
   * The rule is a KEY rule, not a type rule: an id-shaped kind deliberately
   * shares an ARM type with a name/endpoint loader (that is the whole point of
   * `eventhubs-namespace-id` next to `eventhubs`). What must never collide is
   * the KEY, and a non-loader kind must not silently become the second answer
   * to a loader key.
   */
  it('no added kind shadows a registry loader key, in either direction', () => {
    const loaderKeys = new Set(Object.keys(L));
    const added = [
      'logic-app', 'private-dns-zone', 'storage-account-id',
      'eventhubs-namespace-id', 'adx-cluster-id',
      'eventgrid-topic-endpoint', 'storage-dfs-endpoint', 'sql-host',
    ];
    // The control has a population, and it is the one the commit describes.
    expect(added.every((k) => k in AZURE_BACKED_FIELDS)).toBe(true);
    for (const k of added) {
      expect(loaderKeys.has(k), `${k} now collides with a registry loader key`).toBe(false);
      expect(UNSERVED_LOADERS[k], `${k} is a served kind and must not also be declared unserved`).toBeUndefined();
    }
    // And Wave 0's forward control still holds on the extended table.
    expect(Object.keys(L).filter((k) => !(k in AZURE_BACKED_FIELDS) && !(k in UNSERVED_LOADERS))).toEqual([]);
  });
});

describe('PrivateLinkTargetField — type, then resource, then sub-resource', () => {
  it('seeds the type dropdown FROM the stored id, so a saved endpoint reopens on its own list', async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: true, via: 'user', resources: [] }));
    wrap(<PrivateLinkTargetField value={HIDDEN_ID} onChange={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Not the default (storage) — the type carried by the saved value.
    expect(String(fetchMock.mock.calls[0][0])).toContain('type=Microsoft.KeyVault%2Fvaults');
  });

  it('PRESERVES a stored id the caller cannot resolve, and still saves it', async () => {
    // The round trip that Wave 0 defect 1 broke: open an existing endpoint whose
    // target lives in a subscription this identity has no RBAC on, change
    // nothing, save. The old build rendered an EMPTY box and wrote the blank
    // back over a working binding.
    const onChange = vi.fn();
    fetchMock.mockResolvedValue(jsonRes({ ok: true, via: 'user', resources: [] }));
    wrap(<PrivateLinkTargetField value={HIDDEN_ID} onChange={onChange} />);

    await waitFor(() => {
      const box = screen.getAllByRole('combobox').find((c) => (c as HTMLInputElement).value.includes('kv-hidden'));
      expect(box).toBeDefined();
    });
    expect(screen.getByText(/saved value — not visible to you/i)).toBeInTheDocument();
    // Nothing was touched, so nothing was written back — the stored id survives.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('stays USABLE when discovery returns nothing at all', async () => {
    // The Gov shape: a UAMI without tenant-root Reader. `auto-bind-by-default`
    // forbids "no results + a disabled control", so the escape hatch must be
    // reachable and the type dropdown must still work.
    fetchMock.mockResolvedValue(jsonRes({ ok: false, code: 'no_access', error: 'UAMI lacks Reader at tenant root.' }));
    wrap(<PrivateLinkTargetField onChange={() => {}} />);

    const manual = await screen.findByLabelText('Target resource ID');
    expect((manual as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: /fix it/i })).toBeInTheDocument();
  });

  it('hands back the ARM id AND the sub-resources Azure accepts for its type', async () => {
    const onChange = vi.fn();
    fetchMock.mockResolvedValue(jsonRes({ ok: true, via: 'user', resources: [VAULT] }));
    wrap(<PrivateLinkTargetField value="" onChange={onChange} />);

    // Move to Key Vault, then pick the vault the caller can see.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const typeBox = screen.getAllByRole('combobox')[0];
    fireEvent.click(typeBox);
    fireEvent.click(await screen.findByRole('option', { name: 'Key Vault' }));

    await waitFor(() => expect(screen.getByText(/1 resource/i)).toBeInTheDocument());
    const resourceBox = screen.getAllByRole('combobox')[1];
    fireEvent.click(resourceBox);
    fireEvent.click(await screen.findByRole('option', { name: /kv-1/ }));

    expect(onChange).toHaveBeenLastCalledWith(VAULT.id, ['vault'], expect.objectContaining({ id: VAULT.id }));
  });

  it('CLEARS the selection when the type changes, so a mismatched pair is never submitted', async () => {
    const onChange = vi.fn();
    fetchMock.mockResolvedValue(jsonRes({ ok: true, via: 'user', resources: [] }));
    wrap(<PrivateLinkTargetField value={HIDDEN_ID} onChange={onChange} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole('combobox')[0]);
    fireEvent.click(await screen.findByRole('option', { name: /Event Hubs namespace/ }));
    expect(onChange).toHaveBeenLastCalledWith(null, ['namespace'], null);
  });

  it('re-queries on a type change — one request per type, never one per resource', async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: true, via: 'user', resources: [VAULT] }));
    wrap(<PrivateLinkTargetField onChange={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getAllByRole('combobox')[0]);
    fireEvent.click(await screen.findByRole('option', { name: 'Key Vault' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][0])).toContain('type=Microsoft.KeyVault%2Fvaults');
  });
});

describe('private-link helpers', () => {
  it('reads the ARM type out of an id', () => {
    expect(typeFromArmId(HIDDEN_ID)).toBe('Microsoft.KeyVault/vaults');
    expect(typeFromArmId('')).toBeNull();
    expect(typeFromArmId(undefined)).toBeNull();
    // An id for a type this table does not list is REPORTED, not silently
    // mapped onto storage — the caller then knows the list will be empty.
    expect(typeFromArmId('/subscriptions/s/resourceGroups/r/providers/Contoso.Widgets/things/t/x'))
      .toBe('Contoso.Widgets/things');
  });

  it('derives the sub-resources for a type instead of asking for them', () => {
    expect(groupIdsForType('Microsoft.Storage/storageAccounts')).toContain('dfs');
    expect(groupIdsForType('Microsoft.KeyVault/vaults')).toEqual(['vault']);
    expect(groupIdsForType('microsoft.sql/servers')).toEqual(['sqlServer']);
    expect(groupIdsForType(null)).toEqual([]);
  });

  it('every listed type carries at least one groupId — an empty one is a dead dropdown', () => {
    expect(PRIVATE_LINK_TARGET_TYPES.length).toBeGreaterThanOrEqual(15);
    for (const t of PRIVATE_LINK_TARGET_TYPES) {
      expect(t.groupIds.length, t.type).toBeGreaterThan(0);
      expect(t.type, t.type).toMatch(/^Microsoft\.[A-Za-z]+\/[A-Za-z]+$/);
    }
  });

  it('seeds a caller\'s sub-resource dropdown for the type the field OPENS on, never with []', () => {
    // Three callers pair this field with their own groupId dropdown. Seeding
    // that dropdown from the stored value alone leaves it EMPTY on a new item,
    // which reads as "this resource has no sub-resources" — so the seed follows
    // the field's own opening type instead, and the caller never names an ARM
    // type to get it.
    expect(initialGroupIdsFor()).toEqual(groupIdsForType(PRIVATE_LINK_TARGET_TYPES[0].type));
    expect(initialGroupIdsFor()).not.toEqual([]);
    expect(initialGroupIdsFor(HIDDEN_ID)).toEqual(['vault']);
  });
});
