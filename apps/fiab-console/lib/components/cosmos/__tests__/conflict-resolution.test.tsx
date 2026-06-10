/**
 * CosmosSettingsPanel — conflict-resolution policy contract test (audit-T27).
 *
 * Verifies the Conflict Resolution section is a real, editable form (not the
 * old honest-gate MessageBar): it hydrates the live policy from
 * /api/cosmos/container-settings, lets the operator switch Last-Writer-Wins →
 * Custom + enter a merge stored procedure, and PATCHes the BFF with the ARM
 * `conflictResolutionPolicy` shape. Per .claude/rules/no-vaporware.md this
 * lifts the surface from D (stubbed gate) to A (functional + Vitest).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { CosmosSettingsPanel } from '../cosmos-settings-panel';

function installSettingsMock() {
  const calls: Array<{ url: string; init?: RequestInit; body?: any }> = [];
  const fetchMock = vi.fn(async (url: any, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : (url?.toString?.() ?? String(url));
    let body: any;
    try { body = init?.body ? JSON.parse(init.body as string) : undefined; } catch { /* ignore */ }
    calls.push({ url: u, init, body });
    const method = (init?.method || 'GET').toUpperCase();
    // PATCH echoes the updated policy back so the panel re-hydrates from it.
    if (u.includes('/api/cosmos/container-settings') && method === 'PATCH') {
      const crp = body?.conflictResolutionPolicy;
      return json({
        ok: true,
        container: {
          id: 'orders', name: 'orders', partitionKey: '/id', partitionKeyKind: 'Hash',
          defaultTtl: null,
          conflictResolutionPolicy: crp ?? { mode: 'LastWriterWins', conflictResolutionPath: '/_ts' },
        },
      });
    }
    if (u.includes('/api/cosmos/container-settings')) {
      return json({
        ok: true,
        container: {
          id: 'orders', name: 'orders', partitionKey: '/id', partitionKeyKind: 'Hash',
          defaultTtl: null,
          throughput: { mode: 'manual', ru: 400 },
          indexingPolicy: { indexingMode: 'consistent', automatic: true, includedPaths: [{ path: '/*' }], excludedPaths: [], compositeIndexes: [] },
          conflictResolutionPolicy: { mode: 'LastWriterWins', conflictResolutionPath: '/_ts' },
        },
      });
    }
    return json({ ok: true });
  });
  vi.spyOn(global, 'fetch').mockImplementation(fetchMock as any);
  return { calls };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function renderPanel() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <CosmosSettingsPanel db="loom" container="orders" />
    </FluentProvider>,
  );
}

describe('CosmosSettingsPanel — conflict resolution', () => {
  let mock: ReturnType<typeof installSettingsMock>;
  beforeEach(() => { mock = installSettingsMock(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('hydrates Last Writer Wins and PATCHes a Custom merge sproc', async () => {
    renderPanel();

    // The section renders as an editable form (the old honest gate is gone).
    await waitFor(() => expect(screen.getByText('Conflict Resolution')).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.queryByText(/Conflict-resolution policy not yet wired/i)).toBeNull();

    // Mode dropdown reflects the hydrated LWW policy.
    const modeDd = await screen.findByLabelText('Conflict resolution mode');
    expect(modeDd).toHaveTextContent(/Last Writer Wins/i);

    // Switch to Custom.
    fireEvent.click(modeDd);
    const customOpt = await screen.findByRole('option', { name: /Custom/i });
    fireEvent.click(customOpt);

    // Enter a merge stored procedure.
    const sprocInput = await screen.findByLabelText('Merge stored procedure');
    fireEvent.change(sprocInput, { target: { value: 'sprocs/merge' } });

    // Save.
    const saveBtn = await screen.findByRole('button', { name: /Save conflict resolution policy/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const patch = mock.calls.find(
        (c) => c.url.includes('/api/cosmos/container-settings') && (c.init?.method || '').toUpperCase() === 'PATCH',
      );
      expect(patch).toBeTruthy();
      expect(patch!.body).toMatchObject({
        db: 'loom', container: 'orders',
        conflictResolutionPolicy: { mode: 'Custom', conflictResolutionProcedure: 'sprocs/merge' },
      });
    }, { timeout: 5000 });

    // Success MessageBar confirms the write was accepted.
    await waitFor(() => expect(screen.getByText(/Conflict-resolution policy updated/i)).toBeInTheDocument(), { timeout: 5000 });
  });

  it('keeps the LWW path field editable and defaults to /_ts', async () => {
    renderPanel();
    const pathInput = await screen.findByLabelText('Conflict resolution path');
    expect(pathInput).toHaveValue('/_ts');
    // An honest info MessageBar explains multi-region-write semantics (not a gate).
    await waitFor(() => expect(screen.getAllByText('enableMultipleWriteLocations').length).toBeGreaterThan(0), { timeout: 5000 });
  });
});
