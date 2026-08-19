/**
 * #3729 — the Fix-it dialog must pre-fill from the running deployment, and must
 * offer the remediation that matches the ACTUAL blocker.
 *
 * THE DEFECT THIS PINS. On the live Commercial console, `/admin/readiness` →
 * Core platform → "Azure subscription + resource groups" showed Blocked with a
 * connectivity diagnosis. Clicking **Fix it** opened a dialog asking the admin
 * to (re-)enter `LOOM_SUBSCRIPTION_ID`, `LOOM_DLZ_RG` and `LOOM_ADMIN_RG` —
 * all three rendered EMPTY, showing only placeholder text — while
 * `/admin/env-config`, same console and same session, showed all three already
 * set with correct values. Two failures compounded:
 *
 *   1. `useEffect` on open did `setValues({})` and NOTHING ever read the
 *      current config, so every field opened blank. A blank field is
 *      indistinguishable from an unset value: the dialog implied the values
 *      were missing when they were not.
 *   2. Retyping a subscription id cannot address "the UAMI token is being
 *      issued" or "can reach management.azure.com". The dialog offered a form
 *      that could not resolve its own stated diagnosis.
 *
 * Transport is mocked; the real component renders.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const fetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({
  clientFetch: (...a: any[]) => fetchMock(...a),
}));

import { GateFixitDialog } from '../honest-gate';
import { getGate } from '@/lib/gates/registry';

const SUB = 'e093f4fd-5047-4ee4-968d-a56942c665f3';
const RG = 'rg-csa-loom-admin-centralus';

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}
function jsonRes(body: unknown, status = 200) {
  return { status, json: async () => body } as any;
}

/** The live env-config shape: all three of this gate's vars ARE set. */
function envConfigAllSet() {
  return jsonRes({
    ok: true,
    current: {
      LOOM_SUBSCRIPTION_ID: { set: true, status: 'set', secret: false, value: SUB },
      LOOM_DLZ_RG: { set: true, status: 'set', secret: false, value: RG },
      LOOM_ADMIN_RG: { set: true, status: 'set', secret: false, value: RG },
    },
  });
}

afterEach(cleanup);
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/admin/env-config') return envConfigAllSet();
    return jsonRes({ ok: true, options: {} });
  });
});

const subscriptionGate = getGate('subscription')!;

describe('GateFixitDialog — pre-fills from the running deployment', () => {
  it('every non-secret field opens carrying its CURRENT value, not a placeholder', async () => {
    wrap(<GateFixitDialog gate={subscriptionGate} open onClose={() => {}} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/admin/env-config'));

    const subField = await screen.findByLabelText('LOOM_SUBSCRIPTION_ID');
    expect((subField as HTMLInputElement).value).toBe(SUB);
    expect((screen.getByLabelText('LOOM_DLZ_RG') as HTMLInputElement).value).toBe(RG);
    expect((screen.getByLabelText('LOOM_ADMIN_RG') as HTMLInputElement).value).toBe(RG);
  });

  it('Apply is disabled while nothing differs from the running deployment', async () => {
    wrap(<GateFixitDialog gate={subscriptionGate} open onClose={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/admin/env-config'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
    });
  });

  it('says a value is NOT set when it genuinely is not — a blank field is never left ambiguous', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/admin/env-config') {
        return jsonRes({ ok: true, current: { LOOM_SUBSCRIPTION_ID: { set: false, status: 'unset', secret: false, value: '' } } });
      }
      return jsonRes({ ok: true, options: {} });
    });
    wrap(<GateFixitDialog gate={subscriptionGate} open onClose={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/admin/env-config'));
    // One per required setting — every one of them genuinely unset here.
    const hints = await screen.findAllByText(/Not set in this deployment/);
    expect(hints.length).toBe(subscriptionGate.requiredSettings.length);
  });

  it('when the current config cannot be read it SAYS so — an empty field is not evidence', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/admin/env-config') return jsonRes({ ok: false, error: 'cosmos unavailable' }, 503);
      return jsonRes({ ok: true, options: {} });
    });
    wrap(<GateFixitDialog gate={subscriptionGate} open onClose={() => {}} />);
    expect(await screen.findByText(/Current values unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/does NOT mean the value is unset/)).toBeInTheDocument();
  });
});

