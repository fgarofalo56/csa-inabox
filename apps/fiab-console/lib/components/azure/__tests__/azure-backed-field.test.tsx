/**
 * AzureBackedField — the adoption-gap control.
 *
 * The premise of this component is that the mapping from "value a surface
 * needs" to "ARM query that produces it" ALREADY EXISTED, as the 28 loaders in
 * lib/gates/registry/types.ts `L`, and that only the admin gate dialog consumed
 * it. The first test below is the control that stops that gap from reopening:
 * every non-`special` loader MUST be reachable as a field kind, so a 29th
 * loader added to the registry either becomes a picker or is named in
 * UNSERVED_LOADERS with a reason. A component that merely re-listed the loaders
 * by hand would drift the day someone adds one, and the drift would be silent —
 * which is exactly how the 250 hand-typed inputs accumulated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const fetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({ clientFetch: (...a: any[]) => fetchMock(...a) }));

import { L } from '@/lib/gates/registry/types';
import {
  AzureBackedField, AZURE_BACKED_FIELDS, UNSERVED_LOADERS, valueOfSelection,
} from '../azure-backed-field';

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}
function jsonRes(body: unknown, status = 200) {
  return { status, json: async () => body } as any;
}

afterEach(cleanup);
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonRes({ ok: true, resources: [], via: 'user' }));
});

describe('the loader table is CONSUMED, not re-listed', () => {
  it('every registry loader is reachable as a field kind (or declared unserved with a reason)', () => {
    // `Object.hasOwn`, not `k in X`: `in` walks Object.prototype, so a loader
    // named `toString` or `constructor` would report as SERVED by a method it
    // inherited — the control would pass while the field was missing.
    const missing = Object.keys(L).filter(
      (k) => !Object.hasOwn(AZURE_BACKED_FIELDS, k) && !Object.hasOwn(UNSERVED_LOADERS, k),
    );
    expect(missing).toEqual([]);
    // And the count is not accidentally zero — the control has a population.
    expect(Object.keys(L).length).toBeGreaterThanOrEqual(28);
  });

  it('an inherited Object.prototype key is NOT mistaken for a served field kind', () => {
    // The control for the control: prove the lookup does not walk the prototype.
    expect(Object.hasOwn(AZURE_BACKED_FIELDS, 'toString')).toBe(false);
    expect(Object.hasOwn(UNSERVED_LOADERS, 'toString')).toBe(false);
  });

  it('a loader that Resource Graph cannot express is DECLARED, not silently dropped', () => {
    // aoai-deployments is an accounts → per-account-deployments walk; ARG has no
    // shape for it, so it stays on the gate-options route and says so.
    expect(UNSERVED_LOADERS.aoaiDeployment).toMatch(/child of a Cognitive Services account/i);
    expect(AZURE_BACKED_FIELDS.aoaiDeployment).toBeUndefined();
  });

  it('carries each loader\'s armType, kind filter and properties path through unchanged', () => {
    expect(AZURE_BACKED_FIELDS.adxUri.sources[0]).toMatchObject({
      type: L.adxUri.armType, select: 'properties.uri',
    });
    expect(AZURE_BACKED_FIELDS.databricks.sources[0]).toMatchObject({
      type: 'Microsoft.Databricks/workspaces', select: 'properties.workspaceUrl',
    });
    expect(AZURE_BACKED_FIELDS.keyvault.sources[0]).toMatchObject({ select: 'properties.vaultUri' });
    expect(AZURE_BACKED_FIELDS.sqlServer.sources[0]).toMatchObject({ select: 'properties.fullyQualifiedDomainName' });
    expect(AZURE_BACKED_FIELDS.aas.sources[0]).toMatchObject({ select: 'properties.serverFullName' });
    expect(AZURE_BACKED_FIELDS.cosmos.sources[0]).toMatchObject({ select: 'properties.documentEndpoint' });
    // A `name` loader gets NO projection — there is nothing to derive.
    expect(AZURE_BACKED_FIELDS.synapse.sources[0].select).toBeUndefined();
    expect(AZURE_BACKED_FIELDS.synapse.valueFrom).toBe('name');
  });

  it('a multi-kind loader becomes one source per kind, so neither kind hides the other', () => {
    // L.aoaiEndpoint filters kind ∈ {OpenAI, AIServices}; the route takes ONE
    // kind per query, so dropping the second would hide every AIServices
    // account behind the OpenAI ones.
    const kinds = AZURE_BACKED_FIELDS.aoaiEndpoint.sources.map((s) => s.kind);
    expect(kinds).toEqual(['OpenAI', 'AIServices']);
  });
});

describe('the ARM shapes Resource Graph needs a different table for', () => {
  it('exposes resource groups, subscriptions and subnets as first-class kinds', () => {
    expect(AZURE_BACKED_FIELDS['resource-group'].sources[0].type).toBe('Microsoft.Resources/subscriptions/resourceGroups');
    expect(AZURE_BACKED_FIELDS.subscription.valueFrom).toBe('subscriptionId');
    expect(AZURE_BACKED_FIELDS.subnet.sources[0].type).toBe('Microsoft.Network/virtualNetworks/subnets');
  });
});

describe('ARM `kind` is a comma LIST, not an enum', () => {
  /**
   * REGRESSION GUARD (review 2026-09-07). `function-app-id` shipped as a bare
   * `kind: 'functionapp'`, which `/api/azure/resources` renders as
   * `| where kind =~ 'functionapp'` — case-insensitive EQUALITY. Loom's own
   * bicep declares 15 function-app `Microsoft.Web/sites` repo-wide and 14 of
   * them carry a comma list (`functionapp,linux`), so that predicate matched
   * almost none of them and the Event Grid destination picker —
   * which DEFAULTS to `AzureFunction` — opened on a list that could never
   * return a row.
   */
  it('the Function App source asks for CONTAINS, so a `functionapp,linux` site is not excluded', () => {
    const [src] = AZURE_BACKED_FIELDS['function-app-id'].sources;
    expect(src.type).toBe('Microsoft.Web/sites');
    expect(src.kind).toBe('functionapp');
    // The load-bearing half: equality here is the dead end, so it is asserted
    // rather than left to the comment.
    expect(src.kindMatch).toBe('contains');
  });

  it('and the request the picker actually issues carries kindMatch=contains', async () => {
    wrap(<AzureBackedField kind="function-app-id" onChange={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('type=Microsoft.Web%2Fsites');
    expect(url).toContain('kind=functionapp');
    expect(url).toContain('kindMatch=contains');
  });

  it('a source with no kindMatch sends no kindMatch, so every other picker is unchanged', async () => {
    wrap(<AzureBackedField kind="adxUri" onChange={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('kindMatch');
  });
});

describe('cloud parity', () => {
  it('the catalog endpoint queries Databricks AND Loom Unity, so Gov is not empty', () => {
    const types = AZURE_BACKED_FIELDS['catalog-endpoint'].sources.map((s) => s.type);
    expect(types).toEqual(['Microsoft.Databricks/workspaces', 'Microsoft.App/containerApps']);
  });

  it('no field kind reaches a Fabric or Power BI host', () => {
    const all = JSON.stringify(AZURE_BACKED_FIELDS).toLowerCase();
    expect(all).not.toContain('fabric');
    expect(all).not.toContain('powerbi');
    expect(all).not.toContain('power bi');
  });

  it('issues one discovery request per source and merges them', async () => {
    wrap(<AzureBackedField kind="catalog-endpoint" onChange={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain('type=Microsoft.Databricks%2Fworkspaces');
    expect(urls[0]).toContain('select=properties.workspaceUrl');
    expect(urls[1]).toContain('select=properties.configuration.ingress.fqdn');
  });
});

describe('the field itself', () => {
  it('asks the route for the loader\'s projection and labels itself from the registry', async () => {
    wrap(<AzureBackedField kind="adxUri" onChange={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toContain('select=properties.uri');
    expect(screen.getByText('Azure Data Explorer cluster URI')).toBeInTheDocument();
  });

  it('hands back the value the loader says to store, not the ARM id', () => {
    const sel = {
      id: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Kusto/clusters/c',
      name: 'c', subscriptionId: 's', resourceGroup: 'rg', location: 'eastus',
      value: 'https://c.eastus.kusto.windows.net',
    };
    expect(valueOfSelection('properties.uri', sel)).toBe('https://c.eastus.kusto.windows.net');
    expect(valueOfSelection('name', sel)).toBe('c');
    expect(valueOfSelection('id', sel)).toBe(sel.id);
    expect(valueOfSelection('subscriptionId', sel)).toBe('s');
  });

  it('an unknown kind SAYS SO instead of rendering an empty picker', () => {
    wrap(<AzureBackedField kind={'not-a-kind' as any} onChange={() => {}} />);
    expect(screen.getByRole('alert').textContent).toContain("unknown kind 'not-a-kind'");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * The hint is what a replaced `<Field>` used to carry. `app/catalog/unity`
   * lost "Omit for the connector's system-assigned identity" when its
   * hand-rolled Field became a picker, leaving "(optional)" in the label to
   * carry a meaning it does not carry — the label says the value MAY be
   * omitted, never what omitting it DOES. This asserts the prop reaches the
   * rendered Field rather than being accepted and dropped.
   */
  it('renders the hint under the control, and renders none when none is passed', async () => {
    const hint = "Omit for the connector's system-assigned identity.";
    const { unmount } = wrap(
      <AzureBackedField kind="user-assigned-identity" hint={hint} onChange={() => {}} />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByText(hint)).toBeInTheDocument();
    unmount();

    fetchMock.mockClear();
    wrap(<AzureBackedField kind="user-assigned-identity" onChange={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText(hint)).toBeNull();
  });
});
