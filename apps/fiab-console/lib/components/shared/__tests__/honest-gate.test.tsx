/**
 * HonestGate (G2) — render + Fix-it contract tests (jsdom, real component).
 *
 *   1. blocked state renders the warning bar with the registry title, the
 *      missing env var, the bicep module, and the role;
 *   2. the "Fix it" button opens the wizard dialog, which loads REAL options
 *      from GET /api/admin/gates/[id]/options (mocked transport here) and
 *      shows a field per required setting;
 *   3. Apply POSTs the picked values to /api/admin/gates/[id]/resolve and
 *      surfaces the honest revision-roll message;
 *   4. configured state renders the compact live chip, not a warning.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const fetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({
  clientFetch: (...a: any[]) => fetchMock(...a),
}));

import { HonestGate } from '../honest-gate';

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

function jsonRes(body: unknown, status = 200) {
  return { status, json: async () => body } as any;
}

afterEach(cleanup);
beforeEach(() => fetchMock.mockReset());

describe('HonestGate', () => {
  it('renders the registry-driven warning bar for a blocked gate', () => {
    wrap(
      <HonestGate
        gateId="svc-eventhubs"
        surface="Event Hubs navigator"
        missing="LOOM_EVENTHUB_NAMESPACE"
      />,
    );
    expect(screen.getByText(/Event Hubs navigator needs Event Hubs \(eventstream\)/)).toBeInTheDocument();
    expect(screen.getByText('LOOM_EVENTHUB_NAMESPACE')).toBeInTheDocument();
    expect(screen.getByText(/Azure Event Hubs Data Owner/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fix it/i })).toBeInTheDocument();
    // Registry deep-link for the complete list.
    const link = screen.getByRole('link', { name: /gate registry/i });
    expect(link).toHaveAttribute('href', '/admin/gates');
  });

  it('WS-D2: renders uniformly from a route buildGateEnvelope() gate block', () => {
    // A gated route returns { ok:false, gated:true, gate:{ id,title,remediation,fixItHref,missing } }.
    // Passing that gate block straight in must drive the same bar — no per-surface
    // re-derivation of gateId/missing.
    wrap(
      <HonestGate
        gate={{
          id: 'svc-eventhubs',
          title: 'Event Hubs (eventstream)',
          remediation: 'Set LOOM_EVENTHUB_NAMESPACE to enable the Azure-native eventstream backend.',
          fixItHref: '/admin/gates?gate=svc-eventhubs',
          missing: ['LOOM_EVENTHUB_NAMESPACE'],
        }}
        surface="Eventstream editor"
      />,
    );
    expect(screen.getByText(/Eventstream editor needs Event Hubs \(eventstream\)/)).toBeInTheDocument();
    expect(screen.getByText('LOOM_EVENTHUB_NAMESPACE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fix it/i })).toBeInTheDocument();
  });

  it('opens the Fix-it wizard, loads real options, and applies via the resolve route', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/admin/gates/svc-eventhubs/options') {
        return jsonRes({
          ok: true,
          options: {
            LOOM_EVENTHUB_NAMESPACE: [
              { value: 'loom-evhns', label: 'loom-evhns (centralus)', resourceId: '/subs/x/evhns' },
            ],
          },
        });
      }
      if (url === '/api/admin/gates/svc-eventhubs/resolve') {
        expect(init?.method).toBe('POST');
        const body = JSON.parse(String(init?.body));
        expect(body.values.LOOM_EVENTHUB_NAMESPACE).toBe('loom-evhns');
        return jsonRes({
          ok: true, gateId: 'svc-eventhubs', changedCount: 1,
          message: 'Applied 1 value(s) — a new revision is rolling (~1–2 min); the gate flips to configured once it is live.',
          driftWarning: 'fold into bicep',
        });
      }
      return jsonRes({ ok: true, gates: [] });
    });

    wrap(<HonestGate gateId="svc-eventhubs" surface="Event Hubs navigator" />);
    fireEvent.click(screen.getByRole('button', { name: /fix it/i }));

    // The wizard loads options for the gate's settings.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/admin/gates/svc-eventhubs/options');
    });
    // A field per required setting (namespace is the gate's required var).
    const combo = await screen.findByRole('combobox');
    fireEvent.change(combo, { target: { value: 'loom-evhns' } });

    const apply = screen.getByRole('button', { name: /apply/i });
    await waitFor(() => expect(apply).not.toBeDisabled());
    fireEvent.click(apply);

    // Honest revision-roll message (never an instant fake success).
    await waitFor(() => {
      expect(screen.getByText(/new revision is rolling/i)).toBeInTheDocument();
    });
  });

  it('renders the compact live chip when configured', () => {
    wrap(<HonestGate gateId="svc-eventhubs" surface="Event Hubs navigator" configured />);
    expect(screen.queryByRole('button', { name: /fix it/i })).not.toBeInTheDocument();
    expect(screen.getByText(/connected/i)).toBeInTheDocument();
    expect(screen.getByText('live')).toBeInTheDocument();
  });

  it('falls back to an honest generic bar for an unknown gate id', () => {
    wrap(<HonestGate gateId="not-a-gate" surface="Somewhere" detail="Custom detail." />);
    expect(screen.getByText(/Somewhere needs configuration/)).toBeInTheDocument();
    expect(screen.getByText(/Custom detail\./)).toBeInTheDocument();
  });
});

/**
 * #4776 — a SERVER-classified failure. In a browser the registry's runtime
 * overlay is empty (the store is per-process), so `getGate()` returns the
 * static def with its env-picker Fix-it. The `classified` prop must drive the
 * bar AND the Fix-it: permission → a role grant carrying the remediation.
 */
