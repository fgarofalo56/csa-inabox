/**
 * The access-request inbox — what an approver sees after a decision, and how
 * a request's grant scopes are listed.
 *
 * Each assertion names the value that breaks it:
 *
 *   - A denial that returns a warning (grants it kept) closes the dialog and
 *     shows the warning on the page with a link to the Access report. Breaks
 *     if the dialog stays open on that warning (the "Deny request" title is
 *     still in the document and a second Deny would only conflict), or if the
 *     link is dropped or points elsewhere.
 *   - An approval that returns a warning keeps the dialog open, because the
 *     request is still open and a retry is legitimate. Breaks if the close is
 *     applied to every warning.
 *   - A scope with no store yet shows the store its port declared. Breaks if
 *     the label ignores `declaredRef` (the row would read just the type).
 *   - Two scope rows with the same type, store and source render without a
 *     duplicate-key warning. Breaks if the key drops the row index.
 *   - The Access-report link is offered only to a tenant admin. Breaks if the
 *     link renders for a non-admin (the link would be found), or if the
 *     non-admin line is dropped (its text would be missing) or shown twice
 *     beside a server warning that already says it (two matches).
 *   - A final approval refused with 409 `targets_changed` shows both lists and
 *     offers a denial prefilled with the server's suggested reason. Breaks if a
 *     list is not rendered (its rows would be missing), if the button is not
 *     offered, or if Deny sends any other reason than the suggested one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import type { ReactElement } from 'react';

const fetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({ clientFetch: (...a: unknown[]) => fetchMock(...a) }));

import { AccessRequestInboxEditor, KEPT_GRANTS_ADMIN_NOTE } from '../access-request-inbox';
import { SessionProvider } from '@/lib/components/session-context';

function asUser(ui: ReactElement, isTenantAdmin: boolean) {
  return render(
    <SessionProvider value={{ authenticated: true, user: null, isTenantAdmin, loading: false }}>{ui}</SessionProvider>,
  );
}

function jsonRes(body: unknown, status = 200): Response {
  return { status, ok: status < 400, json: async () => body } as unknown as Response;
}

const KEPT = 'Denied. 1 grant was kept: adls-container gold (No role-assignment id was recorded for this grant, so it could not be revoked automatically.)';

function request(patch: Record<string, unknown> = {}) {
  return {
    id: 'r1', assetId: 'a1', assetName: 'Sales product', itemType: 'data-product',
    scopeType: 'adls-container', scopeRef: 'gold', permission: 'read', justification: 'reporting',
    requesterUpn: 'req@contoso.com', requestedAt: '2026-09-01T00:00:00.000Z',
    tier: 'manager', status: 'open', ...patch,
  };
}

/** Serve `req` in the Manager tier and answer the decision POST with `decisionBody`. */
function serve(req: Record<string, unknown>, decisionBody: unknown) {
  fetchMock.mockImplementation(async (url: string, init?: any) => {
    if (url === '/api/access-requests/r1/decision' && init?.method === 'POST') return jsonRes(decisionBody);
    if (url === '/api/access-requests?tier=manager&status=open') return jsonRes({ ok: true, requests: [req] });
    return jsonRes({ ok: true, requests: [] });
  });
}

