/**
 * powerbi-embed-plan — the guard that stops the report editor asking Power BI
 * for an embed token it cannot mint.
 *
 * THE DEFECT THESE PIN (#2830 sibling class). `/api/items/report` returns the
 * synthetic `loom:<cosmosItemId>` bundle entries FIRST, so the editor
 * auto-selected one and POSTed `/api/items/report/loom%3A…/embed-token` on every
 * open. That id is not a Power BI report id, so Power BI answered 400 — visible
 * in the publish-version E2E capture log of BOTH run 30757747218 (which passed,
 * because nothing asserted on it) and run 30808998681 (which failed, because
 * #2833's `assertNoLoomIdFailures` had landed in between). The product
 * behaviour was byte-identical across the two runs; only the assertion was new.
 *
 * Every test below fails if the `loom:` guard is removed from
 * `planReportEmbedRequest`, EXCEPT the ones marked CONTROL, which pin the
 * unchanged live-Power BI behaviour and must pass with or without the fix.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planReportEmbedRequest, isPowerBiBackedReport } from '../powerbi-embed-plan';

/** The exact id the live E2E captured a 400 on, in both runs. */
const LOOM_ID = 'loom:72d299fe-b642-4f71-a9d0-66c0745c13b3';
/** A real Power BI report id (GUID — can never start with `loom:`). */
const PBI_ID = '058762d5-6cd7-4e32-ab11-04ceda2456de';
const WS = 'a3f1be79-855a-41b6-a719-d9d51e72d473';

describe('planReportEmbedRequest — synthetic `loom:` selections', () => {
  it('issues NO request for a `loom:` report id', () => {
    const { request, skip } = planReportEmbedRequest({
      workspaceId: WS, reportId: LOOM_ID, kind: 'report',
    });
    expect(request).toBeNull();
    expect(skip).toBe('loom-native');
  });

  it('issues NO request for a `loom:` id on the paginated branch either', () => {
    const { request, skip } = planReportEmbedRequest({
      workspaceId: WS, reportId: LOOM_ID, kind: 'paginated', datasetId: 'ds-1',
    });
    expect(request).toBeNull();
    expect(skip).toBe('loom-native');
  });

  it('never produces a URL containing an encoded or raw `loom:` id', () => {
    for (const kind of ['report', 'paginated'] as const) {
      for (const editMode of [false, true]) {
        const { request } = planReportEmbedRequest({
          workspaceId: WS, reportId: LOOM_ID, kind, editMode,
        });
        // The two wire forms the E2E assertion matches on.
        expect(request?.url ?? '').not.toContain('loom%3A');
        expect(request?.url ?? '').not.toContain('loom:');
      }
    }
  });

  it('skips a `loom:` id even when the id is otherwise well-formed', () => {
    // Guard must key on the prefix, not on shape/length heuristics.
    const { skip } = planReportEmbedRequest({
      workspaceId: WS, reportId: 'loom:not-a-guid', kind: 'report',
    });
    expect(skip).toBe('loom-native');
  });
});

describe('planReportEmbedRequest — live Power BI selections (CONTROL)', () => {
  it('CONTROL: builds the standard embed-token request unchanged', () => {
    const { request, skip } = planReportEmbedRequest({
      workspaceId: WS, reportId: PBI_ID, kind: 'report', editMode: false,
    });
    expect(skip).toBeNull();
    expect(request).toEqual({
      url: `/api/items/report/${PBI_ID}/embed-token`,
      body: { workspaceId: WS, accessLevel: 'View' },
    });
  });

  it('CONTROL: editMode selects the Edit access level', () => {
    const { request } = planReportEmbedRequest({
      workspaceId: WS, reportId: PBI_ID, kind: 'report', editMode: true,
    });
    expect(request?.body.accessLevel).toBe('Edit');
  });

  it('CONTROL: paginated routes to the multi-resource token with datasetIds', () => {
    const { request } = planReportEmbedRequest({
      workspaceId: WS, reportId: PBI_ID, kind: 'paginated', datasetId: 'ds-9',
    });
    expect(request).toEqual({
      url: `/api/items/report/${PBI_ID}/paginated-embed-token`,
      body: { workspaceId: WS, datasetIds: ['ds-9'] },
    });
  });

  it('CONTROL: paginated with no dataset sends an empty datasetIds array', () => {
    const { request } = planReportEmbedRequest({
      workspaceId: WS, reportId: PBI_ID, kind: 'paginated',
    });
    expect(request?.body.datasetIds).toEqual([]);
  });

  it('CONTROL: percent-encodes the report id into the path', () => {
    const { request } = planReportEmbedRequest({
      workspaceId: WS, reportId: 'a b/c', kind: 'report',
    });
    expect(request?.url).toBe('/api/items/report/a%20b%2Fc/embed-token');
  });
});

describe('planReportEmbedRequest — nothing selected (CONTROL)', () => {
  it('CONTROL: no workspace ⇒ no request', () => {
    const { request, skip } = planReportEmbedRequest({
      workspaceId: '', reportId: PBI_ID, kind: 'report',
    });
    expect(request).toBeNull();
    expect(skip).toBe('no-workspace');
  });

  it('CONTROL: no report ⇒ no request', () => {
    const { request, skip } = planReportEmbedRequest({
      workspaceId: WS, reportId: '', kind: 'report',
    });
    expect(request).toBeNull();
    expect(skip).toBe('no-selection');
  });
});

describe('isPowerBiBackedReport — gates the Power BI-only ribbon actions', () => {
  it('is false for a synthetic `loom:` selection', () => {
    expect(isPowerBiBackedReport(LOOM_ID)).toBe(false);
  });

  it('CONTROL: is true for a live Power BI report id', () => {
    expect(isPowerBiBackedReport(PBI_ID)).toBe(true);
  });

  it('CONTROL: is false when nothing is selected', () => {
    expect(isPowerBiBackedReport('')).toBe(false);
  });
});

/**
 * STRUCTURAL BINDING — a pure predicate nobody calls is the "control that
 * reports but measures nothing". The behavioural tests above only matter while
 * the editor actually routes its request through the planner, and the editor's
 * embed path lives in a `useEffect` that a unit test cannot reach without
 * rendering the whole Power BI editor tree. These pin the wiring instead: the
 * effect must go through the planner, and must not rebuild the embed-token URL
 * itself (which is exactly how the 400 shipped in the first place).
 */
describe('report-editor wiring', () => {
  const src = readFileSync(join(__dirname, '..', 'report-editor.tsx'), 'utf8');
  // Strip comments so the doc comments in this area cannot satisfy a check.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('routes the embed request through planReportEmbedRequest', () => {
    expect(code).toContain('planReportEmbedRequest({');
  });

  it('does not construct an embed-token URL itself', () => {
    // The planner owns both token URLs; a template literal here means the guard
    // was bypassed.
    expect(code).not.toMatch(/`\/api\/items\/report\/\$\{[^}]+\}\/(paginated-)?embed-token`/);
  });

  it('gates the Power BI-only ribbon actions on isPowerBiBackedReport', () => {
    expect(code).toContain('isPowerBiBackedReport(reportId)');
    // Refresh / Export must not fall back to the mere-presence check.
    expect(code).not.toContain('onClick: hasReport && !refreshBusy');
    expect(code).not.toContain('onClick: hasReport && !exportBusy');
  });
});
