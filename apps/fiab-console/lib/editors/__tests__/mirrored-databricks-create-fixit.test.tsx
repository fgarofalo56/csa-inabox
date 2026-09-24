/**
 * MirroredDatabricksEditor — the create dialog's failed-pairing gate (#4183).
 *
 * The API half of #4183 (a truthful `ok:false` envelope carrying a
 * gate-registry `gateId`) landed in #4316 and is pinned by
 * `app/api/items/mirrored-databricks/__tests__/create-envelope.test.ts`. The
 * editor, however, still rendered only `pairing.gate` prose — so the `gateId`
 * the route went to the trouble of attaching reached a dead end, and the
 * operator was left reading a paragraph telling them to go set a value by
 * hand. That is the state `ux-baseline.md` G2 and `auto-bind-by-default.md` §5
 * both forbid.
 *
 * These tests pin the affordance in BOTH directions, because a Fix-it that
 * renders unconditionally would be its own defect:
 *   - a pairing failure WITH a registry id renders the inline Fix-it, and
 *   - a pairing failure with NO registry id (PAIR_CREATE_FAILED) renders the
 *     honest reason and NO Fix-it — claiming a gate that does not resolve
 *     would assert something the code did not establish (deploy-integrity R7).
 *
 * WHY THE ABSENCE TEST ASSERTS MORE THAN "no Fix-it button" (measured, not
 * assumed). The first cut of this suite asserted only
 * `queryByRole('button', {name:/Fix it/i})` on the no-registry-id case, and the
 * narrow mutation — dropping the `cGateId` conjunct from the editor's render
 * condition — SURVIVED it 3/3, RC=0. Reason: with a null id `HonestGate`
 * resolves `gateId ?? envelope?.id ?? ''`, `getGate('')` misses, and the
 * unknown-id branch renders a bar carrying NO "Fix it" button — so the only
 * thing the test looked at was unchanged while the mutant mounted a second,
 * wrongly-titled warning bar on the exact input the docblock claimed to
 * protect. The absence case therefore asserts the unknown-id bar's own tells:
 * its "<surface> needs configuration" title and the absence of the registry
 * branch's "Gate registry" link. Note that asserting the string "is not in the
 * registry" would NOT work — `detail` is always passed, so `resolvedDetail` is
 * truthy and that fallback never prints.
 *
 * Transport is mocked; the real editor and the real HonestGate render. Queries
 * go through `screen` (document-rooted) rather than the render container,
 * because Fluent's Dialog and MessageBar content mounts in a portal.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const fetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({
  clientFetch: (...a: any[]) => fetchMock(...a),
}));

import { MirroredDatabricksEditor } from '../mirrored-databricks-editor';

function jsonRes(body: unknown, status = 200) {
  return { status, json: async () => body } as any;
}

/** The create POST body this test wants the editor to receive back. */
let createResponse: unknown;

/**
 * Fluent's modal "hide siblings" bookkeeping unwinds ASYNCHRONOUSLY, and
 * `cleanup()` does not wait for it. MEASURED: without this flush the unwind
 * scheduled by one test lands DURING the next one and marks the freshly
 * mounted surface `aria-hidden` — probed at 300ms intervals, a reopened dialog
 * read `roles=1 ... openAttr=["visible"]` at t=0 and `roles=0 ...
 * openAttr=["hidden"]` from t=300 onward. Every `*ByRole` query in this file is
 * blind to that, in both directions: a presence assertion fails spuriously, and
 * an ABSENCE assertion passes for the wrong reason. Draining the timer queue
 * between tests removes the cause rather than hardening each assertion.
 */
afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 50));
});
beforeEach(() => {
  fetchMock.mockReset();
  createResponse = null;
  fetchMock.mockImplementation(async (url: string, init?: any) => {
    if (url.startsWith('/api/loom/workspaces')) {
      return jsonRes({ ok: true, workspaces: [{ id: 'ws1', name: 'Analytics' }] });
    }
    if (url.startsWith('/api/items/mirrored-databricks/catalogs')) {
      return jsonRes({ ok: true, catalogs: [] });
    }
    if (url.startsWith('/api/items/mirrored-databricks?') && init?.method === 'POST') {
      return jsonRes(createResponse);
    }
    if (url.startsWith('/api/items/mirrored-databricks?')) {
      return jsonRes({ ok: true, workspaceId: 'ws1', mirrors: [] });
    }
    return jsonRes({ ok: true });
  });
});

