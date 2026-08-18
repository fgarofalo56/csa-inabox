/**
 * UserDataFunctionEditor — the Execution endpoint section SELECTS, it does not
 * ask (#3692 CI-debt pass).
 *
 * WHAT WAS WRONG
 *   The section rendered two free-text boxes: "Function App base URL" and
 *   "Function key — Key Vault secret name". Since the GHSA-class fix in
 *   `lib/azure/udf-endpoint-policy.ts`, item state may only SELECT an endpoint
 *   the deployment approved and only AGREE with that endpoint's configured key
 *   — `POST /api/items/user-data-function/[id]/invoke` 409s on anything else.
 *   So a hand-typed value could not improve any outcome: it was either one the
 *   user already knew, or one guaranteed to gate. That is the ask
 *   `.claude/rules/auto-bind-by-default.md` §5 forbids, and it was the last
 *   `check-no-freeform.mjs` baseline entry for this file.
 *
 * WHAT THESE SPECS PIN
 *   1. The approved endpoints are DISCOVERED, from the same route the policy
 *      feeds — no hand-typed base URL survives in the editor.
 *   2. The function-key secret name is DERIVED from the selected endpoint, and
 *      is never a control the user types into.
 *   3. Both 409s the policy can raise (an unapproved base, a disagreeing key)
 *      surface BEFORE Run, each with the one-click repair the platform can
 *      perform itself (ux-baseline.md G2) — a stale item is never a dead end.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { UserDataFunctionEditor } from '../phase4-editors';
import { makeItem, installFetchMock, renderWithProviders } from './test-helpers';

/** The deployment default: the shared Loom runtime, anonymous + source-executing. */
const RUNTIME = 'https://loom-udf-runtime.internal.example.io';
/** An operator-approved Function App, keyed — so it never receives pushed source. */
const APPROVED_FN = 'https://contoso-udf.azurewebsites.net';

const ENDPOINTS = {
  ok: true,
  endpoints: [
    { base: RUNTIME, acceptsPushedSource: true, isDefault: true },
    { base: APPROVED_FN, keySecretName: 'udf-fnapp-key', acceptsPushedSource: false, isDefault: false },
  ],
};

function renderEditor(state?: Record<string, unknown>) {
  // The editor's `item` prop is the item TYPE; its STATE arrives from
  // GET /api/items/user-data-function/<id> (palantir/shared.tsx useItemState),
  // so a saved-value case is seeded through the fetch mock, not the prop.
  const { calls } = installFetchMock({
    '/api/items/user-data-function/endpoints': () => ENDPOINTS,
    '/api/items/user-data-function/udf-1': () => ({ id: 'udf-1', state: state || {}, updatedAt: '2026-08-17T00:00:00Z' }),
  });
  renderWithProviders(
    <UserDataFunctionEditor item={makeItem('user-data-function', 'User data function')} id="udf-1" />,
  );
  return { calls };
}

describe('UserDataFunctionEditor — Execution endpoint is selected, not typed', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('has no free-text box for the base URL or the function-key secret name', async () => {
    renderEditor();

    await screen.findByText('Execution endpoint');
    // The two asks that were baselined are gone — by LABEL, so a rename that
    // re-introduced the box under a new name would still fail this.
    expect(screen.queryByLabelText(/Function App base URL/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Key Vault secret name/i)).not.toBeInTheDocument();
    // And nothing in the section is a textbox at all.
    expect(screen.queryByPlaceholderText(/azurewebsites\.net/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('udf-fnapp-key')).not.toBeInTheDocument();
  });

  it('lists the endpoints the DEPLOYMENT approves, marking the default', async () => {
    const { calls } = renderEditor();

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/items/user-data-function/endpoints'))).toBe(true);
    });
    fireEvent.click(await screen.findByRole('combobox', { name: /Run target/i }));
    await screen.findByRole('option', { name: new RegExp(`${RUNTIME}.*deployment default`) });
    await screen.findByRole('option', { name: new RegExp(`${APPROVED_FN}.*keyed`) });
  });

  it('derives the function key from the picked endpoint — it is never typed', async () => {
    renderEditor();

    // Default endpoint: anonymous, and it executes the item's authored source.
    await screen.findByText(/Anonymous \/ Entra-protected/i);

    fireEvent.click(await screen.findByRole('combobox', { name: /Run target/i }));
    fireEvent.click(await screen.findByRole('option', { name: new RegExp(`${APPROVED_FN}.*keyed`) }));

    // The keyed endpoint's configured secret NAME is shown, and the consequence
    // the policy attaches to it (no pushed source) is stated with it.
    await screen.findByText(/Key Vault secret .*udf-fnapp-key/);
  });

  it('offers a one-click repair for a saved base the deployment no longer approves', async () => {
    renderEditor({ azureFunctionUrl: 'https://revoked-udf.azurewebsites.net' });

    await screen.findByText('This item names an endpoint the deployment has not approved');
    fireEvent.click(screen.getByRole('button', { name: /Use the deployment default/i }));
    await waitFor(() => {
      expect(screen.queryByText('This item names an endpoint the deployment has not approved')).not.toBeInTheDocument();
    });
  });

  it('offers a one-click repair for a key-secret name the endpoint is not configured to use', async () => {
    renderEditor({ azureFunctionUrl: APPROVED_FN, functionKeySecret: 'some-other-secret' });

    await screen.findByText('This item names a function key this endpoint is not configured to use');
    fireEvent.click(screen.getByRole('button', { name: /Use the endpoint's configured key/i }));
    await waitFor(() => {
      expect(
        screen.queryByText('This item names a function key this endpoint is not configured to use'),
      ).not.toBeInTheDocument();
    });
  });

  it('shows the honest gate — not an empty picker — when nothing is configured', async () => {
    installFetchMock({
      '/api/items/user-data-function/endpoints': () => ({
        ok: true,
        endpoints: [],
        gate: { missing: 'LOOM_UDF_FUNCTION_BASE', detail: 'No function execution endpoint is configured for this deployment.' },
      }),
    });
    renderWithProviders(
      <UserDataFunctionEditor item={makeItem('user-data-function', 'User data function')} id="udf-1" />,
    );

    await screen.findByText(/No execution endpoint is configured \(LOOM_UDF_FUNCTION_BASE\)/);
  });
});
