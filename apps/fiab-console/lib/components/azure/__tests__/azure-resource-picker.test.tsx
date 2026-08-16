/**
 * AzureResourcePicker — the three defects that blocked adoption, pinned.
 *
 * Every one of these assertions exists because the OPPOSITE behaviour shipped,
 * and because this component is about to be adopted by ~40 surfaces at once:
 * a regression here is a regression everywhere. Each test is written so that
 * reverting its fix makes it FAIL (mutation receipts are in the PR body).
 *
 *   1. a stored value that discovery cannot resolve is PRESERVED, not blanked;
 *   2. a failed discovery leaves a USABLE control, not a disabled dead end;
 *   3. the gate carries the Fix-it wizard, not a bare warning bar.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const fetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({ clientFetch: (...a: any[]) => fetchMock(...a) }));

import { AzureResourcePicker, describeUnresolvedValue, validateManualValue } from '../azure-resource-picker';

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}
function jsonRes(body: unknown, status = 200) {
  return { status, json: async () => body } as any;
}

const STORED_ID =
  '/subscriptions/other-sub/resourceGroups/rg-secret/providers/Microsoft.Kusto/clusters/adx-hidden';

const CLUSTER = {
  id: '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Kusto/clusters/adx-1',
  name: 'adx-1',
  type: 'microsoft.kusto/clusters',
  location: 'eastus2',
  resourceGroup: 'rg',
  subscriptionId: 's1',
  value: 'https://adx-1.eastus2.kusto.windows.net',
};

afterEach(cleanup);
// NOT `beforeEach(() => fetchMock.mockReset())`: `mockReset()` RETURNS the mock,
// and vitest treats a value returned from a hook as a cleanup function — so it
// would call the spy with no arguments after every test.
beforeEach(() => { fetchMock.mockReset(); });

describe('DEFECT 1 — a stored value discovery cannot resolve is preserved', () => {
  it('keeps a saved ARM id from a subscription the caller cannot see', async () => {
    // The caller can see ONE cluster; the saved value is a different one, in a
    // subscription this identity has no RBAC on. The old `resources.find(...)`
    // returned undefined and the box rendered EMPTY — which a Save then wrote
    // back over a working binding.
    fetchMock.mockResolvedValue(jsonRes({ ok: true, resources: [CLUSTER], via: 'user' }));
    wrap(<AzureResourcePicker type="Microsoft.Kusto/clusters" value={STORED_ID} onChange={() => {}} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => {
      const box = screen.getByRole('combobox') as HTMLInputElement;
      expect(box.value).not.toBe('');
    });
    const box = screen.getByRole('combobox') as HTMLInputElement;
    expect(box.value).toContain('adx-hidden');
    expect(screen.getByText(/saved value — not visible to you/i)).toBeInTheDocument();
  });

  it('does not flash empty while the query is still in flight', async () => {
    // Held open — this is the FIRST PAINT, which is what the user sees on every
    // open of an existing item. The old build resolved `selected` out of an
    // empty `resources`, so the box was blank until the query came back.
    let release: (v: unknown) => void = () => {};
    fetchMock.mockReturnValue(new Promise((r) => { release = r; }));
    wrap(<AzureResourcePicker type="Microsoft.Kusto/clusters" value={STORED_ID} onChange={() => {}} />);

    const box = screen.getByRole('combobox') as HTMLInputElement;
    expect(box.value).toContain('adx-hidden');
    expect(screen.getByText(/saved value — resolving/i)).toBeInTheDocument();

    // Let the component settle so cleanup does not race an in-flight promise.
    release(jsonRes({ ok: true, resources: [CLUSTER], via: 'user' }));
    await waitFor(() => expect(screen.getByText(/saved value — not visible to you/i)).toBeInTheDocument());
  });

  /**
   * RENDERING the stored value was only half the fix. INTERACTING with it fed
   * the same option straight back into `resources.find(...)`, which by the
   * definition of `unresolved` can never match — so every one of these paths
   * called `onChange(null)` and the caller's next Save wrote the blank back.
   * That is the ORIGINAL defect, reachable through the control built to fix it.
   *
   * Verified against the pinned @fluentui/react-combobox@9.17.1, not assumed:
   *   - lib/utils/useSelection.js — single-select ALWAYS fires onOptionSelect
   *     with a non-empty `optionValue`; there is no deselect-on-reclick path.
   *   - lib/utils/useComboboxBaseState.js — on open, single-select focuses the
   *     currently-selected option, which with `selectedOptions={[value]}` IS
   *     the stored-value option. So "open, press Enter" hits it too.
   */
  it('selecting the preserved stored-value option re-affirms it — it does NOT clear the binding', async () => {
    const onChange = vi.fn();
    fetchMock.mockResolvedValue(jsonRes({ ok: true, resources: [CLUSTER], via: 'user' }));
    wrap(<AzureResourcePicker type="Microsoft.Kusto/clusters" value={STORED_ID} onChange={onChange} />);

    await waitFor(() => expect(screen.getByText(/saved value — not visible to you/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: /saved value, not in the discovered list/i }));

    expect(onChange).not.toHaveBeenCalledWith(null);
  });

  it('keyboard-selecting the stored option (open → Enter, the focused row) does NOT clear it either', async () => {
    const onChange = vi.fn();
    fetchMock.mockResolvedValue(jsonRes({ ok: true, resources: [CLUSTER], via: 'user' }));
    wrap(<AzureResourcePicker type="Microsoft.Kusto/clusters" value={STORED_ID} onChange={onChange} />);

    await waitFor(() => expect(screen.getByText(/saved value — not visible to you/i)).toBeInTheDocument());
    const box = screen.getByRole('combobox');
    fireEvent.click(box);
    await screen.findByRole('option', { name: /saved value, not in the discovered list/i });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(onChange).not.toHaveBeenCalledWith(null);
  });

  it('picking a REAL resource from a picker holding an unresolved stored value still switches to it', async () => {
    // The guard must not become "never clear": choosing a different, discovered
    // resource has to replace the stored value, or the fix would freeze the field.
    const onChange = vi.fn();
    fetchMock.mockResolvedValue(jsonRes({ ok: true, resources: [CLUSTER], via: 'user' }));
    wrap(<AzureResourcePicker type="Microsoft.Kusto/clusters" value={STORED_ID} onChange={onChange} />);

    await waitFor(() => expect(screen.getByText(/saved value — not visible to you/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: /adx-1/ }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: CLUSTER.id }));
    expect(onChange).not.toHaveBeenCalledWith(null);
  });

  it('resolves a stored DERIVED value (an endpoint, not an id) against the projection', async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: true, resources: [CLUSTER], via: 'user', select: 'properties.uri' }));
    wrap(
      <AzureResourcePicker
        type="Microsoft.Kusto/clusters"
        select="properties.uri"
        matchBy="derived"
        value={CLUSTER.value}
        onChange={() => {}}
      />,
    );
    await waitFor(() => {
      const box = screen.getByRole('combobox') as HTMLInputElement;
      expect(box.value).toContain('adx-1');
    });
    // Resolved, so it is NOT badged as an unverified saved value.
    expect(screen.queryByText(/saved value/i)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toContain('select=properties.uri');
  });
});

