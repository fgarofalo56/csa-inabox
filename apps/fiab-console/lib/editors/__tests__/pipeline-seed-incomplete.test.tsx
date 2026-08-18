/**
 * A FAILED SEED MUST NOT LOOK LIKE A HEALTHY PIPELINE (#3549 review, BLOCKER 1).
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THESE TESTS PIN
 * ---------------------------------------------------------------------------
 * #3549's fix added `seedFromContent`, and with it an honest failure channel:
 * when auto-bind CREATES the backing pipeline but cannot author the item's
 * activity graph into it (an RBAC refusal, a Databricks linked service this
 * estate cannot satisfy), the engine records `autoBind.seedError` and the bind
 * GET keeps the authored `preview` instead of suppressing it.
 *
 * That channel was DEAD. `preview` is rendered at exactly one place in
 * `pipeline-editor-core.tsx`, and that place sits inside the `!bound ||
 * rebinding` branch. An item with a `seedError` IS bound — auto-bind created a
 * real, published pipeline for it — so it takes the BOUND branch and `preview`
 * is never read. Measured on the PR head: `seedError` had ZERO front-end
 * consumers app-wide, and the client-side `AutoBindWire` interface did not even
 * declare the field.
 *
 * Net effect, which is the ORIGINAL #3549 symptom the PR claims to have fixed:
 * a failed seed renders the empty pipeline, reports "0 activities", leaves
 * **Trigger now enabled**, and warns about nothing. Running it succeeds and
 * does nothing.
 *
 * ---------------------------------------------------------------------------
 * WHY EACH TEST WOULD FAIL ON THE PR HEAD
 * ---------------------------------------------------------------------------
 * The first four assert on surface the bound branch never rendered. The gate
 * testid does not exist, the authored activity names are absent from the DOM,
 * and Trigger now is enabled on a pipeline with no activities.
 *
 * The fifth covers the Fix-it itself, and its MEASURED mutation receipts are:
 *   - revert `onRetry` to `() => void loadBinding()` (the PR-head form) → RED
 *     on "3 activities": the gate clears and Run/Debug re-enable, but the
 *     canvas is still showing the pre-seed empty graph (SHOULD-FIX 4).
 *   - revert `specBody` to the `{ ok, spec }` key this file used to send → RED
 *     on the same assertion, because `loadPipeline` reads `data.pipeline`. The
 *     old fixture could not exercise the canvas AT ALL, which is why the
 *     stale-surface defect survived a test whose comment claimed to cover it.
 *
 * CONTROL PAIR — the fourth test runs the opposite direction so the fix cannot
 * overshoot into "always warn": a healthy seeded pipeline shows NO gate and
 * keeps Trigger now enabled.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { AdfPipelineEditor, SynapsePipelineEditor } from '../azure-services-editors';
import { makeItem } from './test-helpers';

const ID = '00000000-0000-0000-0000-0000000000ad';
const BOUND = 'Daily-Batch-Processing-Pipeline';

/** The RBAC refusal `seedPipelineFromContent` reports when ADF rejects the PUT. */
const SEED_ERROR =
  'ADF 403: the Console managed identity needs Data Factory Contributor on adf-loom-default-centralus.';

