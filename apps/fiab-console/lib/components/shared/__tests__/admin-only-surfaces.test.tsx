/**
 * #4619 — the surfaces that call a tenant-admin-gated verb gate their controls
 * on the shell's admin flag and render the 403 `admin_only` envelope as the
 * AdminOnlyNotice (reason + remediation), not as the bare token "forbidden".
 *
 *   - OneLake lifecycle rules on a SHARED account (PUT is admin-only there);
 *   - the OneLake Secure tab (GET / grant are admin-only);
 *   - the DLP "Restrict access" section (POST is admin-only).
 *
 * Every load-bearing assertion names the input that breaks it. These are
 * presentation tests: the routes are the enforcement point and have their own
 * authz suites.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';

// A one-click stand-in for the Graph-backed picker, so the Restrict button's
// `canRun` reaches its admin term (a null principal disables it regardless).
vi.mock('@/lib/components/ui/identity-picker', () => ({
  IdentityPicker: ({ onSelect }: { onSelect: (h: unknown) => void }) => (
    <button type="button" onClick={() => onSelect({ id: 'p-oid', type: 'user', displayName: 'Pat', upn: 'pat@x' })}>
      pick-principal
    </button>
  ),
}));

import { SessionProvider } from '@/lib/components/session-context';
import { LifecycleRulesPanel } from '@/lib/components/onelake/lifecycle-rules';
import { SecureView } from '@/lib/components/onelake/secure-view';
import { DlpPanel } from '@/lib/components/admin-security/dlp-panel';
import {
  DLP_RESTRICT_ADMIN_ONLY, SECURE_TAB_ADMIN_ONLY, SHARED_LIFECYCLE_ADMIN_ONLY,
} from '@/lib/util/admin-only-copy';

type Route = { status?: number; body: unknown };
type Calls = Array<{ url: string; method: string }>;

/** fetch stub: longest matching key wins; a key may be prefixed "PUT " etc. */
function stubFetch(routes: Record<string, Route | ((url: string) => Route)>): Calls {
  const calls: Calls = [];
  vi.spyOn(global, 'fetch').mockImplementation((async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = (init?.method || 'GET').toUpperCase();
    calls.push({ url, method });
    const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      const [m, path] = k.includes(' ') ? k.split(' ') : ['', k];
      if ((m && m !== method) || !url.includes(path)) continue;
      const r = routes[k];
      const hit = typeof r === 'function' ? r(url) : r;
      return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any);
  return calls;
}

function withSession(isTenantAdmin: boolean, node: ReactNode, loading = false) {
  return (
    <SessionProvider value={{ authenticated: true, user: null, isTenantAdmin, loading }}>
      {node}
    </SessionProvider>
  );
}

const ENVELOPE = {
  ok: false, error: 'forbidden', code: 'admin_only',
  reason: 'SERVER-REASON-7c1', remediation: 'SERVER-REMEDIATION-7c1', gateId: 'bootstrap-admin',
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// ── Lifecycle rules ──────────────────────────────────────────────────────────

const RULE = { name: 'cool-30', enabled: true, conditionField: 'daysAfterModificationGreaterThan', conditionDays: 30, actions: ['tierToCool'] };

function lifecycleGet(accountScope: 'shared' | 'dedicated') {
  return { body: { ok: true, rules: [RULE], ruleCount: 1, maxRules: 10, account: 'acct', accountScope } };
}

describe('LifecycleRulesPanel — shared-account rules are tenant-admin only', () => {
  it('shared account + non-admin: notice shown, Add / Pause / Delete disabled', async () => {
    // Breaks if `readOnly` is dropped from the controls' `disabled` (Delete
    // enabled), or the pre-emptive notice is not rendered.
    stubFetch({ '/api/onelake/lifecycle': lifecycleGet('shared') });
    render(withSession(false, <LifecycleRulesPanel workspaceId="ws1" />));
    const del = await screen.findByRole('button', { name: 'Delete cool-30' });
    expect(del).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pause cool-30' })).toBeDisabled();
    // The Tooltip is relationship="label", so it names the Add button.
    expect(screen.getByRole('button', { name: 'Add a lifecycle rule' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Create from template/ })).toBeDisabled();
    expect(screen.getByTestId('admin-only-notice').textContent).toContain(SHARED_LIFECYCLE_ADMIN_ONLY.remediation);
  });

  it('shared account + tenant admin: controls enabled, no notice (positive pair)', async () => {
    // Breaks if the gate ignores the admin flag (Delete stays disabled).
    stubFetch({ '/api/onelake/lifecycle': lifecycleGet('shared') });
    render(withSession(true, <LifecycleRulesPanel workspaceId="ws1" />));
    expect(await screen.findByRole('button', { name: 'Delete cool-30' })).not.toBeDisabled();
    expect(screen.queryByTestId('admin-only-notice')).toBeNull();
  });

  it('dedicated account + non-admin: controls enabled, no notice', async () => {
    // Breaks if the gate keys on the admin flag alone instead of
    // `accountScope === "shared"` — the owner of a dedicated account must keep
    // their controls.
    stubFetch({ '/api/onelake/lifecycle': lifecycleGet('dedicated') });
    render(withSession(false, <LifecycleRulesPanel workspaceId="ws1" />));
    expect(await screen.findByRole('button', { name: 'Delete cool-30' })).not.toBeDisabled();
    expect(screen.queryByTestId('admin-only-notice')).toBeNull();
  });

  it('a PUT answered with 403 admin_only renders the envelope reason + remediation', async () => {
    // Breaks if persist() renders `j.error` ("forbidden") instead of passing
    // the envelope to the notice.
    const calls = stubFetch({
      'GET /api/onelake/lifecycle': lifecycleGet('dedicated'),
      'PUT /api/onelake/lifecycle': { status: 403, body: ENVELOPE },
    });
    render(withSession(false, <LifecycleRulesPanel workspaceId="ws1" />));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete cool-30' }));
    const notice = await screen.findByTestId('admin-only-notice');
    expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    expect(notice.textContent).toContain('SERVER-REASON-7c1');
    expect(notice.textContent).toContain('SERVER-REMEDIATION-7c1');
    expect(screen.queryByText('forbidden')).toBeNull();
  });
});

// ── Secure tab ───────────────────────────────────────────────────────────────

describe('SecureView — the Secure tab is tenant-admin only', () => {
  it('non-admin: no request to /api/onelake/security, Grant disabled, notice shown', async () => {
    // Breaks if the discovery effect or load() still fires for a non-admin
    // (a request is logged), or Grant stays enabled.
    const calls = stubFetch({ '/api/onelake/security': { body: { ok: true, knownContainers: ['bronze'] } } });
    render(withSession(false, <SecureView workspaces={[]} items={[]} />));
    const notice = await screen.findByTestId('admin-only-notice');
    expect(notice.textContent).toContain(SECURE_TAB_ADMIN_ONLY.remediation);
    expect(screen.getByRole('button', { name: /Grant access/ })).toBeDisabled();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.filter((c) => c.url.includes('/api/onelake/security'))).toEqual([]);
  });

  it('while the shell probe is in flight: no notice and no request yet', async () => {
    // Breaks if the notice keys on `isTenantAdmin` alone (it would flash for
    // an admin whose probe has not resolved).
    const calls = stubFetch({ '/api/onelake/security': { body: { ok: true, knownContainers: ['bronze'] } } });
    render(withSession(false, <SecureView workspaces={[]} items={[]} />, true));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('admin-only-notice')).toBeNull();
    expect(calls.filter((c) => c.url.includes('/api/onelake/security'))).toEqual([]);
  });

  it('admin: loads, and a 403 admin_only on the matrix read renders the envelope', async () => {
    // Positive pair for the request gate (breaks if admins are also blocked:
    // no ?container= request is made) and the reactive path (breaks if the
    // envelope is rendered as "Could not load access matrix: forbidden").
    const calls = stubFetch({
      '/api/onelake/security': (url) => (url.includes('container=')
        ? { status: 403, body: ENVELOPE }
        : { body: { ok: true, knownContainers: ['bronze'] } }),
    });
    render(withSession(true, <SecureView workspaces={[]} items={[]} />));
    const notice = await screen.findByTestId('admin-only-notice');
    expect(notice.textContent).toContain('SERVER-REASON-7c1');
    expect(calls.some((c) => c.url.includes('/api/onelake/security?container=bronze'))).toBe(true);
    expect(screen.queryByText('Could not load access matrix')).toBeNull();
    expect(screen.getByRole('button', { name: /Grant access/ })).not.toBeDisabled();
  });
});

