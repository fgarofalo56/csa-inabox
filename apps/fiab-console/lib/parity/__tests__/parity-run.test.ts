import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock handles for the runtime halves the orchestrator wires together.
const h = vi.hoisted(() => ({
  visionMock: vi.fn(),
  planMock: vi.fn(),
  fileMock: vi.fn(),
  upsertMock: vi.fn(async (d: any) => ({ resource: d })),
}));

// Mock the AOAI vision + plan-model runtime (unit-level; the PURE parse/shape
// wiring in parity-run stays real).
vi.mock('@/lib/parity/parity-vision', async () => {
  const actual = await vi.importActual<any>('@/lib/parity/parity-vision');
  return {
    ...actual,
    runParityVisionDiff: h.visionMock,
    proposeParityFixPlan: h.planMock,
  };
});
// Mock the GitHub filer.
vi.mock('@/lib/parity/parity-issue', () => ({
  fileParityGapIssue: h.fileMock,
}));
// Mock Cosmos so persistRun/listParityRuns don't need a real account.
vi.mock('@/lib/azure/cosmos-client', () => ({
  parityAutopilotRunsContainer: async () => ({
    items: { upsert: h.upsertMock, query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  }),
}));

import { runParityAutopilot } from '@/lib/parity/parity-run';

const DOC = `# report — parity
Route: \`/items/report\`

| # | Capability | Status | Notes |
|---|---|---|---|
| 1 | Load | built | x |
| 2 | Pages | built | y |
`;

describe('runParityAutopilot (wiring)', () => {
  beforeEach(() => {
    h.visionMock.mockReset();
    h.planMock.mockReset();
    h.fileMock.mockReset();
    h.upsertMock.mockClear();
  });

  it('parses the doc, runs the diff, plans + files each gap, and persists a run doc', async () => {
    h.visionMock.mockResolvedValue({
      checked: 2,
      verdicts: [],
      gaps: [{ num: '2', capability: 'Pages', evidence: 'no pages panel' }],
    });
    h.planMock.mockResolvedValue({ summary: 'Add pages panel', steps: [{ title: 'render' }] });
    h.fileMock.mockResolvedValue({ filed: true, issueNumber: 7, issueUrl: 'https://x/7' });

    const run = await runParityAutopilot({
      slug: 'report',
      docMarkdown: DOC,
      imageBase64: 'AAAA',
      ranBy: 'tester',
    });

    expect(run.checked).toBe(2);
    expect(run.gapCount).toBe(1);
    expect(run.route).toBe('/items/report');
    // plan-model called once per gap.
    expect(h.planMock).toHaveBeenCalledTimes(1);
    // issue filed once per gap; the outcome captured the real filer result.
    expect(h.fileMock).toHaveBeenCalledTimes(1);
    expect(run.gaps[0].plan?.summary).toBe('Add pages panel');
    expect(run.gaps[0].issue?.issueNumber).toBe(7);
    // run doc persisted.
    expect(h.upsertMock).toHaveBeenCalledTimes(1);
    expect(h.upsertMock.mock.calls[0][0].slug).toBe('report');
  });

  it('does NOT file issues in dry-run, but still plans + persists', async () => {
    h.visionMock.mockResolvedValue({ checked: 2, verdicts: [], gaps: [{ num: '2', capability: 'Pages', evidence: 'gone' }] });
    h.planMock.mockResolvedValue({ summary: 'fix', steps: [] });

    const run = await runParityAutopilot({ slug: 'report', docMarkdown: DOC, imageBase64: 'AAAA', ranBy: 't', dryRun: true });
    expect(h.fileMock).not.toHaveBeenCalled();
    expect(run.gaps[0].issue).toBeUndefined();
    expect(run.gaps[0].plan?.summary).toBe('fix');
    expect(h.upsertMock).toHaveBeenCalledTimes(1);
  });

  it('records an honest gate (not a throw) when the vision diff gates', async () => {
    const { NoAoaiDeploymentError } = await vi.importActual<any>('@/lib/parity/parity-vision');
    h.visionMock.mockRejectedValue(new NoAoaiDeploymentError('no AOAI vision deployment'));

    const run = await runParityAutopilot({ slug: 'report', docMarkdown: DOC, imageBase64: 'AAAA', ranBy: 't' });
    expect(run.gated).toBe(true);
    expect(run.gateReason).toContain('no AOAI vision deployment');
    expect(run.gapCount).toBe(0);
    expect(h.upsertMock).toHaveBeenCalledTimes(1); // still persisted
  });

  it('files with a placeholder plan when plan-model itself gates (gap never dropped)', async () => {
    h.visionMock.mockResolvedValue({ checked: 1, verdicts: [], gaps: [{ num: '1', capability: 'Load', evidence: 'blank' }] });
    h.planMock.mockRejectedValue(new Error('plan model down'));
    h.fileMock.mockResolvedValue({ filed: true, issueNumber: 9 });

    const run = await runParityAutopilot({ slug: 'report', docMarkdown: DOC, imageBase64: 'AAAA', ranBy: 't' });
    expect(run.gaps[0].planError).toContain('plan-model failed');
    // still filed the gap (with the error surfaced in the issue body upstream).
    expect(h.fileMock).toHaveBeenCalledTimes(1);
    expect(run.gaps[0].issue?.issueNumber).toBe(9);
  });
});
