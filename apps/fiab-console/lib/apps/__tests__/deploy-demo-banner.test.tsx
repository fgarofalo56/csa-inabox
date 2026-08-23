/**
 * #3905 — the demo banner must not overstate.
 *
 * "14/14 apps installed · done — open the Demo — workspaces to explore" is the
 * exact string the operator was shown while the lakehouses were empty. These
 * specs render the real component against the real poll route shape and assert:
 *
 *   • REGRESSION — a job whose sub-installs were merely ACCEPTED (a jobId in
 *     hand, nothing confirmed) never renders "14/14 apps installed", even when
 *     the job doc itself claims `status:'done'`. The counts come from the
 *     per-app facts, never from a server-supplied verdict.
 *   • Each terminal state, and a MIXED run, render the REAL counts.
 *   • `unknown` renders AS unknown and is listed with its reason + a way in.
 *   • A demo job that stops advancing is reported as unknown rather than
 *     polled forever (installs are detached promises on a multi-replica app).
 *
 * Placed under lib/apps/__tests__ alongside the orchestrator it verifies (the
 * banner is the render half of the same #3905 work item).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({ clientFetch: (...a: unknown[]) => fetchMock(...a) }));

import { DeployDemoBanner } from '@/lib/components/apps/deploy-demo-banner';
import { SHOWCASE_APPS } from '../demo-deploy';
import type { DemoSubJob, DemoSubStatus } from '../demo-deploy-status';

const TOTAL = SHOWCASE_APPS.length;

function jsonRes(body: unknown, status = 200): Response {
  return { status, ok: status < 400, json: async () => body } as unknown as Response;
}

const subJobs = (states: DemoSubStatus[], patch: Partial<DemoSubJob> = {}): DemoSubJob[] =>
  SHOWCASE_APPS.map(([appId, wsLabel], i) => ({
    appId, wsLabel, workspaceId: `ws-${i}`, installJobId: `ij-${appId}`,
    status: states[i], ...patch,
  }));

const allOf = (s: DemoSubStatus): DemoSubStatus[] => Array.from({ length: TOTAL }, () => s);

/** Mount, click Deploy, and serve `job` from every poll. */
async function deployWith(job: unknown, props: Record<string, number> = {}) {
  fetchMock.mockImplementation(async (url: string, init?: any) => {
    if (url === '/api/demo/deploy' && init?.method === 'POST') return jsonRes({ ok: true, jobId: 'demo-1' });
    if (url === '/api/demo/deploy') return jsonRes({ ok: true, deployed: false, demoWorkspaceCount: 0, totalApps: TOTAL });
    if (url.startsWith('/api/demo/deploy/')) return jsonRes({ ok: true, job });
    return jsonRes({ ok: true });
  });
  render(<DeployDemoBanner pollIntervalMs={1} stallTimeoutMs={60_000} {...props} />);
  const btn = await screen.findByRole('button', { name: /Deploy demo environment/i });
  fireEvent.click(btn);
  return () => screen.getByTestId('demo-deploy-headline').textContent || '';
}

