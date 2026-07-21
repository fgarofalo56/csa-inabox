import { describe, it, expect } from 'vitest';
import {
  parseParityDoc,
  normalizeStatus,
  expectedBuiltRows,
  resolveSurfaceRoute,
  buildVisionDiffMessages,
  parseVisionDiff,
  buildFixPlanMessages,
  parseFixPlan,
  shapeGapIssue,
  gapIssueFingerprint,
  fingerprintMarker,
  PARITY_AUTOPILOT_LABEL,
  MAX_PLAN_STEPS,
  type ParityInventory,
  type ParityRow,
  type ParityGap,
} from '../parity-autopilot';

const SAMPLE_DOC = `# report — parity with Power BI report (service viewer)

Source UI: Power BI service report viewer — https://learn.microsoft.com/power-bi
Route: \`/items/report\`

## Loom coverage

| # | Capability | Status | Notes |
|---|---|---|---|
| 1 | Report definition load | built | GET /api/items/report/[id] |
| 2 | Page navigation | built | Pages panel + ribbon |
| 3 | Bookmarks | honest-gate | requires a Power BI workspace |
| 4 | Comments | ❌ | not built yet |
| 5 | Export to PDF | missing | follow-up |

## Power BI feature inventory (OPT-IN)

| # | Capability | Where in Power BI |
|---|---|---|
| 1 | Workspace list | Workspace content list |
`;

describe('normalizeStatus', () => {
  it('maps built / present tokens', () => {
    expect(normalizeStatus('built')).toBe('built');
    expect(normalizeStatus('✅')).toBe('built');
    expect(normalizeStatus('Done')).toBe('built');
  });
  it('maps honest-gate / partial tokens', () => {
    expect(normalizeStatus('honest-gate')).toBe('honest-gate');
    expect(normalizeStatus('⚠️')).toBe('honest-gate');
    expect(normalizeStatus('partial')).toBe('honest-gate');
  });
  it('maps missing tokens', () => {
    expect(normalizeStatus('missing')).toBe('missing');
    expect(normalizeStatus('❌')).toBe('missing');
    expect(normalizeStatus('not built')).toBe('missing');
  });
  it('returns unknown for prose / empty', () => {
    expect(normalizeStatus('')).toBe('unknown');
    expect(normalizeStatus('some notes here')).toBe('unknown');
  });
});

describe('parseParityDoc', () => {
  const inv = parseParityDoc(SAMPLE_DOC, 'report');

  it('extracts title, route, source', () => {
    expect(inv.title).toContain('report');
    expect(inv.route).toBe('/items/report');
    expect(inv.source).toContain('Power BI service report viewer');
  });

  it('parses coverage rows with normalized status, skipping the header + the inventory table (no status column)', () => {
    // 5 coverage rows; the "Power BI feature inventory" table has no status cell → skipped.
    expect(inv.rows).toHaveLength(5);
    const byNum = Object.fromEntries(inv.rows.map((r) => [r.num, r]));
    expect(byNum['1'].status).toBe('built');
    expect(byNum['1'].capability).toBe('Report definition load');
    expect(byNum['3'].status).toBe('honest-gate');
    expect(byNum['4'].status).toBe('missing');
    expect(byNum['5'].status).toBe('missing');
  });

  it('carries the notes cell', () => {
    const r1 = inv.rows.find((r) => r.num === '1')!;
    expect(r1.notes).toContain('GET /api/items/report');
  });

  it('is defensive on empty / malformed input', () => {
    expect(parseParityDoc('', 'x').rows).toHaveLength(0);
    expect(parseParityDoc('# just a title', 'x').rows).toHaveLength(0);
  });
});

describe('expectedBuiltRows', () => {
  it('returns only built rows — the claims the vision pass must verify', () => {
    const inv = parseParityDoc(SAMPLE_DOC, 'report');
    const built = expectedBuiltRows(inv);
    expect(built.map((r) => r.num)).toEqual(['1', '2']);
  });
});

describe('resolveSurfaceRoute', () => {
  it('prefers an explicit override', () => {
    const inv: ParityInventory = { slug: 'x', title: 'X', route: '/a', rows: [] };
    expect(resolveSurfaceRoute(inv, '/b')).toBe('/b');
  });
  it('falls back to the doc route', () => {
    const inv: ParityInventory = { slug: 'x', title: 'X', route: '/a', rows: [] };
    expect(resolveSurfaceRoute(inv, '')).toBe('/a');
  });
  it('returns null when neither is a real route', () => {
    const inv: ParityInventory = { slug: 'x', title: 'X', rows: [] };
    expect(resolveSurfaceRoute(inv, 'not-a-route')).toBeNull();
  });
});

describe('buildVisionDiffMessages', () => {
  const rows: ParityRow[] = [
    { num: '1', capability: 'Report load', status: 'built' },
    { num: '2', capability: 'Page nav', status: 'built' },
  ];
  const msgs = buildVisionDiffMessages({
    inventory: { title: 'Report', slug: 'report' },
    rows,
    imageDataUrl: 'data:image/png;base64,AAAA',
  });

  it('produces a system + a multimodal user turn with the image part', () => {
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
    const parts = msgs[1].content as Array<Record<string, unknown>>;
    expect(Array.isArray(parts)).toBe(true);
    const img = parts.find((p) => p.type === 'image_url') as any;
    expect(img.image_url.url).toContain('data:image/png;base64,');
    const text = (parts.find((p) => p.type === 'text') as any).text as string;
    expect(text).toContain('1. Report load');
    expect(text).toContain('2. Page nav');
  });
});