/** The graph the bundle authored onto `state.content` — what SHOULD be live. */
const AUTHORED_PREVIEW = {
  name: BOUND,
  properties: {
    activities: [
      { name: 'BronzeToSilverDQ', type: 'DatabricksNotebook', typeProperties: { notebookPath: '/Shared/02_stream' } },
      { name: 'GoldAggregation', type: 'DatabricksNotebook', typeProperties: { notebookPath: '/Shared/03_gold' } },
      { name: 'OptimizeGold', type: 'DatabricksNotebook', typeProperties: { notebookPath: '/Shared/04_optimize' } },
    ],
    parameters: {},
  },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * The item's spec GET. The real route
 * (`app/api/items/adf-pipeline/[id]/route.ts`) answers `{ ok, pipeline }` and
 * `loadPipeline` reads `data.pipeline` — this fixture said `spec`, so `setSpec`
 * was fed `JSON.stringify(undefined)` and the canvas rendered nothing on EVERY
 * one of these tests. Nothing noticed, because the only canvas-dependent
 * assertion (Trigger now) is driven by `seedIncomplete`, not by the graph.
 * A fixture that does not model the route it stands in for cannot fail for the
 * reason its comment claims, so it is corrected here and the Retry test below
 * now actually reads the canvas.
 */
function specBody(properties: unknown) {
  return { ok: true, pipeline: { name: BOUND, properties } };
}

/**
 * The live shape of a failed seed: the pipeline EXISTS and is bound, the spec
 * GET returns it with `activities: []`, and the bind GET reports the seedError
 * plus the authored preview.
 */
function installFetch(bindExtras: Record<string, unknown>) {
  vi.spyOn(global, 'fetch').mockImplementation((async (url: any) => {
    const u = String(url);
    if (u.includes(`/api/items/adf-pipeline/${ID}/bind`)) {
      return json({ ok: true, bound: BOUND, pipelines: [{ name: BOUND }], ...bindExtras });
    }
    if (u.includes(`/api/items/adf-pipeline/${ID}/runs`)) return json({ ok: true, runs: [] });
    if (u.includes(`/api/items/adf-pipeline/${ID}/triggers`)) return json({ ok: true, triggers: [] });
    if (u.match(new RegExp(`/api/items/adf-pipeline/${ID}(\\?|$)`))) {
      // The EMPTY twin: a genuinely published pipeline with no activities.
      return json(specBody({ activities: [] }));
    }
    return json({ ok: true });
  }) as any);
}

const renderEditor = () =>
  render(<AdfPipelineEditor item={makeItem('adf-pipeline', 'ADF pipeline')} id={ID} />);

describe('#3549 BLOCKER 1 — a bound-but-unseeded pipeline is never presented as complete', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders an honest gate on the BOUND branch when the seed failed', async () => {
    installFetch({
      autoBind: { status: 'bound', via: 'created', backingName: BOUND, seedError: SEED_ERROR },
      preview: AUTHORED_PREVIEW,
    });

    renderEditor();

    await waitFor(() => expect(screen.getByTestId('pipeline-seed-incomplete')).toBeInTheDocument(),
      { timeout: 8000 });
    // It names the real reason rather than a generic failure.
    expect(document.body.textContent).toContain('Data Factory Contributor');
  });

  it('shows the AUTHORED graph the seed failed to write, so the gap is visible', async () => {
    installFetch({
      autoBind: { status: 'bound', via: 'created', backingName: BOUND, seedError: SEED_ERROR },
      preview: AUTHORED_PREVIEW,
    });

    renderEditor();

    await waitFor(() => expect(screen.getByTestId('pipeline-seed-incomplete')).toBeInTheDocument(),
      { timeout: 8000 });
    // The three activities that SHOULD be live are on screen — this is what
    // makes "the live pipeline is empty" legible instead of silent.
    const body = document.body.textContent || '';
    for (const a of ['BronzeToSilverDQ', 'GoldAggregation', 'OptimizeGold']) {
      expect(body).toContain(a);
    }
  });

  it('DISABLES Trigger now — running an empty pipeline succeeds and does nothing', async () => {
    installFetch({
      autoBind: { status: 'bound', via: 'created', backingName: BOUND, seedError: SEED_ERROR },
      preview: AUTHORED_PREVIEW,
    });

    renderEditor();

    await waitFor(() => expect(screen.getByTestId('pipeline-seed-incomplete')).toBeInTheDocument(),
      { timeout: 8000 });

    const trigger = screen.getByRole('button', { name: /trigger now/i });
    expect(trigger).toBeDisabled();
  });

  it('CONTROL — a HEALTHY seeded pipeline shows no gate and stays runnable', async () => {
    installFetch({
      autoBind: { status: 'bound', via: 'created', backingName: BOUND, seeded: true },
      preview: null,
    });

    renderEditor();

    // Wait for the bound surface (the bound-name badge) rather than the gate.
    await waitFor(() => expect(screen.getAllByText(BOUND).length).toBeGreaterThan(0), { timeout: 8000 });
    expect(screen.queryByTestId('pipeline-seed-incomplete')).toBeNull();

    expect(screen.getByRole('button', { name: /trigger now/i })).not.toBeDisabled();
  });

  it('a SUCCESSFUL Retry seeding clears the gate, re-enables Trigger now, AND refreshes the canvas', async () => {
    // Two defects in one flow.
    //
    // 1. The ribbon is a useMemo. `seedIncomplete` was missing from its
    //    dependency array, so a repaired pipeline kept Run/Debug disabled
    //    forever — the Fix-it would have "worked" while leaving the editor
    //    stuck. Caught by lint, pinned here so it cannot come back silently.
    //
    // 2. (#3549 review, SHOULD-FIX 4) `onRetry` was `() => void loadBinding()`.
    //    That re-runs the SERVER seed and refreshes `autoBind`, so the gate
    //    disappears and the ribbon re-enables — but the canvas reads `spec`,
    //    which only `loadPipeline` refreshes, and the effect that calls it is
    //    keyed on `[bound, …]`. `bound` does not change across a reseed, so
    //    React bails and the canvas keeps rendering `activities: []`. Run and
    //    Debug re-enable over a pipeline the editor is still showing as empty.
    //
    // The activity-count assertion is the one that separates them: it is the
    // ONLY thing here that reads the canvas rather than the gate.
    let seedFailed = true;
    vi.spyOn(global, 'fetch').mockImplementation((async (url: any) => {
      const u = String(url);
      if (u.includes(`/api/items/adf-pipeline/${ID}/bind`)) {
        return json({
          ok: true, bound: BOUND, pipelines: [{ name: BOUND }],
          autoBind: seedFailed
            ? { status: 'bound', via: 'created', backingName: BOUND, seedError: SEED_ERROR }
            : { status: 'bound', via: 'existing', backingName: BOUND, seeded: true },
          preview: seedFailed ? AUTHORED_PREVIEW : null,
        });
      }
      if (u.includes(`/api/items/adf-pipeline/${ID}/runs`)) return json({ ok: true, runs: [] });
      if (u.includes(`/api/items/adf-pipeline/${ID}/triggers`)) return json({ ok: true, triggers: [] });
      if (u.match(new RegExp(`/api/items/adf-pipeline/${ID}(\\?|$)`))) {
        // Before the reseed the live pipeline is the empty twin; after it, the
        // factory holds the authored graph.
        return json(specBody(seedFailed ? { activities: [] } : AUTHORED_PREVIEW.properties));
      }
      return json({ ok: true });
    }) as any);

    renderEditor();

    await waitFor(() => expect(screen.getByTestId('pipeline-seed-incomplete')).toBeInTheDocument(),
      { timeout: 8000 });
    expect(screen.getByRole('button', { name: /trigger now/i })).toBeDisabled();
    // The bound-state badge counts what the CANVAS holds: nothing, so far.
    expect(screen.getByText('0 activities')).toBeInTheDocument();

    // The operator grants the role; the engine's re-seed succeeds on reload.
    seedFailed = false;
    fireEvent.click(screen.getByRole('button', { name: /retry seeding/i }));

    await waitFor(() => expect(screen.queryByTestId('pipeline-seed-incomplete')).toBeNull(),
      { timeout: 8000 });
    await waitFor(() => expect(screen.getByRole('button', { name: /trigger now/i })).not.toBeDisabled(),
      { timeout: 8000 });
    // …and the surface the user is looking at caught up with the repair, rather
    // than offering Run over a canvas that still says the pipeline is empty.
    await waitFor(() => expect(screen.getByText('3 activities')).toBeInTheDocument(),
      { timeout: 8000 });
  });
});