describe('HonestGate — classified (#4776)', () => {
  const REMEDIATION = 'A workspace admin grants the allow-cluster-create entitlement to the Console managed identity.';

  it('permission: names the cause + entitlement, and the Fix-it opens as the ROLE GRANT', async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: true, options: {} }));
    wrap(
      <HonestGate
        gateId="svc-databricks-sql"
        surface="MDM"
        classified={{ kind: 'permission', error: 'Databricks refused the create (HTTP 403).', remediation: REMEDIATION, entitlement: 'allow-cluster-create' }}
      />,
    );
    // Breaks if the classified prop is ignored: the static "MDM needs … wired" title renders.
    expect(screen.getByText(/MDM: .* — permission refused/)).toBeInTheDocument();
    expect(screen.queryByText(/needs .* wired in this deployment/)).toBeNull();
    expect(screen.getByText('Databricks refused the create (HTTP 403).', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('allow-cluster-create')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /fix it/i }));
    // Bar item + dialog remediation caption + dialog role-grant note = 3.
    // Breaks (2) if the dialog keeps the static env-picker (no grant note).
    expect(await screen.findAllByText(REMEDIATION)).toHaveLength(3);
  });

  it('network: the Fix-it keeps the declared Fix-it, and SAYS pinning is a bypass, not the fix', async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: true, options: {} }));
    const net = 'Verify the databricks_ui_api private endpoint is Approved.';
    wrap(<HonestGate gateId="svc-databricks-sql" surface="MDM" classified={{ kind: 'network', error: 'refused at the network layer (HTTP 403)', remediation: net }} />);
    expect(screen.getByText(/MDM: .* — refused or unreachable at the network layer/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /fix it/i }));
    // Bar item + dialog caption carry the remediation verbatim. Breaks (3) if a
    // network cause became a role grant (the grant note IS the bare remediation).
    expect(await screen.findAllByText(net)).toHaveLength(2);
    // Round 4 nit: the dialog labels the pin honestly. Breaks if a non-permission
    // cause opens the plain env-picker with no note.
    expect(screen.getByText(/only bypasses the one the Console produces; it does not address the cause of this network failure/)).toBeInTheDocument();
  });
});