// ── DLP restrict ─────────────────────────────────────────────────────────────

async function openRestrictWithWarehouseScope() {
  fireEvent.click(screen.getByRole('tab', { name: 'Restrict access' }));
  fireEvent.click(await screen.findByRole('combobox', { name: /Scope type/ }));
  fireEvent.click(await screen.findByRole('option', { name: 'Warehouse (Synapse SQL role)' }));
  fireEvent.click(screen.getByRole('button', { name: 'pick-principal' }));
}

describe('DlpPanel Restrict access — tenant-admin only', () => {
  const baseRoutes = {
    '/api/governance/dlp/meta': { body: { ok: true, restrictions: [] } },
    '/api/lakehouse/containers': { body: { containers: [] } },
    '/api/items/by-type': { body: { items: [] } },
  };

  it('non-admin with a complete form: Restrict disabled and the notice names the revoke', async () => {
    // Breaks if `adminGate.allowed` is dropped from `canRun`: the scope needs
    // no ref and a principal is picked, so the button would be enabled.
    stubFetch(baseRoutes);
    render(withSession(false, <DlpPanel />));
    await openRestrictWithWarehouseScope();
    const btn = screen.getAllByRole('button', { name: /Restrict access/ }).find((b) => b.tagName === 'BUTTON' && b.getAttribute('role') !== 'tab')!;
    expect(btn).toBeDisabled();
    expect(screen.getByTestId('admin-only-notice').textContent).toContain(DLP_RESTRICT_ADMIN_ONLY.reason);
  });

  it('admin: Restrict enabled, and a 403 admin_only renders the envelope, not "Restrict failed"', async () => {
    // Positive pair (breaks if admins are blocked: the button stays disabled
    // and no POST is made) and the reactive path (breaks if the envelope
    // falls through to the "Restrict failed: forbidden" error bar).
    const calls = stubFetch({ ...baseRoutes, 'POST /api/governance/dlp/restrict': { status: 403, body: ENVELOPE } });
    render(withSession(true, <DlpPanel />));
    await openRestrictWithWarehouseScope();
    const btn = screen.getAllByRole('button', { name: /Restrict access/ }).find((b) => b.getAttribute('role') !== 'tab')!;
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    const notice = await screen.findByTestId('admin-only-notice');
    expect(notice.textContent).toContain('SERVER-REMEDIATION-7c1');
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/api/governance/dlp/restrict'))).toBe(true);
    expect(screen.queryByText('Restrict failed')).toBeNull();
  });
});