/**
 * The create dialog's submit control (#4685).
 *
 * ONE function, called by both `createMirror` and the aria-hidden probe below,
 * so the probe exercises the query the suite actually uses rather than a
 * transcription of it (`assertion-design.md` "done" #3 — lift the pattern from
 * the source, do not copy it). Reverting this body to a bare
 * `screen.getByRole('button', { name: /Create mirror/i })` is the mutation that
 * the probe is built to catch.
 *
 * Both modifiers are load-bearing, and each was MEASURED against this dialog
 * rather than assumed (scratch run, 2026-09-24, worktree at `a5db87c98`):
 *
 *   - `findBy*` + `timeout` closes the LATE-RENDER class. Every other step in
 *     `openCreateDialog` already waits; this query was the file's only
 *     synchronous one, and it is the line all three recorded CI failures landed
 *     on (#4685), across two unrelated branches whose diffs cannot reach the
 *     console.
 *   - `hidden: true` closes the ARIA-HIDDEN class, which `findBy*` alone does
 *     NOT: with `aria-hidden="true"` on the surface, `findByRole` without this
 *     modifier times out exactly as `getByRole` throws (measured: resolved=false
 *     at a 1200ms budget). That is the state this file's own `afterEach`
 *     docblock measured landing from t=300ms, and it is why the one-line fix
 *     proposed in #4685 would have closed only half the failure surface.
 *
 * The widening is deliberate and narrow: this is PLUMBING — it locates a
 * control in order to click it — and it stays unambiguous, `hidden: true`
 * matching exactly ONE button both before and after the mutation. It is the
 * same convention, for the same jsdom reason, as the dialog-internal queries in
 * `azure-sql-server-editor-bind.test.tsx:159` and
 * `spark-job-definition-lineage.test.tsx:135`. Every ASSERTION in this file
 * stays strict — the `Fix it` / `Gate registry` / gate-title queries are
 * untouched, so a gate that renders only inside the a11y tree's blind spot
 * still fails them.
 */
function findCreateMirrorButton() {
  return screen.findByRole('button', { name: /Create mirror/i, hidden: true }, { timeout: 5000 });
}

/**
 * Drive the real create flow up to the point of submission: pick the workspace,
 * open the dialog, fill the two required fields. Split out of `createMirror` so
 * the #4685 probe can reach the open dialog without submitting it.
 */
async function openCreateDialog(user: ReturnType<typeof userEvent.setup>) {
  render(<FluentProvider theme={webLightTheme}><MirroredDatabricksEditor item={'mirrored-databricks' as any} id="new" /></FluentProvider>);

  // Workspace picker — "New mirror" stays disabled until one is chosen. The
  // Fluent Dropdown only mounts its Options once opened.
  const combo = await screen.findByRole('combobox', { name: /Workspace/i });
  await waitFor(() => expect((combo as HTMLInputElement).disabled).toBe(false));
  await user.click(combo);
  await user.click(await screen.findByRole('option', { name: 'Analytics' }));

  // More than one control opens the dialog (toolbar trigger + empty-state CTA);
  // any enabled one is a valid entry point.
  const newBtn = await waitFor(() => {
    const b = screen.getAllByRole('button', { name: /New mirror/i })
      .find((el) => !(el as HTMLButtonElement).disabled);
    if (!b) throw new Error('no enabled "New mirror" button yet');
    return b;
  });
  await user.click(newBtn);

  // The dialog surface mounts before its content, so wait on a field rather
  // than on the surface — otherwise this races the first render. Query by
  // LABEL, not by role: the Unity Catalog field renders as a freeform Input or
  // as a Dropdown depending on whether the catalogs probe returned any, and
  // this test must not depend on which of the two it got.
  const name = await screen.findByLabelText(/Display name/i, undefined, { timeout: 5000 });
  await user.type(name, 'Sales mirror');
  const catalog = await screen.findByLabelText(/Unity Catalog name/i, undefined, { timeout: 5000 });
  await user.type(catalog, 'sales');
}

