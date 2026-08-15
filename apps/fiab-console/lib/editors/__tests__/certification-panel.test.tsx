/**
 * CertificationPanel — the honest DQ reason must reach a SCREEN (#3493).
 *
 * The route computed a precise reason the `dq` check was gated — ADX not
 * provisioned, no applicable rules, rules that could not run, never measured —
 * and the panel rendered only `checks[].detail`, whose text comes from the PURE
 * engine (`certification.ts`) and can only ever say:
 *
 *   "No DQ score yet — configure DQ rules and run the contract-quality
 *    enforcement (ADX)."
 *
 * On an estate with twenty rules defined and ADX skipped, that sentence is
 * FALSE, and it is the exact class of message `certification-dq.ts` exists to
 * prevent. `CertResponse` did not even declare `dq`, and the 422 handler read
 * only `blockers[].label`, so `dqGate` never surfaced either.
 *
 * These tests assert the rendered OUTPUT, not the response shape: the measured
 * reason appears, the registry-backed Fix-it appears with it, and the 422 note
 * carries `dqGate`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { CertificationPanel } from '../components/certification-panel';
import { installFetchMock } from './test-helpers';

/** The engine's generic string — true only when the tenant really has no rules. */
const ENGINE_DETAIL = 'No DQ score yet — configure DQ rules and run the contract-quality enforcement (ADX).';
/** What the ROUTE established on an ADX-skipped estate that HAS rules. */
const ADX_GATE = 'Data quality cannot be measured: Azure Data Explorer is not provisioned for this deployment, so the data-quality rules cannot be executed. Certification requires a measured score. (missing LOOM_KUSTO_CLUSTER_URI)';

function certResponse(dq: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    certification: { state: 'draft', score: 66 },
    endorsement: 'none',
    validated: false,
    certifiable: false,
    isCreator: false,
    checks: [
      { id: 'owner', label: 'Owner assigned', pass: true, forValidated: true, detail: '1 owner(s) assigned.' },
      { id: 'dq', label: 'Data-quality score ≥ 70', pass: false, forValidated: false, detail: ENGINE_DETAIL },
    ],
    ...(dq ? { dq } : {}),
    ...extra,
  };
}

function mount(dq: Record<string, unknown> | undefined, handlers: Record<string, (u: string, i?: RequestInit) => unknown> = {}) {
  const mock = installFetchMock({
    '/api/data-products/p1/certification': () => certResponse(dq),
    ...handlers,
  });
  render(<CertificationPanel id="p1" />);
  return mock;
}

describe('CertificationPanel — the measured DQ reason reaches the screen', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders the ROUTE\'s reason in place of the engine\'s generic string', async () => {
    mount({
      score: null, gate: ADX_GATE, gateId: 'svc-adx', missing: ['LOOM_KUSTO_CLUSTER_URI'],
      ruleCount: 0, passingRules: 0, breakdown: [], measuredAt: '2026-08-14T00:00:00.000Z', stale: false,
    });

    // Rendered in BOTH places that owe the user the truth: the gate banner and
    // the `dq` check row.
    await waitFor(() => expect(screen.getAllByText(/Azure Data Explorer is not provisioned/i).length).toBeGreaterThan(0));
    // …and the false one is GONE, not merely accompanied.
    expect(screen.queryByText(ENGINE_DETAIL)).not.toBeInTheDocument();
  });

  it('an INFRA reason renders the registry gate with an inline Fix it (G2)', async () => {
    mount({
      score: null, gate: ADX_GATE, gateId: 'svc-adx', missing: ['LOOM_KUSTO_CLUSTER_URI'],
      ruleCount: 0, passingRules: 0, breakdown: [], measuredAt: null, stale: false,
    });

    await waitFor(() => expect(screen.getByRole('button', { name: /fix it/i })).toBeInTheDocument());
    // The gate names the exact env var the deployment is missing.
    expect(screen.getAllByText('LOOM_KUSTO_CLUSTER_URI').length).toBeGreaterThan(0);
  });

  it('a never-measured product offers the action that measures it, not a dead end', async () => {
    const posted: any[] = [];
    mount(
      {
        score: null, gate: 'Data quality has not been measured for this data product yet. Run "Measure data quality" on the Certification tab (or Rerun DQ check on Data observability) to execute this tenant\'s rules against its tables.',
        gateId: null, missing: [], ruleCount: 0, passingRules: 0, breakdown: [], measuredAt: null, stale: false,
      },
      {
        '/api/data-products/p1/certify': (_u, init) => {
          posted.push(JSON.parse(String(init?.body ?? '{}')));
          return { ok: true, dq: { score: 80, gate: null, ruleCount: 5, passingRules: 4, measuredAt: '2026-08-14T01:00:00.000Z' } };
        },
      },
    );

    const measure = await screen.findByRole('button', { name: /measure data quality/i });
    fireEvent.click(measure);

    await waitFor(() => expect(posted).toEqual([{ action: 'measure-dq' }]));
    await waitFor(() => expect(screen.getByText(/4 of 5 rules passing/i)).toBeInTheDocument());
  });

  it('shows WHEN the score was measured rather than implying "now"', async () => {
    mount({
      score: 75, gate: null, gateId: null, missing: [],
      ruleCount: 4, passingRules: 3, breakdown: [], measuredAt: '2026-08-10T12:00:00.000Z', stale: true,
    });

    await waitFor(() => expect(screen.getByText(/3\/4 rules passing · measured/i)).toBeInTheDocument());
    expect(screen.getByText(/stale — re-measure/i)).toBeInTheDocument();
  });
});

describe('CertificationPanel — a 422 refusal states the DQ reason', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('puts dqGate in the blocked note instead of only the failing labels', async () => {
    installFetchMock({
      '/api/data-products/p1/certification': () => ({
        ...certResponse({
          score: null, gate: ADX_GATE, gateId: null, missing: [],
          ruleCount: 0, passingRules: 0, breakdown: [], measuredAt: null, stale: false,
        }),
        // Certifiable per the client so the button is enabled; the SERVER still
        // refuses — which is the whole point of re-evaluating there.
        certifiable: true,
      }),
      '/api/data-products/p1/certify': () => ({
        ok: false,
        code: 'checks_failed',
        error: 'Cannot certify: automated checks are not all passing.',
        blockers: [{ id: 'dq', label: 'Data-quality score ≥ 70', detail: ENGINE_DETAIL }],
        dqGate: ADX_GATE,
      }),
    });
    render(<CertificationPanel id="p1" />);

    const certify = await screen.findByRole('button', { name: /^certify$/i });
    fireEvent.click(certify);

    await waitFor(() =>
      expect(screen.getByText(/Certification blocked.*Azure Data Explorer is not provisioned/is)).toBeInTheDocument(),
    );
  });
});
