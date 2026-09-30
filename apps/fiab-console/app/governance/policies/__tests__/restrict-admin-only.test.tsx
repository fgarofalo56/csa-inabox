/**
 * #4619 — the governance Policies page "Restrict access (DLP)" dialog calls
 * POST /api/governance/dlp/restrict, which is tenant-admin only. The dialog
 * gates "Revoke access" on the shell's admin flag and renders a 403
 * `admin_only` envelope as "Tenant admins only" with the server's reason and
 * remediation, not as "Restrict failed".
 *
 * Presentation tests: the route is the enforcement point and has its own
 * authz suite (`app/api/governance/dlp/restrict/__tests__/restrict-authz`).
 * Every load-bearing assertion names the input that breaks it.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/governance/policies',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
// The shell's nav rail is not under test; render the page body only.
vi.mock('@/lib/components/governance-shell', () => ({
  GovernanceShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { SessionProvider } from '@/lib/components/session-context';
import { DLP_RESTRICT_ADMIN_ONLY } from '@/lib/util/admin-only-copy';
import PoliciesPage from '../page';

type Route = { status?: number; body: unknown };
type Calls = Array<{ url: string; method: string }>;

/** fetch stub: longest matching key wins; a key may be prefixed "POST " etc. */
function stubFetch(routes: Record<string, Route>): Calls {
  const calls: Calls = [];
  vi.spyOn(global, 'fetch').mockImplementation((async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = (init?.method || 'GET').toUpperCase();
    calls.push({ url, method });
    const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      const [m, path] = k.includes(' ') ? k.split(' ') : ['', k];
      if ((m && m !== method) || !url.includes(path)) continue;
      const hit = routes[k];
      return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any);
  return calls;
}

const ENVELOPE = {
  ok: false, error: 'forbidden', code: 'admin_only',
  reason: 'SERVER-REASON-4b2', remediation: 'SERVER-REMEDIATION-4b2', gateId: 'bootstrap-admin',
};

const ROUTES: Record<string, Route> = {
  '/api/governance/policies': { body: { ok: true, policies: [] } },
  '/api/lakehouse/containers': { body: { containers: [{ name: 'bronze' }] } },
  '/api/admin/permissions/principals': {
    body: { ok: true, results: [{ id: 'p-oid', type: 'user', displayName: 'Pat', upn: 'pat@x' }] },
  },
};

function renderPage(isTenantAdmin: boolean) {
  return render(
    <SessionProvider value={{ authenticated: true, user: null, isTenantAdmin, loading: false }}>
      <PoliciesPage />
    </SessionProvider>,
  );
}

/** Open the dialog, pick the `bronze` container and the principal Pat. */
async function fillRestrictForm() {
  fireEvent.click(await screen.findByRole('button', { name: 'Restrict access' }));
  const container = await screen.findByRole('combobox', { name: /ADLS container/ });
  await waitFor(() => expect(container).not.toBeDisabled());
  fireEvent.click(container);
  fireEvent.click(await screen.findByRole('option', { name: 'bronze' }));
  fireEvent.change(screen.getByPlaceholderText('name or UPN…'), { target: { value: 'pat' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  fireEvent.click(await screen.findByRole('button', { name: /Pat · pat@x/ }));
  await screen.findByText(/Restricting:/);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Policies page — Restrict access (DLP) is tenant-admin only', () => {
  it('non-admin with a complete form: Revoke access is disabled and the notice names the revoke', async () => {
    // Breaks if `!adminGate.allowed` is dropped from the button's `disabled`:
    // a principal is picked and nothing is busy, so the button would be
    // enabled for this non-admin.
    stubFetch(ROUTES);
    renderPage(false);
    await fillRestrictForm();
    expect(screen.getByRole('button', { name: 'Revoke access' })).toBeDisabled();
    expect(screen.getByTestId('admin-only-notice').textContent).toContain(DLP_RESTRICT_ADMIN_ONLY.reason);
  });

  it('admin: Revoke access is enabled, and a 403 admin_only renders "Tenant admins only", not "Restrict failed"', async () => {
    // Positive pair: breaks if admins are blocked (the button stays disabled
    // and no POST is made). Reactive path: breaks if the `isAdminOnlyRefusal`
    // branch is skipped, because the envelope then falls through to the
    // "Restrict failed (HTTP 403)" error title with the same body text — so
    // this pins the TITLE, not only the text.
    const calls = stubFetch({ ...ROUTES, 'POST /api/governance/dlp/restrict': { status: 403, body: ENVELOPE } });
    renderPage(true);
    await fillRestrictForm();
    expect(screen.queryByTestId('admin-only-notice')).toBeNull();
    const btn = screen.getByRole('button', { name: 'Revoke access' });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    expect(await screen.findByText('Tenant admins only')).toBeInTheDocument();
    expect(screen.getByText(/SERVER-REMEDIATION-4b2/)).toBeInTheDocument();
    expect(screen.queryByText(/Restrict failed/)).toBeNull();
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/api/governance/dlp/restrict'))).toBe(true);
  });
});