/**
 * PARITY — the Synapse twin. Both editors drive the SAME `PipelineEditorCore`,
 * and the Synapse bind route carries the identical `seedIncomplete` logic, so
 * the gate must appear on both surfaces. This repo has a recorded incident
 * where a pipeline fix landed on one canvas and not its twin, so the pair is
 * asserted mechanically rather than assumed.
 */
describe('#3549 BLOCKER 1 — the Synapse twin carries the same gate', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders the seed-incomplete gate for a Synapse pipeline too', async () => {
    vi.spyOn(global, 'fetch').mockImplementation((async (url: any) => {
      const u = String(url);
      if (u.includes(`/api/items/synapse-pipeline/${ID}/bind`)) {
        return json({
          ok: true, bound: BOUND, pipelines: [{ name: BOUND }],
          autoBind: { status: 'bound', via: 'created', backingName: BOUND, seedError: SEED_ERROR },
          preview: AUTHORED_PREVIEW,
        });
      }
      if (u.includes(`/api/items/synapse-pipeline/${ID}/runs`)) return json({ ok: true, runs: [] });
      if (u.includes(`/api/items/synapse-pipeline/${ID}/triggers`)) return json({ ok: true, triggers: [] });
      if (u.match(new RegExp(`/api/items/synapse-pipeline/${ID}(\\?|$)`))) {
        return json({ ok: true, pipeline: { name: BOUND, properties: { activities: [] } } });
      }
      return json({ ok: true });
    }) as any);

    render(<SynapsePipelineEditor item={makeItem('synapse-pipeline', 'Synapse pipeline')} id={ID} />);

    await waitFor(() => expect(screen.getByTestId('pipeline-seed-incomplete')).toBeInTheDocument(),
      { timeout: 8000 });
    expect(screen.getByRole('button', { name: /trigger now/i })).toBeDisabled();
  });
});
