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

  it('sql-host queries Azure SQL AND both Synapse endpoints, so no estate is empty and no pool is mis-targeted', () => {
    const srcs = AZURE_BACKED_FIELDS['sql-host'].sources;
    expect(srcs.map((s) => s.type)).toEqual([
      'Microsoft.Sql/servers', 'Microsoft.Synapse/workspaces', 'Microsoft.Synapse/workspaces',
    ]);
    // The dedicated endpoint was DROPPED in the first cut, so picking a Synapse
    // workspace and typing a dedicated pool name produced `ws-ondemand…` +
    // `pool01` and failed at TDS. Both endpoints are now offered, distinctly.
    expect(srcs.map((s) => s.select)).toEqual([
      'properties.fullyQualifiedDomainName',
      'properties.connectivityEndpoints.sqlOnDemand',
      'properties.connectivityEndpoints.sql',
    ]);
    // Distinctly LABELLED, or the two Synapse rows are indistinguishable.
    expect(new Set(srcs.map((s) => s.label)).size).toBe(3);
  });

  it('renders both Synapse endpoints as separate options rather than collapsing them', async () => {
    // Same workspace, two sources — the case that produced duplicate React keys
    // and filed both rows under the first source's label.
    const ws = {
      id: '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Synapse/workspaces/ws',
      name: 'ws', type: 'microsoft.synapse/workspaces',
      location: 'eastus2', resourceGroup: 'rg', subscriptionId: 's1',
    };
    fetchMock.mockImplementation((url: any) => {
      const u = String(url);
      if (u.includes('Microsoft.Sql%2Fservers')) return Promise.resolve(jsonRes({ ok: true, via: 'user', resources: [] }));
      if (u.includes('sqlOnDemand')) return Promise.resolve(jsonRes({ ok: true, via: 'user', resources: [{ ...ws, value: 'ws-ondemand.sql.azuresynapse.net' }] }));
      return Promise.resolve(jsonRes({ ok: true, via: 'user', resources: [{ ...ws, value: 'ws.sql.azuresynapse.net' }] }));
    });

    const onChange = vi.fn();
    wrap(<AzureBackedField kind="sql-host" onChange={onChange} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByText(/2 resources across 2 sources/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('combobox'));
    // Both endpoints are selectable, and the DEDICATED one yields its own value.
    expect(await screen.findByRole('group', { name: /Synapse serverless SQL endpoint/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /Synapse dedicated SQL pool endpoint/i })).toBeInTheDocument();

    const opts = screen.getAllByRole('option');
    const dedicated = opts.find((o) => o.textContent?.includes('ws')) && opts.length >= 2;
    expect(dedicated).toBe(true);
  });

  it('issues ONE request per source — never one per resource', async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: true, via: 'user', resources: [VAULT, { ...VAULT, id: `${VAULT.id}-2`, name: 'kv-2' }] }));
    wrap(<AzureBackedField kind="storage-account-id" onChange={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/2 resources/i)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * The LIST case, which the "one request per source" test above does not
   * cover: `cosmos-account-editor` renders one subnet picker per VNet rule, so
   * ten rules mounted ten concurrent multi-page ARG walks for an identical
   * query. Concurrent identical requests are now coalesced in flight.
   */
  it('collapses N concurrently-mounted pickers of the same query into ONE request', async () => {
    let resolveIt: (v: unknown) => void = () => {};
    const pending = new Promise((r) => { resolveIt = r; });
    fetchMock.mockReturnValue(pending);

    wrap(
      <>
        {Array.from({ length: 10 }, (_, i) => (
          <AzureBackedField key={i} kind="subnet" onChange={() => {}} />
        ))}
      </>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveIt(jsonRes({ ok: true, via: 'user', resources: [] }));
    await waitFor(() => expect(screen.getAllByText(/0 resources/i).length).toBe(10));
  });

  it('coalescing is IN-FLIGHT only — a later mount still issues a real request', async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: true, via: 'user', resources: [] }));
    const first = wrap(<AzureBackedField kind="subnet" onChange={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    first.unmount();

    // Settled, so the entry is evicted — this is not a cache and cannot serve
    // a stale answer.
    wrap(<AzureBackedField kind="subnet" onChange={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('adds no Fabric or Power BI source', () => {
    const all = JSON.stringify(AZURE_BACKED_FIELDS).toLowerCase();
    expect(all).not.toContain('fabric');
    expect(all).not.toContain('powerbi');
  });

  /**
   * THE DRIFT THIS WAVE INTRODUCED, and the assertion that actually closes it.
   *
   * Wave 0's control runs one way: every loader in `L` must be a field kind or
   * be named in UNSERVED_LOADERS. It says nothing about a kind that is NOT a
   * loader — which is what the eight kinds added here are. The hazard is a
   * SECOND DEFINITION OF THE SAME ARM QUERY appearing under a different key.
   *
   * ── WHY THE FIRST VERSION OF THIS TEST WAS THEATRE (review, 2026-08-16) ──
   * It asserted that no added KEY equals a loader KEY. That cannot fail for the
   * drift it names: registry keys are camelCase and these kinds are kebab-case,
   * so `privateDnsZone` vs `private-dns-zone` sails through in both directions.
   * It fired only on an exact string collision — the single shape its own
   * mutation receipt tested. And the duplicate it claimed to prevent was
   * ALREADY PRESENT: `sql-host.sources[0]` is the same (type, kind, select,
   * valueFrom) tuple `fromLoader` builds for `L.sqlServer`.
   *
   * So the control is now over the QUERY TUPLE, with a closed allow-list for
   * the overlaps that are deliberate. Exact equality, not a subset check: a new
   * duplicate fails, and so does REMOVING one without updating the list, which
   * keeps the list from rotting into a rubber stamp.
   */
  it('no two field kinds define the same ARM query, except the declared composites', () => {
    const NORMALIZE = (k: string) => k.toLowerCase().replace(/[-_]/g, '');

    // 1. KEY drift, case- and separator-insensitive — the shape the previous
    //    version could not see.
    const byNorm = new Map<string, string[]>();
    for (const k of [...Object.keys(L), ...Object.keys(AZURE_BACKED_FIELDS)]) {
      const n = NORMALIZE(k);
      if (!byNorm.has(n)) byNorm.set(n, []);
      if (!byNorm.get(n)!.includes(k)) byNorm.get(n)!.push(k);
    }
    const keyClashes = [...byNorm.values()].filter((ks) => ks.length > 1);
    expect(keyClashes, 'two keys differ only by case/separator — one is shadowing the other').toEqual([]);

    // 2. QUERY drift — the same (type|kind|select|valueFrom) under two kinds.
    const tuples = new Map<string, string[]>();
    for (const [kind, def] of Object.entries(AZURE_BACKED_FIELDS)) {
      for (const src of def.sources) {
        const t = `${src.type}|${src.kind ?? ''}|${src.select ?? ''}|${def.valueFrom}`;
        if (!tuples.has(t)) tuples.set(t, []);
        tuples.get(t)!.push(kind);
      }
    }
    const dupes = [...tuples.entries()]
      .filter(([, kinds]) => kinds.length > 1)
      .map(([t, kinds]) => `${kinds.sort().join(' + ')} :: ${t}`)
      .sort();

    // The overlaps that are intentional, each with the reason it exists.
    const DECLARED = [
      // A cloud-parity composite: the Databricks workspace URL is both its own
      // kind and the Commercial half of `catalog-endpoint`.
      'catalog-endpoint + databricks :: Microsoft.Databricks/workspaces||properties.workspaceUrl|properties.workspaceUrl',
      // `sql-host` is the multi-backend composite; its Azure SQL leg is by
      // construction the same query as the `sqlServer` loader.
      'sql-host + sqlServer :: Microsoft.Sql/servers||properties.fullyQualifiedDomainName|properties.fullyQualifiedDomainName',
    ].sort();
    expect(dupes).toEqual(DECLARED);

    // 3. The control has a population — the assertions above are not vacuous.
    expect(tuples.size).toBeGreaterThan(25);
    expect(byNorm.size).toBeGreaterThan(30);

    // 4. Wave 0's forward control still holds on the extended table.
    expect(Object.keys(L).filter((k) => !(k in AZURE_BACKED_FIELDS) && !(k in UNSERVED_LOADERS))).toEqual([]);
    for (const k of Object.keys(AZURE_BACKED_FIELDS)) {
      expect(UNSERVED_LOADERS[k], `${k} is served and must not also be declared unserved`).toBeUndefined();
    }
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

  /**
   * BLOCKER 1 (review, 2026-08-16). The manual-entry path derived its groupIds
   * from the type DROPDOWN rather than from the id the user typed, because
   * `commitManual` builds a selection with no `type` key. The result was a pair
   * ARM rejects, and — since the caller's sub-resource dropdown offers only
   * these groupIds — one the user could no longer correct. Strictly worse than
   * the free-text box this wave removed.
   */
  it('derives groupIds from a HAND-TYPED id, not from the type dropdown', async () => {
    const onChange = vi.fn();
    fetchMock.mockResolvedValue(jsonRes({ ok: false, code: 'no_access', error: 'no access' }));
    // Dropdown is on its default (Storage account); discovery is denied.
    wrap(<PrivateLinkTargetField onChange={onChange} />);

    const manual = await screen.findByLabelText('Target resource ID');
    fireEvent.change(manual, { target: { value: HIDDEN_ID } });   // a Key Vault id
    fireEvent.click(screen.getByRole('button', { name: /use this value/i }));

    // ['vault'], not the storage set. Before the fix this was
    // ['dfs','blob','file','queue','table','web'] and the POST carried 'blob'.
    expect(onChange).toHaveBeenLastCalledWith(HIDDEN_ID, ['vault'], expect.objectContaining({ id: HIDDEN_ID }));
    expect(onChange.mock.calls.at(-1)![1]).not.toContain('blob');
  });

  it('moves the type dropdown to match a hand-typed id, so the widget stops asserting a type the value contradicts', async () => {
    const onChange = vi.fn();
    fetchMock.mockResolvedValue(jsonRes({ ok: false, code: 'no_access', error: 'no access' }));
    wrap(<PrivateLinkTargetField onChange={onChange} />);

    const manual = await screen.findByLabelText('Target resource ID');
    fireEvent.change(manual, { target: { value: HIDDEN_ID } });
    fireEvent.click(screen.getByRole('button', { name: /use this value/i }));

    await waitFor(() => {
      const typeBox = screen.getAllByRole('combobox')[0] as HTMLInputElement;
      expect(typeBox.value).toBe('Key Vault');
    });
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
    // Arity is not validity — see the two assertions below, which are about
    // whether a listed PAIR is one ARM actually accepts.
  });

  /**
   * BLOCKER 2 (review, 2026-08-16). `Microsoft.OperationalInsights/workspaces`
   * + `azuremonitor` was listed and is a guaranteed ARM rejection: a Log
   * Analytics workspace is not a private-endpoint target. Azure Monitor
   * private link terminates on an Azure Monitor Private Link Scope. Because
   * AMPLS was ALSO missing, the correct target was unreachable — so this pins
   * both halves of the correction, not just the removal.
   */
  it('does not offer a Log Analytics workspace as a private-endpoint target', () => {
    const types = PRIVATE_LINK_TARGET_TYPES.map((t) => t.type.toLowerCase());
    expect(types).not.toContain('microsoft.operationalinsights/workspaces');
    // And the real Azure Monitor target IS reachable.
    expect(groupIdsForType('Microsoft.Insights/privateLinkScopes')).toEqual(['azuremonitor']);
  });

  /**
   * Grounding, not memory: every pair Loom's own bicep has had ARM accept.
   * Grepping `groupIds` with context across the bicep tree is the source. A row
   * that drifts from what we deploy is a row a customer will fail on.
   */
  it('matches the (type, groupId) pairs this repo\'s bicep actually deploys', () => {
    const DEPLOYED: Array<[string, string]> = [
      ['Microsoft.KeyVault/vaults', 'vault'],
      ['Microsoft.Storage/storageAccounts', 'blob'],
      ['Microsoft.Storage/storageAccounts', 'dfs'],
      ['Microsoft.Storage/storageAccounts', 'file'],
      ['Microsoft.ContainerRegistry/registries', 'registry'],
      ['Microsoft.Search/searchServices', 'searchService'],
      ['Microsoft.Purview/accounts', 'account'],
      ['Microsoft.Purview/accounts', 'portal'],
      ['Microsoft.CognitiveServices/accounts', 'account'],
      ['Microsoft.MachineLearningServices/workspaces', 'amlworkspace'],
      ['Microsoft.DataFactory/factories', 'dataFactory'],
      ['Microsoft.EventHub/namespaces', 'namespace'],
      ['Microsoft.ServiceBus/namespaces', 'namespace'],
      ['Microsoft.EventGrid/topics', 'topic'],
      ['Microsoft.DocumentDB/databaseAccounts', 'Sql'],
      ['Microsoft.DocumentDB/databaseAccounts', 'Gremlin'],
      ['Microsoft.Synapse/workspaces', 'Sql'],
      ['Microsoft.Synapse/workspaces', 'SqlOnDemand'],
      ['Microsoft.Synapse/workspaces', 'Dev'],
      ['Microsoft.DBforPostgreSQL/flexibleServers', 'postgresqlServer'],
      ['Microsoft.Databricks/workspaces', 'databricks_ui_api'],
      ['Microsoft.Cache/Redis', 'redisCache'],
    ];
    const missing = DEPLOYED.filter(([t, g]) => !groupIdsForType(t).includes(g))
      .map(([t, g]) => `${t} :: ${g}`);
    expect(missing).toEqual([]);
    expect(DEPLOYED.length).toBeGreaterThan(20);
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
