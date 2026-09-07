/**
 * TokenBudgetPanel → the budget-scope picker's FAILURE states (vitest, jsdom).
 *
 * #3742 round 3 (PR #4348 review). Round 2 repointed the workspace list at the
 * tenant-wide `/api/admin/workspaces`, which made 403 and 500 REACHABLE states
 * carrying a specific remediation. Three defects followed, and each is held
 * here by the state that produced it:
 *
 *   1. The workspace queryFn discarded `ok:false`, so a 403 and a 500 both
 *      landed as `raw = []` and the Field claimed "No workspace is available" —
 *      an ABSENCE THE CODE NEVER ESTABLISHED (deploy-integrity R7), with the
 *      route's own `reason` (the bootstrap-admin deploy defect) thrown away.
 *   2. `listUnavailable` ORed the error in, so a failed AGENT-REGISTRY read
 *      replaced a populated picker with a bare <Input> even though the LEDGER
 *      agents had loaded fine — and the "Pick from the list instead" escape is
 *      gated on typedIdMode, so the rows that did load were unreachable.
 *   3. The registry-gate hint sat BELOW listUnavailable in the ternary, so with
 *      Foundry unconfigured AND no agent having spent yet it was unreachable in
 *      exactly the state it was written for: the hint contradicted the gate the
 *      same response carried. That is the cloud-parity case — a boundary with
 *      no Foundry agent service reads as "no agents exist".
 *
 * `fetch` is stubbed with the routes' VERBATIM bodies (the 403 from
 * app/api/admin/workspaces/route.ts, the 500 from lib/api/respond.ts
 * `apiServerError`, the gate from app/api/admin/agent-quality/route.ts) so
 * these exercise the real client wiring, per no-vaporware.md.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TokenBudgetPanel } from '../token-budget-panel';

/** VERBATIM from app/api/admin/workspaces/route.ts GET, the non-admin branch. */
const WORKSPACES_403 = {
  ok: false,
  error: 'forbidden',
  reason:
    'Tenant-wide workspace inventory is admin-only. Ask an existing tenant ' +
    'admin to grant you the Admin role at /admin/permissions. If nobody in ' +
    'the tenant can open that page either, this deployment shipped without a ' +
    'bootstrap-admin binding (deploy parameter loomTenantAdminGroupId, wired ' +
    'from the FIAB_ADMIN_GROUP_ID repo variable) — a deploy defect the ' +
    'platform must fix, not a value for you to set on the container app.',
  code: 'admin_only',
  gateId: 'bootstrap-admin',
};

/** VERBATIM from lib/api/respond.ts `apiServerError` (the route's catch). */
const WORKSPACES_500 = { ok: false, error: 'internal error', code: 'internal_error' };

const WORKSPACES_OK = {
  ok: true,
  total: 1,
  workspaces: [{ id: 'ws-1', name: 'Analytics' }],
};

/** VERBATIM shape from app/api/admin/agent-quality/route.ts, Foundry unconfigured. */
const AGENT_QUALITY_GATED = {
  ok: true,
  agents: {
    configured: false,
    list: [],
    gate: {
      code: 'not_configured',
      error: 'Microsoft Foundry agents are not configured for this deployment.',
      hint: 'Set LOOM_FOUNDRY_PROJECT_ENDPOINT.',
      missing: 'LOOM_FOUNDRY_PROJECT_ENDPOINT',
    },
  },
  redTeam: { items: [] },
  slo: { targets: [], evaluations: [], window: {} },
};

const AGENT_QUALITY_500 = { ok: false, error: 'internal error', code: 'internal_error' };

const AGENT_QUALITY_OK = {
  ok: true,
  agents: { configured: true, list: [{ name: 'registry-agent' }] },
  redTeam: { items: [] },
  slo: { targets: [], evaluations: [], window: {} },
};

const BUDGETS_EMPTY = {
  ok: true,
  flagEnabled: true,
  rows: [],
  totals: { tokens: 0, usd: 0, turns: 0, over: 0, warning: 0 },
};

/** One agent the ATTRIBUTION LEDGER has already seen — `knownAgents` fodder. */
const BUDGETS_WITH_LEDGER_AGENT = {
  ok: true,
  flagEnabled: true,
  rows: [
    {
      scope: 'agent',
      scopeId: 'sql-helper',
      label: 'SQL helper',
      budget: null,
      usage: null,
      verdict: null,
    },
  ],
  totals: { tokens: 0, usd: 0, turns: 0, over: 0, warning: 0 },
};

