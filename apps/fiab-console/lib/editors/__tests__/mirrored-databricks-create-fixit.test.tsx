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
 * ONE function, called by `createMirror` and by BOTH #4685 probes below, so the
 * probes exercise the query the suite actually uses rather than a transcription
 * of it (`assertion-design.md` "done" #3 — lift the pattern from the source, do
 * not copy it). Reverting this body is the mutation the probes are built to
 * catch, and each modifier now has its OWN probe:
 *
 *   - `findBy*` + `timeout` closes the LATE-RENDER class, witnessed by
 *     `…survives a late-attached submit control`. MEASURED (arm C): swapping
 *     this body to `getByRole(…, { hidden: true })` — keeping the widening,
 *     dropping only the wait — reds that probe, and it was the ONLY red on that
 *     run (1 failed / 7 passed).
 *   - `hidden: true` closes the A11Y-INVISIBLE class, which `findBy*` alone does
 *     NOT, witnessed by `…survives an aria-hidden surface`. MEASURED (arm B):
 *     dropping only `hidden: true` reds that probe and leaves the late-attach
 *     one green; with `aria-hidden="true"` on the surface a plain `findByRole`
 *     merely times out where a bare `getByRole` (arm A) throws. Arm B's run
 *     carried one OTHER red, in `a dismissed failure does not re-render`, at its
 *     `.fui-DialogSurface` teardown wait — which reds at base too on a loaded
 *     machine (PR #4693 §4, issue #4698). The mutation did not cause it and this
 *     claim does not rest on it.
 *
 * So this file reddens when the helper loses EITHER modifier — and that claim is
 * measured arm by arm (PR #4693 §3). An earlier revision of this docblock
 * asserted it having run only arms A and B, which die for the SAME reason and
 * cannot distinguish the halves; a reviewer ran arm C and it was GREEN. The
 * claim is restated here only because the probe that makes it true now exists.
 *
 * THE WIDENING, AT FULL WIDTH. `hidden: true` does not narrow one predicate, it
 * BYPASSES the accessibility filter. In `@testing-library/dom@10.4.1`
 * (`dist/role-helpers.js`) `isSubtreeInaccessible` returns true for
 * `element.hidden === true` (:34), `aria-hidden="true"` (:37) and
 * `display: none` (:41); `isInaccessible` additionally short-circuits on an
 * inherited `visibility: hidden` (:67); and :169 is the switch —
 * `return hidden === false ? isInaccessible(element) === false : true`. The
 * click does not re-check it: in `@testing-library/user-event@14.6.1` `isVisible`
 * is reached by exactly one consumer (`utils/focus/getTabDestination.js`,
 * tab-order pruning; the only other references are its own definition and the
 * `utils/index.js` barrel), and the only reachability assertion on the click
 * path is `pointer-events`. So a widened query finds AND clicks a control no
 * assistive technology could reach, and nothing else in this repo would notice:
 * `mirrored-databricks.test.tsx` carries no `ByRole` query at all, and the axe
 * ratchet (`e2e/a11y.uat.ts`) enumerates 22 surfaces, none an
 * `/items/mirrored-databricks/*` route — and no workflow references it, so it
 * runs on the in-VNet UAT runner rather than in PR CI. That coverage is bought
 * back deliberately, by the STRICT positive control inside the aria-hidden
 * probe.
 *
 * It is also a NEW way for this helper to fail: `findBy*` rejects on more than
 * one match, and `hidden: true` enlarges the candidate set to the whole
 * document including hidden subtrees. Measured on this dialog, before and after
 * the attribute: exactly ONE match either way. It would go red loudly rather
 * than pass quietly.
 *
 * PRECEDENT, AND HOW THIS DIFFERS FROM IT. `hidden: true` is already in use at
 * 16 executable query sites across 4 sibling files — `activator.test.tsx` (1),
 * `azure-sql-server-editor-bind.test.tsx` (6),
 * `spark-job-definition-lineage.test.tsx` (5),
 * `stored-function-editor.test.tsx` (4); counted as non-comment occurrences of
 * the literal, `git grep`-scoped to tracked files. But every one of those is
 * ENABLING: each documents that jsdom never resolves its portalled surface into
 * the accessibility tree at all, so the query does not work without the
 * modifier. Here it is PROPHYLACTIC — the bare query finds this button in the
 * steady state, which is why arm A leaves the six pre-existing tests green
 * (measured independently by both #4693 reviewers on quiet machines; on a
 * heavily loaded one base itself reds three of them, so that arm cannot be read
 * off a loaded run — PR #4693 §4). Same modifier, different warrant. "The same
 * jsdom reason" was overstated, and it is why the strict control below exists.
 *
 * Every PRESENCE assertion in this file stays strict — but be precise about
 * what that buys, and about the one exception. The presence assertions (the
 * `Fix it` / `Gate registry` / gate-title queries) do fail if a gate renders
 * only inside the accessibility tree's blind spot. The ABSENCE ones pass for
 * the wrong reason under exactly that state — the second direction the
 * `afterEach` docblock warns about. That is pre-existing, is not introduced
 * here, and is not closed by this change. The exception is deliberate and runs
 * the other way: probe 2's `queryAllByRole(…, { hidden: true }).length === 0`
 * is widened ON PURPOSE, because absence under the WIDEST query is strictly
 * stronger than absence under a narrow one.
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
   * #4685, PROBE 1 OF 2 — THE SUBMIT QUERY SURVIVES AN A11Y-INVISIBLE SURFACE.
   *
   * WHY THE PROBES EXIST AT ALL. The fix for #4685 is one line inside
   * `findCreateMirrorButton`, and on its own NOTHING in this repo witnesses it:
   * reverting that line to a bare `getByRole` leaves the six tests that predate
   * #4685 green (measured by both #4693 reviewers on quiet machines) and
   * restores a probabilistic CI failure with no input that reddens it on
   * demand. An unwitnessed change to a test file is exactly the shape
   * `assertion-design.md` refuses, so the guard ships with TWO probes which
   * between them have deterministic kill power over both modifiers — one each,
   * because a single probe cannot distinguish them (arms A and B both die of
   * a11y-blindness, one by throwing and one by timing out).
   *
   * THE VALUE THAT MAKES THIS ONE FAIL: `aria-hidden="true"` on
   * `.fui-DialogSurface`. Not hypothetical, and now observed twice:
   *   - this file's own `afterEach` docblock measured Fluent's modal
   *     bookkeeping landing it on a LIVE surface from t=300ms; and
   *   - CI run 35943862992 (PR #4689, whose diff is 15 workflow YAMLs and
   *     cannot reach the console) threw at the pre-#4685 submit query — line
   *     127 as it stood on `main` at 76377a86e, named by its ref because line
   *     numbers in this file have since moved — with an
   *     accessible tree that held this editor's toolbar buttons, six tabs, the
   *     `Databricks mirrors` tree and the `Workspace` combobox but NO `textbox`
   *     and no dialog role — moments after `findByLabelText(/Display name/i)`
   *     and `/Unity Catalog name/i` had both resolved AND been typed into.
   *     Those are DOM-rooted queries and are NOT blind to aria-hidden, so the
   *     dialog's content was out of the accessibility tree while the page
   *     behind it was still in it.
   * That second observation is BOUNDED, deliberately: the error dump's DOM
   * print ends mid-tab-strip with an ellipsis, inside the app root, so it is
   * cut before anything portalled to the end of `<body>`. It therefore does NOT
   * establish whether the surface was still in the DOM (hidden) or had left it
   * (unmounted). Under the first reading `hidden: true` is the
   * modifier that closes it and `findBy*` alone would merely time out; under
   * the second the guard still FAILS, correctly, because a dialog that closes
   * itself is a product regression. Neither reading is asserted here
   * (`deploy-integrity.md` R7).
   *
   * WHY HARDEN HERE, when this file's own `afterEach` docblock reaches the
   * OTHER remedy — "draining the timer queue between tests removes the cause
   * rather than hardening each assertion". Both are right, about different
   * instances, and this PR does not overturn it:
   *   - The flush is a TEST BOUNDARY, and cannot touch the instance this file
   *     measures WITHIN one test. `a dismissed failure does not re-render`
   *     records the FIRST dialog's unwind marking the SECOND, already-mounted
   *     surface aria-hidden ~300ms later, inside a single test; no `afterEach`
   *     runs in between. Hardening is the only remedy available there.
   *   - The flush's arithmetic is not established in either direction. The
   *     unwind was probed at 300ms INTERVALS, so t=300 is an upper bound on
   *     when it lands, not a measurement of it — 50ms may or may not be enough
   *     and that sampling cannot say. Raising 50 to some N without a value that
   *     reddens at N-1 is precisely the unwitnessed change this PR exists to
   *     refuse, so the flush is left alone and tracked in #4698 rather than
   *     nudged.
   *
   * WHAT NEITHER PROBE CLAIMS. They do not reproduce the CI failure and do not
   * decide its mechanism. Note what `retry` does to the odds: `vitest.config
   * .ts:154` sets `retry: process.env.CI ? 2 : 0` and no workflow passes
   * `--retry`, so every recorded red survived THREE attempts — measured in run
   * 35943862992, where both failures carry `(retry x2)` and each printed three
   * identical stacks at `:127:27`, while two OTHER tests in the same file
   * passed `(retry x1)`, i.e. lost their first attempt and recovered. Four of
   * six red on attempt 1 is a run-wide condition rather than six independent
   * draws, which would compound as p³. That names no cause, and nothing here
   * rests on one.
   *
   * A dialog that genuinely never opens is still caught: `openCreateDialog`
   * waits on the dialog's own labelled fields first, so it fails there. That is
   * FIVE of the six pre-existing tests, not six — the sixth, the gate-registry
   * one, imports `getGate` and never opens a dialog. A #4693 reviewer built
   * that arm (the `New mirror` trigger made inert) and measured 6 of 7 red at
   * `findByLabelText(/Display name/i)`, with the registry test the lone passer.
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

    // POSITIVE CONTROL 1, before the mutation: the helper's own query resolves
    // against a normal, visible dialog. This passes under the mutants too —
    // which is the point. It localises this test's kill power to the hidden
    // state alone, rather than to "the button exists at all". It is also
    // AWAITED FIRST so the strict control below cannot race the render.
    expect(await findCreateMirrorButton()).toBeTruthy();

    // THE FIXTURE REACHES THE RULE (`assertion-design.md` "done" #3). Exactly
    // one surface to mark, and the attribute genuinely removes the button from
    // the accessibility tree — so a green below cannot be read as "the mutation
    // did nothing", which is the ambiguity a bare green mutation arm carries.
    const surfaces = document.querySelectorAll('.fui-DialogSurface');
    expect(surfaces.length, 'exactly one dialog surface to mark aria-hidden').toBe(1);
    const surface = surfaces[0] as HTMLElement;

    // Clear the ONE attribute this file has twice measured Fluent's modal
    // unwind writing onto a LIVE surface, so the strict control below measures
    // the PRODUCT's accessibility rather than the harness's leftovers — and so
    // this probe does not reintroduce the very flake it exists to close. Every
    // other way of hiding the submit is left exactly as rendered.
    surface.removeAttribute('aria-hidden');

    // POSITIVE CONTROL 2, STRICT — this is the coverage `hidden: true`
    // surrenders, bought back deliberately. The query is document-rooted, so it
    // reddens if the submit control is unreachable to the accessibility tree
    // for any reason other than that ONE cleared attribute on that ONE node:
    // `hidden`, `display: none`, an inherited `visibility: hidden`, or an
    // `aria-hidden` on the button or on any other ancestor. WHAT VALUE MAKES IT
    // FAIL, measured rather than asserted: arm D sets `aria-hidden="true"` on
    // the BUTTON at this point, and this line throws (PR #4693 §3).
    expect(
      screen.getByRole('button', { name: /Create mirror/i }),
      'the submit control must be reachable in the accessibility tree in the steady state',
    ).toBeTruthy();

    surface.setAttribute('aria-hidden', 'true');
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

  /**
   * #4685, PROBE 2 OF 2 — THE SUBMIT QUERY WAITS OUT A LATE-ATTACHED CONTROL.
   *
   * WHY THIS EXISTS. Probe 1 does not witness the `findBy*` + `timeout` half of
   * the guard. Measured by a reviewer and reproduced here as arm C: keep
   * `hidden: true`, drop the wait — `getByRole(…, { hidden: true })` — and
   * probe 1 stays GREEN. Arms A and B both die of a11y-blindness, one by
   * throwing and one by timing out, so neither separates the halves either. The
   * `findBy*` half is the one #4685 proposed as its one-line fix, so shipping it
   * unwitnessed is the exact shape `assertion-design.md` refuses.
   *
   * THE VALUE THAT MAKES THIS FAIL: the submit control not being in the DOM at
   * the moment the query runs. Stated plainly, this is a SYNTHETIC late attach
   * — the control is detached and re-attached on a timer. It is not a
   * reproduction of the CI failure and does not claim to be; it is the
   * deterministic input that separates `findBy*` from `getBy*`, which a timing
   * guard otherwise cannot have. The re-attach delay (250ms) is long against a
   * synchronous query, which throws at t=0, and short against the helper's
   * 5000ms budget, so neither direction is a race.
   *
   * WHY DETACH THE REAL NODE rather than render a decoy: the assertion then
   * pins that the query resolves to the SAME element, and the click at the end
   * proves that element is still wired to the create POST. A decoy would prove
   * only that `findBy*` waits, which is `@testing-library`'s property, not
   * ours.
   */
  it('the create-dialog submit query survives a late-attached submit control (#4685)', async () => {
    const user = userEvent.setup();
    createResponse = {
      ok: true,
      created: true,
      mirror: { id: 'm1', state: { sqlEndpoint: 'ep' } },
      pairing: { ok: true, tablesResolved: 3, tablesSkipped: 0 },
    };
    await openCreateDialog(user);

    // Same order as probe 1: the widened query first, so nothing below races
    // the render; then clear the measured-transient attribute; then a STRICT
    // grab, which is the same bought-back coverage probe 1 asserts.
    expect(await findCreateMirrorButton()).toBeTruthy();
    const surfaces = document.querySelectorAll('.fui-DialogSurface');
    expect(surfaces.length, 'exactly one dialog surface').toBe(1);
    (surfaces[0] as HTMLElement).removeAttribute('aria-hidden');
    const submit = screen.getByRole('button', { name: /Create mirror/i });
    const parent = submit.parentElement;
    expect(parent, 'the submit control must have a parent to detach from').toBeTruthy();
    const anchor = submit.nextSibling;

    parent!.removeChild(submit);

    // THE FIXTURE REACHES THE RULE: even the WIDENED query finds nothing now,
    // so a green below cannot be read as "the mutation did nothing".
    expect(
      screen.queryAllByRole('button', { name: /Create mirror/i, hidden: true }).length,
      'the detach must remove the submit control from every role query',
    ).toBe(0);

    const reattach = setTimeout(() => {
      parent!.insertBefore(submit, anchor && anchor.parentNode === parent ? anchor : null);
    }, 250);
    try {
      // THE ASSERTION THAT CARRIES THE KILL POWER: the helper's own query —
      // called, not transcribed — waits the control out. A synchronous query
      // here throws at t=0 whether or not it is widened: that is arm A and
      // arm C, and arm C is the one proving `findBy*` + `timeout` is
      // load-bearing independently of `hidden: true`.
      expect(
        await findCreateMirrorButton(),
        'the query must resolve to the SAME control that was re-attached',
      ).toBe(submit);
    } finally {
      clearTimeout(reattach);
    }

    // …and the re-attached node is not merely present but still wired: clicking
    // it issues exactly one create POST.
    await user.click(submit);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([u, i]: any[]) => String(u).startsWith('/api/items/mirrored-databricks?') && i?.method === 'POST',
        ).length,
        'the re-attached button must actually submit the create',
      ).toBe(1),
    );
  });
});
