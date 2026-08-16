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
    const missing = Object.keys(L).filter(
      (k) => !(k in AZURE_BACKED_FIELDS) && !(k in UNSERVED_LOADERS),
    );
    expect(missing).toEqual([]);
    // And the count is not accidentally zero — the control has a population.
    expect(Object.keys(L).length).toBeGreaterThanOrEqual(28);
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
});