describe('DEFECT 2 — a failed discovery is not a dead end', () => {
  it('leaves a usable control when the route returns the no_access gate', async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: false, code: 'no_access', error: 'UAMI lacks Reader at tenant root.' }));
    wrap(<AzureResourcePicker type="Microsoft.Kusto/clusters" onChange={() => {}} />);

    // The manual-entry escape hatch appears in place of the (now impossible)
    // list — the old build rendered a DISABLED combobox and nothing else, which
    // in Gov turns a working surface into a broken one.
    const manual = await screen.findByLabelText('Resource ID');
    expect(manual).toBeInTheDocument();
    expect((manual as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: /use this value/i })).toBeInTheDocument();
  });

  it('accepts a hand-entered ARM id and hands it back', async () => {
    const onChange = vi.fn();
    fetchMock.mockResolvedValue(jsonRes({ ok: false, code: 'no_access', error: 'no access' }));
    wrap(<AzureResourcePicker type="Microsoft.Kusto/clusters" onChange={onChange} />);

    const manual = await screen.findByLabelText('Resource ID');
    fireEvent.change(manual, { target: { value: STORED_ID } });
    fireEvent.click(screen.getByRole('button', { name: /use this value/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: STORED_ID }));
  });

  it('rejects a malformed hand-entered value instead of storing it', async () => {
    const onChange = vi.fn();
    fetchMock.mockResolvedValue(jsonRes({ ok: false, code: 'no_access', error: 'no access' }));
    wrap(<AzureResourcePicker type="Microsoft.Kusto/clusters" onChange={onChange} />);

    const manual = await screen.findByLabelText('Resource ID');
    fireEvent.change(manual, { target: { value: '/subscriptions/only-this-much' } });
    fireEvent.click(screen.getByRole('button', { name: /use this value/i }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/truncated ARM id/i)).toBeInTheDocument();
  });

  it('a hard error is also usable, not disabled', async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: false, error: 'ARG 500' }, 500));
    wrap(<AzureResourcePicker type="Microsoft.Kusto/clusters" onChange={() => {}} />);
    expect(await screen.findByLabelText('Resource ID')).toBeInTheDocument();
    expect(screen.getByText(/Could not list Azure resources/i)).toBeInTheDocument();
  });

  it('one empty source of a cloud-parity pair does NOT gate a list the other populated', async () => {
    // Databricks has no Gov endpoint, so its query legitimately returns the
    // no_access gate there while Loom Unity returns rows. Gating on the first
    // failure would blank the catalog picker in exactly the boundary that
    // depends on it (cloud-parity.md).
    fetchMock
      .mockResolvedValueOnce(jsonRes({ ok: false, code: 'no_access', error: 'no databricks' }))
      .mockResolvedValueOnce(jsonRes({
        ok: true,
        via: 'uami',
        resources: [{ ...CLUSTER, type: 'microsoft.app/containerapps', name: 'loom-unity', value: 'loom-unity.x.io' }],
      }));
    wrap(
      <AzureResourcePicker
        sources={[
          { type: 'Microsoft.Databricks/workspaces', select: 'properties.workspaceUrl', label: 'Databricks' },
          { type: 'Microsoft.App/containerApps', select: 'properties.configuration.ingress.fqdn', label: 'Loom Unity' },
        ]}
        matchBy="derived"
        onChange={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/1 resource across 1 source/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /fix it/i })).not.toBeInTheDocument();
  });
});

