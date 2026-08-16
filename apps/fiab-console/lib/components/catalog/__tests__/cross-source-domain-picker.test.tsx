/**
 * CrossSourceActions → governance-domain picker (Vitest, jsdom).
 *
 * The defect: "Register in Purview" asked for the business domain as a raw GUID
 * (`11111111-2222-…`). Nobody knows that GUID, and Loom already lists the
 * domains — `/api/governance-domains` returns the published Purview Unified
 * Catalog business domains, falling back to the Loom-local domain list when
 * Purview UC is not configured, so the control is fully functional with no
 * Purview at all (`no-fabric-dependency.md`).
 *
 * The `domain` here is TRANSIENT (an argument to one POST, not a saved field),
 * so the "unresolvable stored value survives a save/reload" property is proven
 * where the value is actually persisted — in the ports-panel spec — and on the
 * primitive itself (lib/components/pickers/__tests__/loom-object-picker.test.tsx).
 * What is proven here is the rest: the right route, the picked id reaching the
 * POST, and an empty domain list never blocking the registration.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { installFetchMock } from '@/lib/editors/__tests__/test-helpers';
import { CrossSourceActions } from '../cross-source-actions';

const DOMAINS = {
  ok: true,
  source: 'purview-uc',
  domains: [
    { id: 'dom-1111', name: 'Finance', description: 'Ledger + revenue' },
    { id: 'dom-2222', name: 'Supply chain' },
  ],
};

function mount() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <CrossSourceActions source="unity-catalog" id="main.bronze.customers" host="adb-1.azuredatabricks.net" />
    </FluentProvider>,
  );
}

describe('CrossSourceActions — the governance domain is picked, not typed', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  it('lists governance domains from the Azure-native route', async () => {
    const { calls } = installFetchMock({ '/api/governance-domains': () => DOMAINS });
    mount();
    const dd = await screen.findByRole('combobox', { name: 'Governance domain' });
    fireEvent.click(dd);
    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    expect(calls.some((c) => c.url.includes('/api/governance-domains'))).toBe(true);
    // The raw-GUID box is gone.
    expect(screen.queryByPlaceholderText('11111111-2222-3333-4444-555555555555')).toBeNull();
  });

  it('the picked domain id is what reaches POST /api/catalog/register', async () => {
    const { calls } = installFetchMock({
      '/api/governance-domains': () => DOMAINS,
      '/api/catalog/register': () => ({ ok: true, guid: 'g1' }),
    });
    mount();
    const dd = await screen.findByRole('combobox', { name: 'Governance domain' });
    fireEvent.click(dd);
    fireEvent.click(await screen.findByText('Supply chain'));
    fireEvent.click(screen.getByTestId('action-register'));

    await waitFor(() => {
      const post = calls.find((c) => c.url.includes('/api/catalog/register'));
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post!.init!.body)).domain).toBe('dom-2222');
    });
  });

  it('no domains at all still leaves the surface usable — registration is domain-optional', async () => {
    installFetchMock({
      '/api/governance-domains': () => ({ ok: true, source: 'cosmos', domains: [] }),
      '/api/catalog/register': () => ({ ok: true, guid: 'g1' }),
    });
    mount();
    await waitFor(() => expect(screen.getByText('No governance domains yet')).toBeInTheDocument());
    expect(screen.getByRole('combobox', { name: 'Governance domain' })).not.toBeDisabled();
    expect(within(screen.getByTestId('domain-picker')).getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    // The action the picker sits next to must still work — an empty optional
    // picker must never gate the primary button.
    expect(screen.getByTestId('action-register')).toBeEnabled();
  });

  it('a failed domain list is an error, not "there are none"', async () => {
    installFetchMock({ '/api/governance-domains': () => ({ ok: false, error: 'Purview endpoint unreachable' }) });
    mount();
    await waitFor(() => expect(screen.getByText('Purview endpoint unreachable')).toBeInTheDocument());
    expect(screen.queryByText('No governance domains yet')).toBeNull();
    expect(screen.getByTestId('action-register')).toBeEnabled();
  });
});