beforeEach(() => { fetchMock.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('DeployDemoBanner — REGRESSION: accepted installs are not installed apps (#3905)', () => {
  it('does NOT claim 14/14 for a job whose sub-installs are only `accepted`', async () => {
    const headline = await deployWith({
      status: 'running', percentComplete: 100, updatedAt: '2026-08-22T00:00:00.000Z',
      subJobs: subJobs(allOf('accepted')),
    });

    await waitFor(() => expect(headline()).toContain('accepted, not started'));
    expect(headline()).not.toMatch(/14\/14 apps installed/);
    expect(headline()).not.toMatch(/open the Demo — workspaces to explore/);
    expect(headline()).toContain(`0/${TOTAL} installed`);
  });

  it('does NOT claim 14/14 even when the JOB DOC says status:done over unconfirmed installs', async () => {
    // The server-side verdict is deliberately wrong here — the banner must
    // still render the per-app truth. This is what makes the surface immune to
    // a rollup regression upstream of it.
    const headline = await deployWith({
      status: 'done', percentComplete: 100, updatedAt: '2026-08-22T00:00:00.000Z',
      subJobs: subJobs(allOf('accepted')),
    });

    await waitFor(() => expect(headline()).toContain(`0/${TOTAL} installed`));
    expect(headline()).not.toMatch(/14\/14 apps installed/);
    // …and it calls the unconfirmed apps out rather than quietly passing.
    const attention = await screen.findByTestId('demo-deploy-attention');
    expect(attention.textContent).toContain(`${TOTAL} apps did not finish as installed`);
    expect(attention.textContent).toContain('Accepted — not started');
  });

  it('unknown renders AS unknown, with the reason and a way into the workspace', async () => {
    const withDetail = subJobs(allOf('unknown'), {
      detail: 'the install job stopped advancing for 300s at phase \'provisioning\' (40%)',
    });
    const headline = await deployWith({
      status: 'partial', percentComplete: 100, updatedAt: '2026-08-22T00:00:00.000Z', subJobs: withDetail,
    });

    await waitFor(() => expect(headline()).toContain(`${TOTAL} unconfirmed`));
    const attention = await screen.findByTestId('demo-deploy-attention');
    expect(attention.textContent).toContain('Unknown — not confirmed');
    expect(attention.textContent).toContain('stopped advancing');
    // G2: a remediation the user can act on, not a bare message.
    expect(screen.getAllByRole('link', { name: /Open workspace/i }).length).toBe(TOTAL);
    expect(screen.getAllByRole('button', { name: /Redeploy/i }).length).toBeGreaterThan(0);
  });
});

describe('DeployDemoBanner — the real counts, per terminal state', () => {
  it('all succeeded → 14/14 apps installed + the explore hint', async () => {
    const headline = await deployWith({
      status: 'done', percentComplete: 100, updatedAt: '2026-08-22T00:00:00.000Z',
      subJobs: subJobs(allOf('succeeded')),
    });

    await waitFor(() => expect(headline()).toContain(`${TOTAL}/${TOTAL} apps installed`));
    expect(headline()).toContain('open the Demo — workspaces to explore');
    expect(screen.queryByTestId('demo-deploy-attention')).toBeNull();
  });

  it('all failed → 0/14 with the failures named, never an install claim', async () => {
    const failed = subJobs(allOf('failed'), { error: 'ADLS write denied for the install identity' });
    const headline = await deployWith({
      status: 'failed', percentComplete: 100, updatedAt: '2026-08-22T00:00:00.000Z', subJobs: failed,
    });

    await waitFor(() => expect(headline()).toContain(`0/${TOTAL} installed`));
    expect(headline()).toContain(`${TOTAL} failed`);
    expect(headline()).not.toMatch(/apps installed/);
    const attention = await screen.findByTestId('demo-deploy-attention');
    expect(attention.textContent).toContain('ADLS write denied for the install identity');
  });

  it('MIXED run renders the real per-outcome counts and lists only what needs attention', async () => {
    const states: DemoSubStatus[] = [
      ...Array.from({ length: 8 }, () => 'succeeded' as DemoSubStatus),
      'partial', 'partial', 'failed', 'failed', 'unknown', 'unknown',
    ];
    const headline = await deployWith({
      status: 'partial', percentComplete: 100, updatedAt: '2026-08-22T00:00:00.000Z',
      subJobs: subJobs(states),
    });

    await waitFor(() => expect(headline()).toContain(`8/${TOTAL} installed`));
    expect(headline()).toBe(`8/${TOTAL} installed · 2 installed with gates · 2 failed · 2 unconfirmed`);
    const attention = await screen.findByTestId('demo-deploy-attention');
    expect(attention.textContent).toContain('6 apps did not finish as installed');
    // The eight that DID succeed are not dragged into the attention list.
    expect(attention.textContent).not.toContain(SHOWCASE_APPS[0][1].replace(/^Demo — /, ''));
    // Every app still appears in the per-app grid with its own state.
    expect(screen.getByTestId('demo-deploy-app-grid').children).toHaveLength(TOTAL);
  });
});

describe('DeployDemoBanner — a frozen deploy is unknown, not an infinite spinner', () => {
  it('stops polling and reports UNKNOWN when the job doc stops advancing', async () => {
    const headline = await deployWith(
      { status: 'running', percentComplete: 50, updatedAt: '2026-08-22T00:00:00.000Z', subJobs: subJobs(allOf('accepted')) },
      { stallTimeoutMs: 10 },
    );

    const lost = await screen.findByTestId('demo-deploy-lost-contact', undefined, { timeout: 5_000 });
    expect(lost.textContent).toContain('Deploy status unknown');
    expect(lost.textContent).toContain('this surface will not guess');
    expect(headline()).not.toMatch(/apps installed/);

    // Polling has stopped: the poll count stops climbing.
    const pollsAt = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('/api/demo/deploy/')).length;
    await new Promise((r) => setTimeout(r, 60));
    const pollsLater = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('/api/demo/deploy/')).length;
    expect(pollsLater).toBe(pollsAt);
  });
});