describe('GateFixitDialog — the remediation matches the real blocker', () => {
  const inconclusiveProbe = {
    id: 'probe-arm-reader',
    status: 'warn' as const,
    inconclusive: true,
    detail: 'Could not establish whether ARM is readable — the check did not complete.',
    remediation: 'No operator action is known to be required. Re-check to re-probe.',
  };

  it('an env-complete, probe-blocked gate leads with the live-check finding, not the env form', async () => {
    wrap(
      <GateFixitDialog
        gate={subscriptionGate}
        open
        onClose={() => {}}
        probe={inconclusiveProbe}
        capabilityState="unknown"
        onRecheck={() => {}}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/admin/env-config'));

    expect(await screen.findByText(/Not established — the live check did not complete/)).toBeInTheDocument();
    expect(screen.getByText(/Could not establish whether ARM is readable/)).toBeInTheDocument();
    expect(screen.getByText(/already set and were not the problem/)).toBeInTheDocument();
    // And the action that can actually resolve it.
    expect(screen.getAllByRole('button', { name: /re-check now/i }).length).toBeGreaterThan(0);
  });

  it('Re-check runs the live probes again and closes the dialog', async () => {
    const onRecheck = vi.fn();
    const onClose = vi.fn();
    wrap(
      <GateFixitDialog
        gate={subscriptionGate}
        open
        onClose={onClose}
        probe={inconclusiveProbe}
        capabilityState="unknown"
        onRecheck={onRecheck}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/admin/env-config'));
    const btn = (await screen.findAllByRole('button', { name: /re-check now/i }))[0];
    btn.click();
    await waitFor(() => {
      expect(onRecheck).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('a genuinely-unconfigured gate still leads with the env remediation', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/admin/env-config') return jsonRes({ ok: true, current: {} });
      return jsonRes({ ok: true, options: {} });
    });
    wrap(<GateFixitDialog gate={subscriptionGate} open onClose={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/admin/env-config'));
    expect(screen.getByText(subscriptionGate.remediation)).toBeInTheDocument();
    expect(screen.queryByText(/were not the problem/)).not.toBeInTheDocument();
  });

  it('Re-check fires ONCE however many times it is clicked', async () => {
    const onRecheck = vi.fn();
    wrap(
      <GateFixitDialog
        gate={subscriptionGate}
        open
        onClose={() => {}}
        probe={inconclusiveProbe}
        capabilityState="unknown"
        onRecheck={onRecheck}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/admin/env-config'));
    const buttons = await screen.findAllByRole('button', { name: /re-check now/i });
    // Each click bypasses the probe cache and fans out every live probe, so a
    // second click would multiply the load the check is measuring.
    buttons.forEach((b) => b.click());
    await waitFor(() => expect(onRecheck).toHaveBeenCalledTimes(1));
    buttons.forEach((b) => expect(b).toBeDisabled());
  });
});

describe('GateFixitDialog — a SECRET setting counts as present', () => {
  /**
   * `/api/admin/env-config` returns `{ set: true }` with NO value for a secret,
   * by design. Deriving presence from the value alone made `envComplete`
   * permanently false for any gate carrying a secret setting, so such a gate
   * kept opening on the env form even with every value present. Latent when
   * #3729 shipped (no gate in GATE_PROBE_MAP has a secret setting) — but
   * `entra-app` is critical severity and one probe mapping away.
   */
  const entraApp = getGate('entra-app');
  const SECRET_VAR = 'LOOM_MSAL_CLIENT_SECRET';

  it('the fixture is real: entra-app exists and carries a secret setting', () => {
    // Asserted, not skipped — a test that returns early when its subject is
    // missing is a test that cannot fail.
    expect(entraApp).toBeTruthy();
    expect(entraApp!.requiredSettings.map((s) => s.envVar)).toContain(SECRET_VAR);
  });

  it('says a set secret is set, and never renders its value', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/admin/env-config') {
        const current: Record<string, unknown> = {};
        for (const s of entraApp!.requiredSettings) {
          current[s.envVar] = /SECRET/i.test(s.envVar)
            ? { set: true, status: 'set', secret: true }
            : { set: true, status: 'set', secret: false, value: `value-of-${s.envVar}` };
        }
        return jsonRes({ ok: true, current });
      }
      return jsonRes({ ok: true, options: {} });
    });
    wrap(<GateFixitDialog gate={entraApp!} open onClose={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/admin/env-config'));

    expect(await screen.findByText(/a secret value is never shown/)).toBeInTheDocument();
    // The field itself stays empty — presence is stated in words, never echoed.
    const field = screen.getByLabelText(SECRET_VAR) as HTMLInputElement;
    expect(field.value).toBe('');
    expect(field.type).toBe('password');
  });

  it('an ALL-SET gate whose probe failed does not open on the env form', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/admin/env-config') {
        const current: Record<string, unknown> = {};
        for (const s of entraApp!.requiredSettings) {
          current[s.envVar] = /SECRET/i.test(s.envVar)
            ? { set: true, status: 'set', secret: true }
            : { set: true, status: 'set', secret: false, value: `value-of-${s.envVar}` };
        }
        return jsonRes({ ok: true, current });
      }
      return jsonRes({ ok: true, options: {} });
    });
    wrap(
      <GateFixitDialog
        gate={entraApp!}
        open
        onClose={() => {}}
        probe={{ id: 'probe-x', status: 'fail', detail: 'backend refused', remediation: 'grant the role' }}
        capabilityState="blocked"
        onRecheck={() => {}}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/admin/env-config'));
    // The secret is unreadable, so without presentKeys `envComplete` was false
    // and this bar never rendered.
    expect(await screen.findByText(/The configuration is complete; the live check is what failed/)).toBeInTheDocument();
    expect(screen.getByText(/backend refused/)).toBeInTheDocument();
  });
});