/**
 * Drive the real create flow: pick the workspace, open the dialog, fill the two
 * required fields, submit. Returns once the create POST has resolved.
 */
async function createMirror(user: ReturnType<typeof userEvent.setup>) {
  await openCreateDialog(user);
  await user.click(await findCreateMirrorButton());
}

/** A marker long enough that an accidental substring match is implausible. */
const GATE_PROSE = 'DUPPROBE-Databricks workspace not configured for this deployment.';

describe('MirroredDatabricksEditor create dialog — failed-pairing Fix-it (#4183)', () => {
  it('renders the inline Fix-it when the route names a gate-registry entry', async () => {
    const user = userEvent.setup();
    createResponse = {
      ok: false,
      created: true,
      code: 'NO_DATABRICKS',
      gateId: 'svc-databricks',
      error: 'Databricks workspace not configured (set LOOM_DATABRICKS_HOSTNAME).',
      mirror: { id: 'm1' },
      pairing: { ok: false, code: 'NO_DATABRICKS', gate: GATE_PROSE },
    };
    await createMirror(user);

    // The gate is actionable in-product rather than prose.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Fix it/i }).length).toBeGreaterThan(0));
    // The id RESOLVED in the registry — the unknown-id fallback bar is absent.
    expect(screen.queryByText(/needs configuration/i)).toBeNull();
    expect(screen.getAllByRole('link', { name: /Gate registry/i }).length).toBeGreaterThan(0);
    // …and it resolved to the gate the ROUTE named, by that gate's own title.
    expect(screen.getAllByText(/Azure Databricks \(notebooks \/ SQL \/ Warp\)/i).length).toBeGreaterThan(0);
    // The measured reason is still on screen…
    expect(screen.getAllByText(new RegExp(GATE_PROSE)).length).toBeGreaterThan(0);
    // …exactly ONCE. Before this, the editor printed `pairing.gate` in a
    // warning MessageBar AND passed the same string to HonestGate as `detail`,
    // so the ~70-word NO_DATABRICKS paragraph rendered in two stacked yellow
    // bars (ux-baseline §3 — a touched surface comes up to baseline).
    expect(screen.getAllByText(new RegExp(GATE_PROSE)).length).toBe(1);
    // The "the item does exist" fact the replaced bar carried is not lost.
    expect(screen.getAllByText(/mirror item was created and is readable/i).length).toBe(1);
  });

  /**
   * WHAT THIS FIXTURE DOES AND DOES NOT PIN, corrected after review.
   *
   * It does NOT pin the route's NO_SYNAPSE -> `svc-synapse` mapping: the
   * fixture supplies `gateId` directly, so `PAIRING_GATE_ID` (route.ts:61-64)
   * is never consulted. Nor can a rename in `lib/gates/registry` break it —
   * `GATE_META` only ENRICHES a registry derived from `ENV_CHECKS`, and
   * `svc-synapse` is independently declared at
   * `lib/admin/env-checks/azure-services.ts:13`, so the id keeps resolving.
   *
   * What it DOES pin, falsifiably, is that the editor renders whichever gate
   * the route named rather than a constant — which is why both this test and
   * the Databricks one assert the resolved gate's own TITLE. Hard-coding
   * `gateId="svc-databricks"` at the call site reddens this test on that title.
   */
  it('renders the Fix-it for the Synapse half of the pairing too, not only Databricks', async () => {
    const user = userEvent.setup();
    createResponse = {
      ok: false,
      created: true,
      code: 'NO_SYNAPSE',
      gateId: 'svc-synapse',
      error: 'No Synapse Serverless workspace is configured to serve them.',
      mirror: { id: 'm1' },
      pairing: { ok: false, code: 'NO_SYNAPSE', gate: 'No Synapse Serverless workspace is configured to serve them.' },
    };
    await createMirror(user);

    await waitFor(() => expect(screen.getAllByRole('button', { name: /Fix it/i }).length).toBeGreaterThan(0));
    expect(screen.queryByText(/needs configuration/i)).toBeNull();
    expect(screen.getAllByRole('link', { name: /Gate registry/i }).length).toBeGreaterThan(0);
    // The gate that rendered is the one the ROUTE named — `svc-synapse`'s own
    // registry title — and emphatically not the Databricks one.
    expect(screen.getAllByText(/Synapse \(warehouse \/ notebooks \/ pipelines\)/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Azure Databricks \(notebooks \/ SQL \/ Warp\)/i)).toBeNull();
  });

  it('renders NO Fix-it when the failure has no registry entry', async () => {
    const user = userEvent.setup();
    createResponse = {
      ok: false,
      created: true,
      code: 'PAIR_CREATE_FAILED',
      // no gateId — nothing in the registry resolves this
      error: 'quota exceeded',
      mirror: { id: 'm1' },
      pairing: { ok: false, code: 'PAIR_CREATE_FAILED', gate: 'quota exceeded' },
    };
    await createMirror(user);

    await waitFor(() =>
      expect(screen.getByText(/Mirror created — endpoint not yet queryable/i)).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: /Fix it/i })).toBeNull();
    // The three assertions that kill the narrow mutation (see the docblock):
    // an unconditional HonestGate would mount its unknown-id bar here, which
    // carries neither the honest title above nor these tells.
    expect(screen.queryByText(/needs configuration/i)).toBeNull();
    expect(screen.queryAllByRole('link', { name: /Gate registry/i }).length).toBe(0);
  });

  /**
   * `cPairing` / `cGateId` were cleared in `create()`, on `pairing.ok`, and by
   * the secondary Close button — but the Dialog's `onOpenChange` reset neither,
   * and Escape and a backdrop click both route ONLY through there. So a
   * dismissed failure survived and re-rendered on the next, untouched create
   * (`ux-baseline.md` §6 — a freshly created item opens clean). The
   * stale-`cPairing` half predates #4183; the Fix-it half is new with it.
   *
   * SCOPE OF THIS RECEIPT, stated rather than implied. This drives the
   * no-registry-id failure, not the gated one. The gated variant is NOT
   * measurable in jsdom: `HonestGate` mounts a nested `GateFixitDialog`, and
   * with it present an Escape leaves the outer DialogSurface in the document
   * (`roleDialogs=0` but `surfaces=1`) and the reopen never produces a
   * role-visible dialog. That is Fluent under jsdom, not the editor — measured
   * against a control that opens/Escapes/reopens the SAME dialog with no
   * failure at all and reads `surfaces=1 -> 0 -> 1`, passing. The reset being
   * exercised is one unconditional handler that clears both pieces of state, so
   * this pins the code path; the gated rendering of it is owed a browser
   * receipt (`ux-baseline.md` G1), which this PR does not claim.
   */
  it('a dismissed failure does not re-render on the next create (ux-baseline §6)', async () => {
    const user = userEvent.setup();
    createResponse = {
      ok: false,
      created: true,
      code: 'PAIR_CREATE_FAILED',
      error: 'quota exceeded',
      mirror: { id: 'm1' },
      pairing: { ok: false, code: 'PAIR_CREATE_FAILED', gate: GATE_PROSE },
    };
    await createMirror(user);
    await waitFor(() => expect(screen.getByText(new RegExp(GATE_PROSE))).toBeTruthy());

    // Dismiss with Escape — NOT the secondary Close button, which always reset.
    await user.keyboard('{Escape}');
    // Wait for the teardown to COMPLETE, not merely for the dialog role to go
    // away. `queryAllByRole('dialog') === 0` goes true while Fluent is still
    // unmounting the surface, and a reopen click landing in that window is
    // swallowed — which made this test pass alone and fail (`Unable to find
    // role="dialog"`, 6.5s) when run in the same vitest invocation as the route
    // suite. The surface count reaching 0 is the signal the teardown observed.
    await waitFor(() => {
      expect(screen.queryAllByRole('dialog').length).toBe(0);
      expect(document.querySelectorAll('.fui-DialogSurface').length).toBe(0);
    }, { timeout: 10000 });

    // Reopen: a fresh, untouched create must not show the previous failure.
    const newBtn = await waitFor(() => {
      const b = screen.getAllByRole('button', { name: /New mirror/i })
        .find((el) => !(el as HTMLButtonElement).disabled);
      if (!b) throw new Error('no enabled "New mirror" button yet');
      return b;
    });
    await user.click(newBtn);
    // The reopened surface is located by CLASS, never by role. MEASURED
    // mechanism for the flake this replaces (1 red in 9 full-file runs here,
    // reported as 6 in 9 elsewhere): the dialog reopens VISIBLE —
    // `roles=1 surfaces=1 openAttr=["visible"]` at t=0 — and is then
    // RETROACTIVELY marked aria-hidden about 300ms later, when the FIRST
    // dialog's aria-hidden bookkeeping finally unwinds and hides the surface
    // that has already replaced it (`roles=0 ... openAttr=["hidden"]`, stable
    // through t=1500). So `findByRole('dialog')` is a race that passes only
    // when it samples before the unhide lands, and waiting LONGER makes it
    // strictly worse. A class-rooted node plus text queries are immune to
    // aria-hidden, and the `surfaces === 0` wait above guarantees this is a
    // freshly mounted surface rather than the previous one's corpse.
    const live = await waitFor(() => {
      const el = document.body.querySelector('.fui-DialogSurface') as HTMLElement | null;
      if (!el) throw new Error('no DialogSurface mounted yet');
      return el;
    }, { timeout: 10000 });
    // Positive control FIRST: without it every absence assertion below could
    // pass vacuously against an empty or never-reopened surface.
    expect(within(live).getByLabelText(/Display name/i)).toBeTruthy();
    expect(within(live).queryByText(new RegExp(GATE_PROSE))).toBeNull();
    expect(within(live).queryByText(/endpoint not yet queryable/i)).toBeNull();
    expect(within(live).queryByText(/Fix it/i)).toBeNull();
  });

  /**
   * The registry surface rows are a DELIVERABLE of this change, so they get an
   * assertion. Measured before adding this: deleting all four rows left
   * `lib/gates` at 28/28 green, because the existing completeness test only
   * requires a gate to declare at LEAST ONE surface and both gates keep six
   * others. An unfalsifiable deliverable is not a deliverable.
   *
   * The claim being pinned: every gate id the create route can emit
   * (`PAIRING_GATE_ID`, route.ts:61-64) declares the surface it actually
   * blocks, so /admin/gates does not under-report where it fires
   * (`ux-baseline.md` G2(c)).
   */
  it('the gate registry lists the mirrored-databricks surfaces these gates block (G2(c))', async () => {
    // Resolved through `getGate` — the same function `HonestGate` calls, so
    // this asserts the registry as the product reads it, not as it is authored.
    const { getGate } = await import('@/lib/gates/registry');
    for (const id of ['svc-databricks', 'svc-synapse']) {
      const gate = getGate(id);
      expect(gate, `${id} must exist in the registry`).toBeTruthy();
      const paths = (gate?.surfaces || []).map((sf) => sf.path);
      expect(paths, `${id} must declare the editor surface`).toContain('/items/mirrored-databricks');
      expect(paths, `${id} must declare the BFF surface`).toContain('/api/items/mirrored-databricks');
    }
  });

  it('positive control — a successful pairing shows neither the gate nor a Fix-it', async () => {
    const user = userEvent.setup();
    createResponse = {
      ok: true,
      created: true,
      mirror: { id: 'm1', state: { sqlEndpoint: 'ep' } },
      pairing: { ok: true, tablesResolved: 3, tablesSkipped: 0 },
    };
    await createMirror(user);

    // A fully paired mirror closes the dialog; no gate, no Fix-it anywhere.
    await waitFor(() => expect(screen.queryByText(/endpoint not yet queryable/i)).toBeNull());
    expect(screen.queryByRole('button', { name: /Fix it/i })).toBeNull();
  });

  /**
   * #4685 — THE SUBMIT QUERY SURVIVES FLUENT'S ARIA-HIDDEN UNWIND.
   *
   * WHY THIS EXISTS AT ALL. The fix for #4685 is one line inside
   * `findCreateMirrorButton`, and on its own NOTHING in this repo witnesses it:
   * reverting that line to a bare `getByRole` leaves all six tests above green
   * locally and restores a probabilistic CI failure with no input that reddens
   * it on demand. An unwitnessed change to a test file is exactly the shape
   * `assertion-design.md` refuses, so the guard ships with a probe that has
   * deterministic kill power over it.
   *
   * THE VALUE THAT MAKES THIS TEST FAIL: `aria-hidden="true"` on
   * `.fui-DialogSurface`. That is not a hypothetical — it is the state this
   * file's own `afterEach` docblock measured Fluent's modal bookkeeping landing
   * on a live surface from t=300ms, and every `*ByRole` query is blind to it.
   * With the attribute applied, a bare `getByRole` throws
   * (`Unable to find an accessible element…`) and a plain `findByRole` merely
   * times out instead; only the `hidden: true` form resolves. So this test goes
   * RED the moment `findCreateMirrorButton` loses either modifier.
   *
   * WHAT IT DOES NOT CLAIM. It does not reproduce the CI failure, and it does
   * not decide between the two candidate mechanisms (late render vs aria-hidden
   * unwind) — #4685 records that the fast-runner correlation is a risk factor,
   * not a demonstrated cause. It pins the property the fix is FOR: this query
   * resolves in both states. The dialog genuinely failing to open is still a
   * product regression, and the six tests above still fail on it, because
   * `openCreateDialog` waits on the dialog's own fields before this runs.
   */
  it('the create-dialog submit query survives an aria-hidden surface (#4685)', async () => {
    const user = userEvent.setup();
    createResponse = {
      ok: true,
      created: true,
      mirror: { id: 'm1', state: { sqlEndpoint: 'ep' } },
      pairing: { ok: true, tablesResolved: 3, tablesSkipped: 0 },
    };
    await openCreateDialog(user);

    // POSITIVE CONTROL, before the mutation: the query resolves against a
    // normal, visible dialog. This passes under the reverted helper too — which
    // is the point. It localises this test's kill power to the aria-hidden
    // state alone, rather than to "the button exists at all".
    expect(await findCreateMirrorButton()).toBeTruthy();

    // THE FIXTURE REACHES THE RULE (`assertion-design.md` "done" #3). Exactly
    // one surface to mark, and the attribute genuinely removes the button from
    // the accessibility tree — so a green below cannot be read as "the mutation
    // did nothing", which is the ambiguity a bare green mutation arm carries.
    const surfaces = document.querySelectorAll('.fui-DialogSurface');
    expect(surfaces.length, 'exactly one dialog surface to mark aria-hidden').toBe(1);
    (surfaces[0] as HTMLElement).setAttribute('aria-hidden', 'true');
    expect(
      () => screen.getByRole('button', { name: /Create mirror/i }),
      'aria-hidden must actually hide the submit button from an unwidened role query',
    ).toThrow(/Unable to find an accessible element/);

    // THE ASSERTION THAT CARRIES THE KILL POWER: the helper's own query —
    // called, not transcribed, so a future edit to it cannot drift away from
    // what this pins — still resolves against the hidden surface…
    const submit = await findCreateMirrorButton();
    expect(submit).toBeTruthy();
    // …and what it returns is the live submit control, not merely some node
    // bearing that name: clicking it issues the create POST.
    await user.click(submit);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([u, i]: any[]) => String(u).startsWith('/api/items/mirrored-databricks?') && i?.method === 'POST',
        ).length,
        'the located button must actually submit the create',
      ).toBe(1),
    );
  });
});