function installFetch(opts: { workspaces?: [unknown, number]; agentQuality?: [unknown, number]; budgets?: unknown }) {
  const [wsBody, wsStatus] = opts.workspaces ?? [WORKSPACES_OK, 200];
  const [aqBody, aqStatus] = opts.agentQuality ?? [AGENT_QUALITY_OK, 200];
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (body: unknown, status: number) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) as Response;
    if (url.includes('/api/admin/workspaces')) return json(wsBody, wsStatus);
    if (url.includes('/api/admin/agent-quality')) return json(aqBody, aqStatus);
    if (url.includes('/api/admin/copilot-quality/budgets')) return json(opts.budgets ?? BUDGETS_EMPTY, 200);
    return json({ ok: true }, 200);
  });
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <FluentProvider theme={webLightTheme}>
      <QueryClientProvider client={qc}>
        <TokenBudgetPanel />
      </QueryClientProvider>
    </FluentProvider>,
  );
}

/**
 * Open the "New budget" dialog (the only state where the pickers are live).
 * `getAllByRole(...)[0]` deliberately: the guided EmptyState renders its own
 * "New budget" CTA alongside the toolbar's, so a singular query is ambiguous in
 * exactly the empty-ledger fixture two of these cases need. Settling on the
 * Scope field (which exists only inside the dialog) proves it actually opened.
 */
async function openNewBudget() {
  renderPanel();
  const open = await waitFor(() => {
    const buttons = screen.getAllByRole('button', { name: /New budget/i });
    expect(buttons.length).toBeGreaterThan(0);
    return buttons[0];
  });
  fireEvent.click(open);
  return screen.findByRole('combobox', { name: 'Scope' });
}

/** Flip the Scope dropdown to `agent`. */
async function selectAgentScope() {
  fireEvent.click(screen.getByRole('combobox', { name: 'Scope' }));
  fireEvent.click(await screen.findByRole('option', { name: 'agent' }));
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('budget scope picker — a failed list is reported, never rendered as an absence', () => {
  it('a 403 from /api/admin/workspaces surfaces the route reason, not "no workspace is available"', async () => {
    vi.stubGlobal('fetch', installFetch({ workspaces: [WORKSPACES_403, 403] }));
    await openNewBudget();

    // The route's own remediation reaches the operator verbatim.
    await waitFor(() =>
      expect(screen.getByText(/this deployment shipped without a bootstrap-admin binding/i)).toBeInTheDocument());
    // …and the claim the code could not establish is NOT made.
    expect(screen.queryByText(/No workspace is available/i)).toBeNull();
  });

  it('a 500 from /api/admin/workspaces surfaces the failure, not "no workspace is available"', async () => {
    vi.stubGlobal('fetch', installFetch({ workspaces: [WORKSPACES_500, 500] }));
    await openNewBudget();

    await waitFor(() => expect(screen.getByText(/internal error/i)).toBeInTheDocument());
    expect(screen.queryByText(/No workspace is available/i)).toBeNull();
  });

  it('a failed AGENT-REGISTRY read keeps the ledger agents pickable (error ≠ empty list)', async () => {
    vi.stubGlobal('fetch', installFetch({
      agentQuality: [AGENT_QUALITY_500, 500],
      budgets: BUDGETS_WITH_LEDGER_AGENT,
    }));
    await openNewBudget();
    await selectAgentScope();

    // The rows that DID load stay behind a real picker…
    const dd = await screen.findByRole('combobox', { name: 'Agent' });
    expect(screen.queryByRole('textbox', { name: 'Agent' })).toBeNull();
    fireEvent.click(dd);
    expect(await screen.findByRole('option', { name: 'SQL helper' })).toBeInTheDocument();
    // …and the registry failure is still disclosed rather than swallowed.
    expect(screen.getByText(/internal error/i)).toBeInTheDocument();
  });

  it('an UNCONFIGURED Foundry registry with no ledger agents names the gate, never "no agent is registered"', async () => {
    // cloud-parity: a boundary with no Foundry agent service must not read as
    // "you have no agents" — the registry is what is unavailable.
    vi.stubGlobal('fetch', installFetch({
      agentQuality: [AGENT_QUALITY_GATED, 200],
      budgets: BUDGETS_EMPTY,
    }));
    await openNewBudget();
    await selectAgentScope();

    await waitFor(() =>
      expect(screen.getByText(/Microsoft Foundry agents are not configured for this deployment/i)).toBeInTheDocument());
    expect(screen.queryByText(/No agent is registered or has been attributed any spend yet/i)).toBeNull();
  });

  it('a healthy workspace list still picks, and still offers the typed-id escape', async () => {
    // Positive control: the failure assertions above are only meaningful if the
    // happy path genuinely populates through the same code.
    vi.stubGlobal('fetch', installFetch({}));
    await openNewBudget();

    const dd = await screen.findByRole('combobox', { name: 'Workspace' });
    fireEvent.click(dd);
    expect(await screen.findByRole('option', { name: 'Analytics' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Enter an id…' })).toBeInTheDocument();
  });
});