describe('parseVisionDiff', () => {
  const rows: ParityRow[] = [
    { num: '1', capability: 'Report load', status: 'built' },
    { num: '2', capability: 'Page nav', status: 'built' },
    { num: '3', capability: 'Refresh', status: 'built' },
  ];

  it('derives gaps from present=false verdicts and joins by num', () => {
    const raw = { verdicts: [
      { num: '1', present: true, evidence: 'canvas visible' },
      { num: '2', present: false, evidence: 'no pages panel' },
    ] };
    const { verdicts, gaps } = parseVisionDiff(raw, rows);
    expect(verdicts).toHaveLength(3);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].num).toBe('2');
    expect(gaps[0].evidence).toBe('no pages panel');
  });

  it('defaults omitted rows to present (conservative — no false gap)', () => {
    const { gaps } = parseVisionDiff({ verdicts: [{ num: '1', present: true }] }, rows);
    expect(gaps).toHaveLength(0); // 2 and 3 omitted → treated as present
  });

  it('drops verdicts for unknown nums and tolerates junk', () => {
    const { verdicts, gaps } = parseVisionDiff({ verdicts: [{ num: '99', present: false }, null, 'x'] as any }, rows);
    expect(verdicts).toHaveLength(3);
    expect(gaps).toHaveLength(0);
  });

  it('is defensive on null / missing verdicts', () => {
    expect(parseVisionDiff(null, rows).gaps).toHaveLength(0);
    expect(parseVisionDiff({}, rows).verdicts).toHaveLength(3);
  });
});

describe('buildFixPlanMessages', () => {
  it('builds a system + user turn naming the gap + surface', () => {
    const gap: ParityGap = { num: '2', capability: 'Page nav', evidence: 'no panel' };
    const msgs = buildFixPlanMessages(gap, { title: 'Report', slug: 'report' });
    expect(msgs[0].role).toBe('system');
    expect(String(msgs[1].content)).toContain('Page nav');
    expect(String(msgs[1].content)).toContain('report');
  });
});

describe('parseFixPlan', () => {
  it('normalizes summary + steps + files + effort', () => {
    const plan = parseFixPlan({
      summary: 'Expose the pages panel',
      steps: [{ title: 'Add panel', detail: 'render ReportPages' }, 'Wire ribbon'],
      suggestedFiles: ['lib/editors/report.tsx', ''],
      effort: 'm',
    });
    expect(plan.summary).toBe('Expose the pages panel');
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]).toEqual({ title: 'Add panel', detail: 'render ReportPages' });
    expect(plan.steps[1]).toEqual({ title: 'Wire ribbon' });
    expect(plan.suggestedFiles).toEqual(['lib/editors/report.tsx']);
    expect(plan.effort).toBe('M');
  });

  it('caps steps + is defensive on junk', () => {
    const many = { steps: Array.from({ length: 20 }, (_, i) => ({ title: `s${i}` })) };
    expect(parseFixPlan(many).steps).toHaveLength(MAX_PLAN_STEPS);
    const empty = parseFixPlan(null);
    expect(empty.summary).toBeTruthy();
    expect(empty.steps).toHaveLength(0);
  });
});

describe('gapIssueFingerprint + shapeGapIssue', () => {
  const inventory = { title: 'Report', slug: 'report', source: 'PBI', route: '/items/report' };
  const gap: ParityGap = { num: '2', capability: 'Page navigation', evidence: 'no pages panel visible', notes: 'ribbon page picker' };
  const plan = { summary: 'Render the pages panel', steps: [{ title: 'Add ReportPages', detail: 'left tree' }] };

  it('fingerprint is stable slug#num', () => {
    expect(gapIssueFingerprint('report', '2')).toBe('parity-autopilot:report#2');
  });

  it('shapes a titled, labelled, fingerprinted issue with the plan + evidence', () => {
    const shaped = shapeGapIssue({ inventory, gap, plan });
    expect(shaped.labels).toEqual([PARITY_AUTOPILOT_LABEL]);
    expect(shaped.fingerprint).toBe('parity-autopilot:report#2');
    expect(shaped.title).toContain('report');
    expect(shaped.title).toContain('Page navigation');
    // body carries the hidden dedupe marker, the evidence, and the plan step.
    expect(shaped.body).toContain(fingerprintMarker(shaped.fingerprint));
    expect(shaped.body).toContain('no pages panel visible');
    expect(shaped.body).toContain('Render the pages panel');
    expect(shaped.body).toContain('Add ReportPages');
    expect(shaped.body).toContain('docs/fiab/parity/report.md');
  });

  it('handles an empty plan (plan-model gated) without throwing', () => {
    const shaped = shapeGapIssue({ inventory, gap, plan: { summary: 'no plan', steps: [] } });
    expect(shaped.body).toContain('_(no steps proposed)_');
  });
});
