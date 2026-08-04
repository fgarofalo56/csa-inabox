/**
 * ADF pipeline editor — first open must never be a raw JSON blob (#2895).
 *
 * The reported surface showed a RED card containing an unformatted ARM
 * response body (`{"code":"NotFound","message":"… does not exist.","target":
 * "/subscriptions/…"}`) while the adjacent explorer pane calmly said
 * "Pipelines (0) · + New pipeline" — one region saying "create one", the next
 * saying "ERROR".
 *
 * A `NotFound` for a pipeline that has not been published yet is an EXPECTED
 * state (`ux-baseline.md`: "unconfigured states are guided, never red"), and a
 * genuine failure must be a MessageBar naming the remediation, never a
 * stringified response body (`no-vaporware.md`).
 *
 * CONTROL PAIR — these run in both directions so the fix cannot overshoot into
 * "swallow errors":
 *   missing  → guided warning + Fix-it, canvas renders, NO error bar
 *   genuine  → the error bar STILL renders
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { AdfPipelineEditor } from '../azure-services-editors';
import { makeItem } from './test-helpers';

const ID = '00000000-0000-0000-0000-0000000000ad';
const BOUND = 'ingest_orders';

/** The verbatim ARM body the client used to hand straight to the MessageBar.
 *  Placeholder ids only — this repo is public. */
const RAW_ARM_404 =
  'getPipeline(ingest_orders) failed 404: {"code":"NotFound","message":"The Pipeline ' +
  "'ingest_orders' does not exist.\",\"target\":\"/subscriptions/00000000-0000-0000-0000-000000000000" +
  '/resourceGroups/rg-example/providers/Microsoft.DataFactory/factories/adf-example/pipelines/ingest_orders"}';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** `specResponse` is what GET /api/items/adf-pipeline/<id> returns. */
function installPipelineFetch(specResponse: () => Response) {
  vi.spyOn(global, 'fetch').mockImplementation((async (url: any) => {
    const u = String(url);
    if (u.includes(`/api/items/adf-pipeline/${ID}/bind`)) {
      return json({ ok: true, bound: BOUND, pipelines: [{ name: BOUND }] });
    }
    if (u.includes(`/api/items/adf-pipeline/${ID}/runs`)) return json({ ok: true, runs: [] });
    if (u.includes(`/api/items/adf-pipeline/${ID}/triggers`)) return json({ ok: true, triggers: [] });
    if (u.match(new RegExp(`/api/items/adf-pipeline/${ID}(\\?|$)`))) return specResponse();
    return json({ ok: true });
  }) as any);
}

const renderEditor = () =>
  render(<AdfPipelineEditor item={makeItem('adf-pipeline', 'ADF pipeline')} id={ID} />);

describe('AdfPipelineEditor — bound-but-not-published first open (#2895)', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders a GUIDED state, not a red error, and never the response body', async () => {
    installPipelineFetch(() => json({
      ok: false, code: 'pipeline-missing', pipelineName: BOUND,
      error: `The Data Factory has no pipeline named "${BOUND}" yet.`,
    }, 404));

    renderEditor();

    await waitFor(() => expect(screen.getByTestId('pipeline-missing-gate')).toBeInTheDocument(),
      { timeout: 8000 });

    const body = document.body.textContent || '';
    // No stringified response body, and no estate path fragments.
    expect(body).not.toContain('"code":"NotFound"');
    expect(body).not.toContain('/subscriptions/');
    expect(body).not.toContain('adf-example');
    // No red backend-failure bar for an expected state.
    expect(screen.queryByText(/Pipeline API — error/i)).toBeNull();
    // G2: the gate carries an inline Fix-it, not just a complaint.
    expect(screen.getByRole('button', { name: /rebind or create/i })).toBeInTheDocument();
  });

  it('the CANVAS still renders — the not-found branch does not short-circuit it', async () => {
    installPipelineFetch(() => json({
      ok: false, code: 'pipeline-missing', pipelineName: BOUND,
      error: `The Data Factory has no pipeline named "${BOUND}" yet.`,
    }, 404));

    renderEditor();

    await waitFor(() => expect(screen.getByTestId('pipeline-missing-gate')).toBeInTheDocument(),
      { timeout: 8000 });
    // The pipeline configurations tab row is live (the editor's own "Activities"
    // tab; the designer contributes its own "Activities (n)" tab further in).
    expect(screen.getByRole('tab', { name: 'Activities' })).toBeInTheDocument();
    // …and the designer shell itself actually mounted — this is the assertion
    // that would have caught "the canvas never appears".
    expect(document.querySelector('[data-pipeline-designer]')).not.toBeNull();
    expect(screen.getAllByRole('tab', { name: /activities/i }).length).toBeGreaterThan(1);
  });

  it('CONTROL — a GENUINE backend failure still surfaces as an error bar', async () => {
    installPipelineFetch(() => json({ ok: false, error: RAW_ARM_404 }, 502));

    renderEditor();

    await waitFor(() => expect(screen.getByText(/Pipeline API — error/i)).toBeInTheDocument(),
      { timeout: 8000 });
    // Still says what went wrong…
    expect(document.body.textContent).toContain('does not exist');
    // …but not as a raw body, and not with the ARM path.
    expect(document.body.textContent).not.toContain('"code":"NotFound"');
    expect(document.body.textContent).not.toContain('/subscriptions/');
    // And it is NOT mistaken for the guided state.
    expect(screen.queryByTestId('pipeline-missing-gate')).toBeNull();
  });
});
