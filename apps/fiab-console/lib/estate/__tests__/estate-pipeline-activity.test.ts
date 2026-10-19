/**
 * loadPipelineActivity — the server-side pipeline read for idle auto-pause.
 * Every case names the input that would turn a busy or unknown estate into a
 * clean "no runs" answer (which is what lets auto-pause stop a working estate).
 */
import { describe, it, expect } from 'vitest';
import { loadPipelineActivity, ADF_PAGE_CAP, type PipelineActivityDeps } from '../estate-pipeline-activity';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const run = (minsAgo: number, status = 'Succeeded') => ({ runStart: new Date(NOW - minsAgo * 60_000).toISOString(), status });

function deps(over: Partial<PipelineActivityDeps> = {}): PipelineActivityDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    env: { LOOM_ADF_NAME: 'adf-loom', LOOM_SYNAPSE_WORKSPACE: 'syn-loom' },
    listAdfRuns: async () => { calls.push('adf'); return []; },
    querySynapseRuns: async () => { calls.push('synapse'); return { value: [] }; },
    ...over,
  };
}

describe('loadPipelineActivity', () => {
  it('both sources clean -> ok with zero runs, both named (positive control)', async () => {
    const d = deps();
    const r = await loadPipelineActivity(2, NOW, d);
    expect(r).toEqual({ ok: true, runs: [], sources: ['adf', 'synapse'] });
    expect(d.calls).toEqual(['adf', 'synapse']);
  });

  it('runs from both sources are returned in the policy shape', async () => {
    // Breaks if runStart/status are dropped or renamed on the way out.
    const r = await loadPipelineActivity(2, NOW, deps({
      listAdfRuns: async () => [run(10, 'InProgress')],
      querySynapseRuns: async () => ({ value: [run(30)] }),
    }));
    expect(r.ok).toBe(true);
    expect(r.runs).toEqual([
      { startedAt: run(10).runStart, status: 'InProgress' },
      { startedAt: run(30).runStart, status: 'Succeeded' },
    ]);
  });

  it('a FAILED read is ok:false naming the source, never "no runs"', async () => {
    // The live failure mode: Synapse PublicNetworkAccessDenied. Breaks if the catch returns ok:true.
    const r = await loadPipelineActivity(2, NOW, deps({
      querySynapseRuns: async () => { throw new Error('Forbidden PublicNetworkAccessDenied'); },
    }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^synapse: Forbidden PublicNetworkAccessDenied/);
  });

  it('a listing that may be partial is ok:false (ADF cap, Synapse continuation)', async () => {
    // Breaks if a truncated page is read as the whole window.
    const full = Array.from({ length: ADF_PAGE_CAP }, () => run(500));
    expect((await loadPipelineActivity(2, NOW, deps({ listAdfRuns: async () => full }))).ok).toBe(false);
    expect((await loadPipelineActivity(2, NOW, deps({ listAdfRuns: async () => full.slice(1) }))).ok).toBe(true);
    const cont = await loadPipelineActivity(2, NOW, deps({ querySynapseRuns: async () => ({ value: [], continuationToken: 'x' }) }));
    expect(cont.ok).toBe(false);
    expect(cont.reason).toMatch(/more than one page/);
  });

  it('an unconfigured source is skipped and NOT named; nothing configured is ok with no runs', async () => {
    // Mirrors the runner finding no factory/workspace. Breaks if an absent env var still calls the client.
    const d = deps({ env: { LOOM_SYNAPSE_WORKSPACE: 'syn-loom' } });
    expect(await loadPipelineActivity(2, NOW, d)).toEqual({ ok: true, runs: [], sources: ['synapse'] });
    expect(d.calls).toEqual(['synapse']);
    expect(await loadPipelineActivity(2, NOW, deps({ env: {} }))).toEqual({ ok: true, runs: [], sources: [] });
  });

  it('the Synapse window is the idle window, ending now', async () => {
    // Breaks if the window is hours-vs-days confused (e.g. a 2-DAY lookback for idleHours=2).
    let seen: [string, string] = ['', ''];
    await loadPipelineActivity(2, NOW, deps({ querySynapseRuns: async (a, b) => { seen = [a, b]; return { value: [] }; } }));
    expect(seen).toEqual([new Date(NOW - 2 * 3600e3).toISOString(), new Date(NOW).toISOString()]);
  });

  it('a non-positive window is ok:false without calling anything', async () => {
    const d = deps();
    expect((await loadPipelineActivity(0, NOW, d)).ok).toBe(false);
    expect(d.calls).toEqual([]);
  });
});