beforeEach(() => { fetchMock.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('after a decision that returns a warning', () => {
  it('a denial that kept grants closes the dialog and links the Access report', async () => {
    serve(request(), { ok: true, status: 'denied', warning: KEPT });
    asUser(<AccessRequestInboxEditor />, true);
    await screen.findByText('Sales product');
    fireEvent.click(screen.getByRole('button', { name: /^Deny — close with a reason$/ }));
    expect(await screen.findByText('Deny request')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Why is this request denied?'), { target: { value: 'no longer needed' } });
    fireEvent.click(screen.getByRole('button', { name: /^Deny$/ }));

    // Breaks if the dialog stays open on the warning: its title stays in the document.
    await waitFor(() => expect(screen.queryByText('Deny request')).not.toBeInTheDocument());
    expect(screen.getByText(KEPT)).toBeInTheDocument();
    expect(screen.getByText(/Request for Sales product denied — some access was kept/)).toBeInTheDocument();
    // Breaks if the link is dropped or points anywhere but the report tab.
    expect(screen.getByRole('link', { name: 'Open the Access report' })).toHaveAttribute('href', '/admin/access-governance?tab=report');
    const posts = fetchMock.mock.calls.filter(([u, i]) => u === '/api/access-requests/r1/decision' && i?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1].body)).toEqual({ decision: 'denied', reason: 'no longer needed' });
  });

  it('an approval that returns a warning keeps the dialog open for a retry, with no report notice', async () => {
    const pending = 'The grant is pending: the store is not bound yet.';
    serve(request(), { ok: true, warning: pending });
    render(<AccessRequestInboxEditor />);
    await screen.findByText('Sales product');
    fireEvent.click(screen.getByRole('button', { name: /^Approve — advance to the next tier$/ }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Approve$/ }));

    // Breaks if the close were applied to every warning: the dialog would be gone.
    expect(await within(dialog).findByText(pending)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open the Access report' })).not.toBeInTheDocument();
  });
});

describe('the Access report is offered only to a tenant admin', () => {
  async function denyAs(isTenantAdmin: boolean, warning: string) {
    serve(request(), { ok: true, status: 'denied', warning });
    asUser(<AccessRequestInboxEditor />, isTenantAdmin);
    await screen.findByText('Sales product');
    fireEvent.click(screen.getByRole('button', { name: /^Deny — close with a reason$/ }));
    fireEvent.change(await screen.findByPlaceholderText('Why is this request denied?'), { target: { value: 'no' } });
    fireEvent.click(screen.getByRole('button', { name: /^Deny$/ }));
    await screen.findByText(/Request for Sales product denied — some access was kept/);
  }

  it('a non-admin sees who can act instead of the link', async () => {
    await denyAs(false, KEPT);
    expect(screen.queryByRole('link', { name: 'Open the Access report' })).not.toBeInTheDocument();
    expect(screen.getByText(KEPT_GRANTS_ADMIN_NOTE)).toBeInTheDocument();
  });

  it('a non-admin is not told twice when the warning already says it', async () => {
    await denyAs(false, `${KEPT}. ${KEPT_GRANTS_ADMIN_NOTE}`);
    expect(screen.queryByRole('link', { name: 'Open the Access report' })).not.toBeInTheDocument();
    // Positive pair: the sentence is on the page exactly once, inside the warning.
    expect(screen.getAllByText((content) => content.includes(KEPT_GRANTS_ADMIN_NOTE))).toHaveLength(1);
  });
});

describe('a final approval refused because the storage changed', () => {
  const SUGGESTED = 'The storage behind "Sales product" changed after you requested access, so this request cannot be approved as reviewed. Please request access again.';
  const REFUSAL = {
    ok: false,
    code: 'targets_changed',
    error: '"Sales product" is not bound to the storage that was reviewed. Approving it would grant access nobody reviewed.',
    changes: [{ cause: 'port_rebound' }],
    reviewed: [{ scopeType: 'adls-container', scopeRef: 'gold', source: "output port 'gold-out'", declaredRef: 'gold' }],
    current: [{ scopeType: 'adls-container', scopeRef: 'silver', source: "output port 'gold-out'", declaredRef: 'silver' }],
    suggestedDenyReason: SUGGESTED,
  };

  it('shows what was reviewed and what is bound now, and denies with the suggested reason', async () => {
    fetchMock.mockImplementation(async (url: string, init?: any) => {
      if (url === '/api/access-requests/r1/decision' && init?.method === 'POST') {
        return JSON.parse(init.body).decision === 'denied' ? jsonRes({ ok: true, status: 'denied' }) : jsonRes(REFUSAL, 409);
      }
      if (url === '/api/access-requests?tier=manager&status=open') return jsonRes({ ok: true, requests: [request({ tier: 'access-provider' })] });
      return jsonRes({ ok: true, requests: [] });
    });
    asUser(<AccessRequestInboxEditor />, false);
    await screen.findByText('Sales product');
    fireEvent.click(screen.getByRole('button', { name: /^Approve — advance to the next tier$/ }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Approve & grant$/, hidden: true }));

    expect(await within(dialog).findByText(REFUSAL.error)).toBeInTheDocument();
    const lists = within(dialog).getByLabelText('Storage recorded when requested and bound now');
    // Breaks if the column is titled "Reviewed when requested" again: for a
    // request made before targets were recorded nothing reviewed that scope.
    expect(within(lists).getByText('Recorded when requested')).toBeInTheDocument();
    expect(within(lists).queryByText('Reviewed when requested')).not.toBeInTheDocument();
    expect(within(lists).getByText("adls-container · gold (output port 'gold-out')")).toBeInTheDocument();
    expect(within(lists).getByText('Bound now')).toBeInTheDocument();
    expect(within(lists).getByText("adls-container · silver (output port 'gold-out')")).toBeInTheDocument();

    // hidden: true on the role queries inside the dialog from here on. In some
    // runs of the full spec set, tabster's modalizer marks the open
    // DialogSurface itself aria-hidden="true" under jsdom, and it stays that
    // way: waiting 5 s did not clear it. The same pattern is used in
    // stored-function-editor.test.tsx. This test pins the denial flow (the
    // button, the prefilled reason, the POST), not the accessibility tree.
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Deny with this reason', hidden: true }));
    expect(await within(dialog).findByDisplayValue(SUGGESTED)).toBeInTheDocument();
    fireEvent.click(await within(dialog).findByRole('button', { name: /^Deny$/, hidden: true }));
    // hidden: true here too. Without it a dialog that stayed open but hidden
    // reads as closed, and this check could not fail.
    await waitFor(() => expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument());

    const posts = fetchMock.mock.calls
      .filter(([u, i]) => u === '/api/access-requests/r1/decision' && i?.method === 'POST')
      .map(([, i]) => JSON.parse(i.body));
    expect(posts).toEqual([{ decision: 'approved' }, { decision: 'denied', reason: SUGGESTED }]);
  });

  it('offers no prefilled denial for any other refusal', async () => {
    // Breaks if the button were shown for every failed approval.
    fetchMock.mockImplementation(async (url: string, init?: any) => {
      if (url === '/api/access-requests/r1/decision' && init?.method === 'POST') return jsonRes({ ok: false, code: 'grant_in_progress', error: 'Another decision is granting.' }, 409);
      if (url === '/api/access-requests?tier=manager&status=open') return jsonRes({ ok: true, requests: [request({ tier: 'access-provider' })] });
      return jsonRes({ ok: true, requests: [] });
    });
    asUser(<AccessRequestInboxEditor />, false);
    await screen.findByText('Sales product');
    fireEvent.click(screen.getByRole('button', { name: /^Approve — advance to the next tier$/ }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Approve & grant$/, hidden: true }));
    expect(await within(dialog).findByText('Another decision is granting.')).toBeInTheDocument();
    // hidden: true, or an aria-hidden surface (see the test above) would hide
    // the button and this absence check could not fail. The test above is its
    // positive pair: the button is there for targets_changed.
    expect(within(dialog).queryByRole('button', { name: 'Deny with this reason', hidden: true })).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Storage recorded when requested and bound now')).not.toBeInTheDocument();
    // Focus goes to the refusal message itself. Pinned by ELEMENT, not text: an
    // ancestor (the body, the dialog surface) also contains the text, so a
    // textContent check could not fail. Breaks if no focus move follows a
    // refusal (activeElement is the disabled submit, the surface or the body).
    const bar = within(dialog).getByText('Another decision is granting.').closest('[tabindex="-1"]');
    expect(bar).not.toBeNull();
    expect(bar).not.toBe(dialog);
    await waitFor(() => expect(document.activeElement).toBe(bar));
  });

  it('keeps keyboard focus in the dialog: on Deny with this reason after the 409, then on the reason after it', async () => {
    // Reviewer B measured focus on BODY at both points. Breaks if the 409 does
    // not move focus to the offered action (activeElement is the submit button
    // that disabled itself, or the body), or if switching to a denial leaves it
    // on the unmounted button (activeElement is the body, not the textarea).
    fetchMock.mockImplementation(async (url: string, init?: any) => {
      if (url === '/api/access-requests/r1/decision' && init?.method === 'POST') return jsonRes(REFUSAL, 409);
      if (url === '/api/access-requests?tier=manager&status=open') return jsonRes({ ok: true, requests: [request({ tier: 'access-provider' })] });
      return jsonRes({ ok: true, requests: [] });
    });
    asUser(<AccessRequestInboxEditor />, false);
    await screen.findByText('Sales product');
    fireEvent.click(screen.getByRole('button', { name: /^Approve — advance to the next tier$/ }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Approve & grant$/, hidden: true }));
    const denyInstead = await within(dialog).findByRole('button', { name: 'Deny with this reason', hidden: true });
    await waitFor(() => expect(document.activeElement).toBe(denyInstead));
    fireEvent.click(denyInstead);
    const reasonBox = await within(dialog).findByDisplayValue(SUGGESTED);
    await waitFor(() => expect(document.activeElement).toBe(reasonBox));
  });
});

