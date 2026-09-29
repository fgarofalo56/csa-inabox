/**
 * GovernOwnerPane: the on-open refresh gate's MessageBar title must match the
 * gate's REAL state (#4770 review, deploy-integrity R7).
 *
 * The pane is fed the JSON of the REAL refresh route (POST imported and called
 * with env stubbed), not a hand-typed fixture. That makes this a seam test:
 * the route emitting `gateReason` and the pane reading it are pinned together.
 *
 * What value breaks each assertion:
 *   - "URL set, key absent": a pane that hard-codes the old title "On-open
 *     refresh not provisioned" (the #4770 blocker), a pane that stops reading
 *     `gateReason`, or a route that stops emitting `key_not_bound`. Any of these
 *     renders "not provisioned", so the positive title lookup throws and the
 *     `queryByText(...)).toBeNull()` fails.
 *   - "URL unset": a pane that shows "key not bound" for every gate (e.g. the
 *     condition inverted, or keyed on `gate` instead of `gateReason`). The
 *     Function genuinely is not provisioned there, so the original title must stay.
 *   - "older route, no gateReason": a pane that treats an ABSENT reason as the
 *     key case. It must fall back to the original title.
 *   - The rendered remediation suffix names the route's `bicepModule`. Pointing
 *     the key case back at azure-functions/posture-refresh/deploy/main.bicep
 *     fails the admin-plane lookup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import type { ReactNode } from 'react';

const FUNCTION_URL = 'https://func-loom-posture-refresh-test.azurewebsites.net';
const KEY_TITLE = 'On-open refresh key not bound';
const UNPROVISIONED_TITLE = 'On-open refresh not provisioned';

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({ claims: { oid: 'pane-owner-oid', upn: 'owner@contoso.com' }, exp: Date.now() / 1000 + 3600 }),
}));
vi.mock('@/lib/components/governance-shell', () => ({
  GovernanceShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/components/copilot-pane', () => ({ openCopilot: vi.fn() }));

// What the pane receives from POST /api/governance/govern/refresh. Each test
// either lets the REAL route answer (routeBody = null) or supplies a body.
let routeBody: Record<string, unknown> | null = null;
vi.mock('@/lib/client-fetch', async () => {
  const { POST } = await import('@/app/api/governance/govern/refresh/route');
  return {
    clientFetch: async (url: string) => {
      if (url.includes('/api/governance/govern/refresh')) {
        if (routeBody) return new Response(JSON.stringify(routeBody), { status: 200 });
        return (POST as unknown as () => Promise<Response>)();
      }
      // Owner posture read: fail it so only the gate MessageBar is under test.
      return new Response(JSON.stringify({ ok: false, error: 'fixture: posture read not under test' }), { status: 200 });
    },
  };
});

import { GovernOwnerPane } from '../govern-owner';

function mount() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <GovernOwnerPane />
    </FluentProvider>,
  );
}

beforeEach(() => {
  routeBody = null;
  vi.stubEnv('LOOM_POSTURE_FUNCTION_URL', '');
  vi.stubEnv('LOOM_POSTURE_FUNCTION_KEY', '');
  // The route would dispatch only with URL + key, which no case here sets.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 202 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GovernOwnerPane refresh gate title', () => {
  it('URL set, key absent → "key not bound" title, never "not provisioned"', async () => {
    vi.stubEnv('LOOM_POSTURE_FUNCTION_URL', FUNCTION_URL);
    mount();
    await waitFor(() => expect(screen.getByText(KEY_TITLE)).toBeInTheDocument());
    expect(screen.queryByText(UNPROVISIONED_TITLE)).toBeNull();
    // The suffix names the module that binds the key, not the Function module.
    expect(screen.getByText('platform/fiab/bicep/modules/admin-plane/main.bicep')).toBeInTheDocument();
    expect(screen.getByText('LOOM_POSTURE_FUNCTION_KEY')).toBeInTheDocument();
  });

  it('URL unset → the original "not provisioned" title is kept', async () => {
    mount();
    await waitFor(() => expect(screen.getByText(UNPROVISIONED_TITLE)).toBeInTheDocument());
    expect(screen.queryByText(KEY_TITLE)).toBeNull();
    expect(screen.getByText('azure-functions/posture-refresh/deploy/main.bicep')).toBeInTheDocument();
  });

  it('an older route with no gateReason falls back to the original title', async () => {
    routeBody = {
      ok: false,
      gate: 'not_configured',
      missingEnvVar: 'LOOM_POSTURE_FUNCTION_URL',
      bicepModule: 'azure-functions/posture-refresh/deploy/main.bicep',
      message: 'fixture message',
    };
    mount();
    await waitFor(() => expect(screen.getByText(UNPROVISIONED_TITLE)).toBeInTheDocument());
    expect(screen.queryByText(KEY_TITLE)).toBeNull();
  });
});