describe('DEFECT 3 — the gate carries a Fix-it', () => {
  it('renders the shared HonestGate with its Fix-it button, not a bare MessageBar', async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: false, code: 'no_access', error: 'Grant Reader at the tenant root.' }));
    wrap(<AzureResourcePicker type="Microsoft.Kusto/clusters" surface="ADX cluster" onChange={() => {}} />);

    expect(await screen.findByRole('button', { name: /fix it/i })).toBeInTheDocument();
    // The registry link that makes the gate discoverable (ux-baseline G2).
    expect(screen.getByRole('link', { name: /gate registry/i })).toHaveAttribute('href', '/admin/gates');
    // The route's own honest text is what the bar says.
    expect(screen.getByText(/Grant Reader at the tenant root/i)).toBeInTheDocument();
  });
});

describe('the normal path still works', () => {
  it('lists discovered resources and hands back the projected value on select', async () => {
    const onChange = vi.fn();
    fetchMock.mockResolvedValue(jsonRes({ ok: true, via: 'user', resources: [CLUSTER], select: 'properties.uri' }));
    wrap(
      <AzureResourcePicker
        type="Microsoft.Kusto/clusters"
        select="properties.uri"
        matchBy="derived"
        onChange={onChange}
      />,
    );
    await waitFor(() => expect(screen.getByText(/1 resource across 1 subscription/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: /adx-1/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      id: CLUSTER.id,
      value: 'https://adx-1.eastus2.kusto.windows.net',
    }));
  });

  it('marks a row whose projected property came back empty as unselectable rather than storing an empty endpoint', async () => {
    fetchMock.mockResolvedValue(jsonRes({
      ok: true, via: 'user', select: 'properties.uri', unresolved: 1,
      resources: [{ ...CLUSTER, value: '' }],
    }));
    wrap(<AzureResourcePicker type="Microsoft.Kusto/clusters" select="properties.uri" matchBy="derived" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByText(/1 resource/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('combobox'));
    const opt = await screen.findByRole('option', { name: /Resource Graph returned no/i });
    expect(opt).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('helpers', () => {
  it('describes an unresolvable ARM id by its leaf and resource group', () => {
    expect(describeUnresolvedValue(STORED_ID)).toBe('adx-hidden (resource group rg-secret)');
    expect(describeUnresolvedValue('https://x.kusto.windows.net')).toBe('https://x.kusto.windows.net');
  });

  it('validates a manual value per the kind of value it is', () => {
    expect(validateManualValue('', 'id')).toMatch(/Enter a value/);
    expect(validateManualValue(STORED_ID, 'id')).toBeNull();
    expect(validateManualValue('adx-1', 'id')).toMatch(/starts with \/subscriptions/);
    expect(validateManualValue('https://adx.eastus2.kusto.windows.net', 'derived')).toBeNull();
    expect(validateManualValue('not a url', 'derived')).toMatch(/resource name/);
    expect(validateManualValue('11111111-2222-3333-4444-555555555555', 'subscriptionId')).toBeNull();
    expect(validateManualValue('nope', 'subscriptionId')).toMatch(/GUID/);
  });
});