describe('opening the inbox on one request (?request=, the Access report link)', () => {
  afterEach(() => { window.history.replaceState({}, '', '/'); });

  it('opens the request on its own tier, expanded and marked current', async () => {
    // Breaks if the parameter is ignored: the inbox stays on Manager, the
    // Approver list is never fetched and no row is marked current.
    window.history.replaceState({}, '', '/governance/access-requests?request=r9');
    const r9 = request({ id: 'r9', assetName: 'Linked product', tier: 'approver' });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/access-requests?status=open') return jsonRes({ ok: true, requests: [request(), r9] });
      if (url === '/api/access-requests?tier=approver&status=open') return jsonRes({ ok: true, requests: [r9] });
      return jsonRes({ ok: true, requests: [] });
    });
    render(<AccessRequestInboxEditor />);
    const name = await screen.findByText('Linked product');
    const row = name.closest('tr')!;
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(within(row).getByRole('button', { name: 'Collapse details' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { selected: true }).textContent).toContain('Approver');
  });

  it('opens a closed request under History', async () => {
    // Breaks if only open requests were searched (the request is not found).
    window.history.replaceState({}, '', '/governance/access-requests?request=r7');
    const r7 = request({ id: 'r7', assetName: 'Closed product', status: 'denied', deniedAt: '2026-09-02T00:00:00.000Z' });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/access-requests?status=denied') return jsonRes({ ok: true, requests: [r7] });
      return jsonRes({ ok: true, requests: [] });
    });
    render(<AccessRequestInboxEditor />);
    const row = (await screen.findByText('Closed product')).closest('tr')!;
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('tab', { selected: true }).textContent).toContain('History');
  });

  it('says when the linked request is not found, and when it could not be looked up', async () => {
    // Breaks if a miss were silent, or if a failed lookup were reported as
    // "not found" (a claim the inbox did not establish).
    window.history.replaceState({}, '', '/governance/access-requests?request=gone');
    fetchMock.mockImplementation(async () => jsonRes({ ok: true, requests: [] }));
    const first = render(<AccessRequestInboxEditor />);
    expect(await screen.findByText("Request gone is not among this tenant's open, completed or denied requests.")).toBeInTheDocument();
    first.unmount();
    fetchMock.mockImplementation(async (url: string) => (
      url === '/api/access-requests?status=open' ? jsonRes({ ok: false, error: 'store unavailable' }, 503) : jsonRes({ ok: true, requests: [] })));
    render(<AccessRequestInboxEditor />);
    expect(await screen.findByText('Request gone could not be looked up: store unavailable')).toBeInTheDocument();
  });
});

describe('grant scopes in the request detail', () => {
  it('shows the declared store of an unbound port, and renders repeated scopes without a key clash', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    serve(request({
      grantTargets: [
        { scopeType: 'adls-container', scopeRef: '', declaredRef: 'gold', source: 'port gold-out' },
        { scopeType: 'adls-container', scopeRef: 'silver', source: 'port silver-out' },
        { scopeType: 'adls-container', scopeRef: 'silver', source: 'port silver-out' },
      ],
    }), { ok: true });
    render(<AccessRequestInboxEditor />);
    await screen.findByText('Sales product');
    fireEvent.click(screen.getByRole('button', { name: 'Expand details' }));

    // Breaks if the label ignores declaredRef: the row would read only 'adls-container'.
    expect(await screen.findByText("adls-container · declared 'gold', not bound yet")).toBeInTheDocument();
    // Positive pair: both bound rows render.
    expect(screen.getAllByText('adls-container · silver')).toHaveLength(2);
    // Breaks if the key drops the index: React reports two children with the same key.
    const clash = errors.mock.calls.filter((c) => /same key/i.test(c.map(String).join(' ')));
    expect(clash).toEqual([]);
  });
});
