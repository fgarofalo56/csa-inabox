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
import { DataPipelineEditor } from '../data-pipeline-editor';
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
    //    stuck.
    //
    //    THIS TEST DOES NOT PIN THAT. Measured: remove `seedIncomplete` from
    //    the dep array at `pipeline-editor-core.tsx` and this spec still passes
    //    6/6. The reason is `save = useCallback(…, [apiBase, bound, spec])` —
    //    the retry below changes `spec` (empty document → authored graph), so
    //    `save`'s identity changes, so the memo recomputes whatever the dep
    //    list says. The dep is pinned by the CONTROL further down, which holds
    //    `spec` byte-identical so `seedIncomplete` is the only mover.
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

  it('CONTROL — the ribbon re-enables when seedIncomplete is the ONLY thing that changed', async () => {
    // THE DEPENDENCY-ARRAY CONTROL (#3549 review round 3).
    //
    // The test above cannot see whether `seedIncomplete` is in the ribbon's
    // `useMemo` dependency list, and I claimed it could. Measured: remove the
    // dep and that spec still passes 6/6, because its retry changes `spec`
    // (empty document → authored graph) and `save` is
    // `useCallback(…, [apiBase, bound, spec])`, so the memo recomputes off a
    // changed callback identity no matter what the dep list says. A receipt
    // that does not reproduce is worse than no receipt, so here is one that
    // does.
    //
    // This models the OTHER real repair shape, the one `maybeRepairSeed`
    // produces when `isEmpty` reports the backing object already holds content:
    // the record flips to `seeded:true` and `seedError` clears, while the
    // pipeline DOCUMENT was never empty and does not change. The spec route
    // therefore returns a BYTE-IDENTICAL body across the retry, `setSpec` bails
    // on the Object.is check, `save` keeps its identity, and `busy` / `bound` /
    // `dirty` / every other ribbon dep is unchanged. `seedIncomplete` is the
    // only mover, so the memo MUST list it or the ribbon stays stale.
    //
    // MUTATION PROOF (measured): drop `seedIncomplete` from the dep array at
    // `pipeline-editor-core.tsx` → this test RED ("Trigger now" stays disabled
    // forever), the other five still green.
    let seedFailed = true;
    vi.spyOn(global, 'fetch').mockImplementation((async (url: any) => {
      const u = String(url);
      if (u.includes(`/api/items/adf-pipeline/${ID}/bind`)) {
        return json({
          ok: true, bound: BOUND, pipelines: [{ name: BOUND }],
          autoBind: seedFailed
            ? { status: 'bound', via: 'created', backingName: BOUND, seedError: SEED_ERROR }
            : { status: 'bound', via: 'existing', backingName: BOUND, seeded: true },
          // `preview` is not a ribbon dependency, so it may move freely.
          preview: seedFailed ? AUTHORED_PREVIEW : null,
        });
      }
      if (u.includes(`/api/items/adf-pipeline/${ID}/runs`)) return json({ ok: true, runs: [] });
      if (u.includes(`/api/items/adf-pipeline/${ID}/triggers`)) return json({ ok: true, triggers: [] });
      if (u.match(new RegExp(`/api/items/adf-pipeline/${ID}(\\?|$)`))) {
        // IDENTICAL both times — this is what makes the control a control.
        return json(specBody(AUTHORED_PREVIEW.properties));
      }
      return json({ ok: true });
    }) as any);

    renderEditor();

    await waitFor(() => expect(screen.getByTestId('pipeline-seed-incomplete')).toBeInTheDocument(),
      { timeout: 8000 });
    const before = screen.getByRole('button', { name: /trigger now/i });
    expect(before).toBeDisabled();
    // The canvas already holds the graph, and it will not change across the
    // retry — so nothing but `seedIncomplete` can drive the ribbon. (Two nodes
    // match while the gate is up: the bound-state badge and the authored-graph
    // panel the gate renders beneath itself.)
    expect(screen.getAllByText('3 activities').length).toBeGreaterThan(0);

    seedFailed = false;
    fireEvent.click(screen.getByRole('button', { name: /retry seeding/i }));

    await waitFor(() => expect(screen.queryByTestId('pipeline-seed-incomplete')).toBeNull(),
      { timeout: 8000 });
    await waitFor(() => expect(screen.getByRole('button', { name: /trigger now/i })).not.toBeDisabled(),
      { timeout: 8000 });
    // The canvas is unchanged, which is the point: the ribbon moved on its own.
    expect(screen.getByText('3 activities')).toBeInTheDocument();
  });

  it('BLOCKER 2 — Add trigger is refused too, so the empty pipeline cannot be SCHEDULED', async () => {
    // Review round 3. `Add trigger` gated on `!bound` alone, and `bound` is true
    // BY DEFINITION whenever `seedIncomplete` is — so it sat enabled next to a
    // correctly-greyed Run and Debug. From it a schedule trigger puts the empty
    // pipeline on a recurrence: every run returns Succeeded having executed
    // nothing, unattended and repeating. That is strictly worse than the single
    // manual trigger the original fix blocked, and it was found by enumerating
    // the pipeline-invoking controls rather than reading the one that was fixed.
    installFetch({
      autoBind: { status: 'bound', via: 'created', backingName: BOUND, seedError: SEED_ERROR },
      preview: AUTHORED_PREVIEW,
    });

    renderEditor();

    await waitFor(() => expect(screen.getByTestId('pipeline-seed-incomplete')).toBeInTheDocument(),
      { timeout: 8000 });
    const addTrigger = screen.getByRole('button', { name: /add trigger/i });
    expect(addTrigger).toBeDisabled();
  });

  it('CONTROL — Add trigger is live on a healthy pipeline', async () => {
    // Without this, "disabled" above would also pass against a button that is
    // disabled unconditionally.
    installFetch({
      autoBind: { status: 'bound', via: 'created', backingName: BOUND, seeded: true },
      preview: null,
    });

    renderEditor();

    await waitFor(() => expect(screen.getAllByText(BOUND).length).toBeGreaterThan(0), { timeout: 8000 });
    expect(screen.getByRole('button', { name: /add trigger/i })).not.toBeDisabled();
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

/**
 * #3755 — THE TWO PATHS `PipelineEditorCore` NEVER SEES.
 *
 * `data-pipeline-editor.tsx` delegates to the (gated) core for the mainline open:
 *
 *     const hostTemplate = !!templateId;
 *     if (!hostTemplate && (runtime === 'adf' || runtime === 'synapse')) { …core… }
 *
 * so the gate #3696 added is live for the common case. It does NOT delegate for a
 * TEMPLATED create (`templateId` set) or for the opt-in `runtime === 'fabric'`, and on
 * those two paths this file's own Run / Debug / Schedule / Add-trigger controls were
 * reachable with `grep -c seedIncomplete` = 0 across the whole editor. A pipeline with no
 * activities could be run, debugged, and — worst — put on a RECURRENCE, every execution
 * reporting Succeeded having done nothing.
 *
 * The specs below drive the real editor on both of those paths. They are deliberately
 * paired: each "disabled" assertion has a CONTROL rendering the SAME path with one
 * activity on the canvas, so a button that is disabled unconditionally cannot pass.
 *
 * MUTATION RECEIPT (measured, see the PR body): drop `&& !seedIncomplete` from `canRun` /
 * `canDebug` / `canSchedule` in `data-pipeline-editor.tsx` → the two "refused" specs go
 * RED while the two CONTROLs stay green.
 */
describe('#3755 — data-pipeline-editor gates its OWN Run / Debug / Schedule on the empty canvas', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  const DP_ID = '00000000-0000-0000-0000-0000000000dd';
  const WS = 'ws-1';

  /** ADF activity shape the canvas understands. */
  const ONE_ACTIVITY = [
    { name: 'CopyBronze', type: 'Copy', typeProperties: {}, dependsOn: [] },
  ];

  /**
   * The editor's own data path: `/api/cosmos-items/<slug>/<id>` resolves the workspace
   * (which also sets `pipelineId`, so the pre-existing `!pipelineId` disable is NOT what
   * these specs measure), then `/api/items/data-pipeline/<id>?workspaceId=…` returns
   * `{ ok, definition }` — the shape `loadDetail` actually reads.
   */
  function installDataPipelineFetch(activities: unknown[]) {
    vi.spyOn(global, 'fetch').mockImplementation((async (url: any) => {
      const u = String(url);
      if (u.includes('/api/loom/workspaces')) {
        return json({ ok: true, workspaces: [{ id: WS, name: 'Test WS' }] });
      }
      if (u.includes('/api/cosmos-items/')) return json({ ok: true, workspaceId: WS });
      if (u.includes(`/api/items/data-pipeline/${DP_ID}/triggers`)) return json({ ok: true, triggers: [] });
      if (u.includes(`/api/items/data-pipeline/${DP_ID}/runs`)) return json({ ok: true, runs: [] });
      if (u.includes(`/api/items/data-pipeline/${DP_ID}`)) {
        return json({ ok: true, definition: { name: 'dp', properties: { activities, parameters: {} } } });
      }
      if (u.includes('/pipelines')) return json({ ok: true, pipelines: [{ id: DP_ID, name: 'dp' }] });
      return json({ ok: true });
    }) as any);
  }

  /** Every control that puts THIS pipeline on a compute, enumerated once. */
  const COMPUTE_CONTROLS = [/^run$/i, /^debug$/i, /^schedule$/i, /add trigger/i];

  async function mount(props: { templateId?: string; runtimePreset?: any }) {
    render(<DataPipelineEditor item={makeItem('data-pipeline', 'Data pipeline')} id={DP_ID} {...props} />);
    // The ribbon is present as soon as the editor's own body renders.
    await waitFor(() => expect(screen.getByRole('button', { name: /^run$/i })).toBeInTheDocument(),
      { timeout: 8000 });
  }

  it('TEMPLATED path — every compute control is refused on an empty canvas', async () => {
    // A `templateId` that matches no template is the real shape here: it takes the
    // non-delegating branch (`hostTemplate` is true) and the template seed bails at
    // `if (!t) return;`, so the canvas stays empty. Before this change all four of these
    // were live.
    installDataPipelineFetch([]);
    await mount({ templateId: 'no-such-template-4711' });

    for (const name of COMPUTE_CONTROLS) {
      await waitFor(() => expect(screen.getByRole('button', { name })).toBeDisabled(), { timeout: 8000 });
    }
  });

  it('TEMPLATED path CONTROL — one activity on the canvas and all four are live again', async () => {
    // Without this, "disabled" above also passes against buttons disabled unconditionally
    // — which is exactly how a gate stops being a gate and becomes a broken editor.
    installDataPipelineFetch(ONE_ACTIVITY);
    await mount({ templateId: 'no-such-template-4711' });

    for (const name of COMPUTE_CONTROLS) {
      await waitFor(() => expect(screen.getByRole('button', { name })).not.toBeDisabled(), { timeout: 8000 });
    }
  });

  it('FABRIC runtime path — every compute control is refused on an empty canvas', async () => {
    // `runtime === 'fabric'` is the second non-delegating branch. no-fabric-dependency.md
    // keeps it strictly opt-in, which is precisely why it is easy to leave ungated.
    installDataPipelineFetch([]);
    await mount({ runtimePreset: 'fabric' });

    for (const name of COMPUTE_CONTROLS) {
      await waitFor(() => expect(screen.getByRole('button', { name })).toBeDisabled(), { timeout: 8000 });
    }
  });

  it('FABRIC runtime path CONTROL — one activity on the canvas and all four are live again', async () => {
    installDataPipelineFetch(ONE_ACTIVITY);
    await mount({ runtimePreset: 'fabric' });

    for (const name of COMPUTE_CONTROLS) {
      await waitFor(() => expect(screen.getByRole('button', { name })).not.toBeDisabled(), { timeout: 8000 });
    }
  });
});
