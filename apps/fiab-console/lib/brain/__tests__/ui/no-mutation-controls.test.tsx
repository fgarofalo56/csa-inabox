/**
 * NO CONTROL ON THIS SURFACE CAN MUTATE AZURE.
 *
 * PRP §1 decision 1 makes the Brain recommend-only, and the reason is measured
 * blast radius: of the Container App environments visible across these
 * subscriptions, most are NOT Loom's — the operator's blog, Sentinel, two Atlas
 * estates, and more. An autonomous mutation on a wrong ownership inference
 * destroys someone else's production.
 *
 * "Recommend-only" is easy to claim and easy to lose. Someone adds an "Apply"
 * button in six months, it looks helpful, and review does not catch it because
 * nothing fails. So it is asserted THREE ways, each of which fails
 * independently:
 *
 *   A. BEHAVIOURAL — render the surface with real findings, click EVERY control,
 *      and assert that the only network call any of them makes is the review
 *      POST, and that its body carries no imperative verb.
 *   B. LABELS — enumerate every rendered button and fail on any mutation verb
 *      in its accessible name. An "Apply" that is added later trips this even
 *      if nobody wires it up yet.
 *   C. SOURCE — scan the Brain's own modules for an ARM write. This one carries
 *      an EMBEDDED CONTROL: the same scanner is run over a synthetic violation
 *      and must flag it. A source scanner with nothing to find is green and
 *      blind, which is the single most repeated failure in this repo.
 *
 * (C) exists because (A) and (B) only see what is rendered. A mutation reachable
 * from a keyboard shortcut, an effect, or a route the UI does not link would
 * pass both.
 *
 * ── RESCOPE, #4242 (explicit contract amendment, not an evasion) ───────────
 * Execution now exists — behind the SEPARATE perform route this repo's own
 * doc-blocks always said it would live behind. The contract this file asserts
 * is therefore, precisely:
 *
 *   1. NO MUTATION CONTROL ON AN UNGUARDED FINDING: the review surface itself
 *      still renders no Apply/Delete/Scale control and still reaches only the
 *      review POST (the walks in A and B are UNCHANGED — they must stay green
 *      as-is until the guarded Perform UI lands with its own controls and its
 *      own tests).
 *   2. THE PERFORM POST IS THE ONLY MUTATION PATH: the executors live in
 *      `lib/brain-actions/**` — DELIBERATELY outside `lib/brain` and outside
 *      the roots scanned below, so the Brain's own tree stays honestly
 *      write-free — and the perform route in the scanned tree DELEGATES to
 *      them, carrying no inline Azure verb, behind server-re-derived guards
 *      (fresh snapshot, complete collection, fresh ownership tag read,
 *      non-vacuous detector, fresh ARM GET, staged two-step confirm).
 *
 * The P4 type invariants (`_ProposalsCannotSelfApprove` / `_ProposalsCannotMutate`)
 * and `assertInertRemediation` are untouched: a FINDING still cannot be an
 * action. Performing is a separate record about a finding, never a field on one.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { Recommendations } from '@/app/admin/brain/recommendations';
import type {
  PerformOutcomeResult,
  PerformRequestBody,
  PerformStateResult,
} from '@/app/admin/brain/perform-actions';
import { snapshotFromCollection } from '@/app/api/admin/brain/_lib/snapshot';
import { collection } from './estate-fixture';

const snapshot = snapshotFromCollection(collection());

function wrap(ui: ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

// ---------------------------------------------------------------------------
// THE SEAM THAT MADE THIS SCAN BLIND (#4260 review, should-fix 5)
// ---------------------------------------------------------------------------

/**
 * `Recommendations` defaults `loadPerformState` to the real `fetchPerformState`,
 * which issues a `fetch()` on a relative URL. In jsdom that throws, the component
 * lands `unavailable`, and NO perform control renders at all.
 *
 * So walks A and B below were examining a render in which the perform feature is
 * STRUCTURALLY ABSENT — and #4260's body then cited their green as evidence that
 * the mutation contract still held. A guard that cannot see its subject, offered
 * as proof about that subject.
 *
 * Both states are now DECLARED rather than inherited from a failed fetch:
 *
 *   REVIEW_ONLY  — an empty performability registry. The list renders the honest
 *                  "no executor for this class" bar per card and offers NO
 *                  perform control, so walks A and B keep asserting exactly what
 *                  their doc-block says: the review surface itself carries no
 *                  mutation control. The absence is now a fact about the
 *                  registry, not an artifact of jsdom.
 *   PERFORM_ON   — the registry the server really ships for `always-on-unused`.
 *                  Used by the allowlist walk at the bottom, which is the half
 *                  that can actually see the feature.
 */
const REVIEW_ONLY: PerformStateResult = { kind: 'ready', performability: [], states: [] };

const PERFORM_ON: PerformStateResult = {
  kind: 'ready',
  states: [],
  performability: [
    { detector: 'always-on-unused', performable: true, executor: 'scale-to-zero', destructive: true },
    { detector: 'unreachable-always-on', performable: true, executor: 'scale-to-zero', destructive: true },
    { detector: 'unreachable-service', performable: true, executor: 'scale-to-zero', destructive: true },
    { detector: 'orphan', performable: true, executor: 'delete-resource', destructive: true },
  ],
};

const reviewOnly = async (): Promise<PerformStateResult> => REVIEW_ONLY;

/**
 * The fixture's findings with ownership ESTABLISHED.
 *
 * The estate fixture stamps no ownership tag, so `performDisposition` returns
 * `withheld-ownership` for every finding and no Perform control renders — which
 * is the second half of why this scan could not see the feature, and is exactly
 * the accidental protection #4274 (tag stamping) and #4267 (backfill) remove.
 * The perform-enabled walks below therefore model the estate AFTER those land:
 * a scan that can only see the pre-tag world is a scan that goes blind the day
 * the tags arrive.
 */
const ownedFindings = snapshot.findings.map((f) => ({ ...f, ownershipConfirmed: true }));

// ---------------------------------------------------------------------------
// A + B — the rendered surface
// ---------------------------------------------------------------------------

/**
 * Verbs that would indicate a control does something to Azure.
 *
 * `Copy` and `Show on graph` are deliberately NOT here: copying a proposed diff
 * to the clipboard and panning a canvas are not mutations. `Refresh` is not
 * here either — it re-reads.
 *
 * `perform` was added in #4260 round 3. Its absence was the OTHER half of this
 * scan's blindness: the two controls the Perform UI adds are labelled "Perform
 * this recommendation" and "Confirm and perform", and not one verb in the list
 * matched either of them. The one string that did contain `scale` — the
 * `destructive · scale-to-zero` badge — is a `Badge`, outside the scanned
 * selector set. So even a render that DID show the feature would have passed.
 */
const MUTATION_VERBS = [
  'apply',
  'execute',
  'run now',
  'delete',
  'remove',
  'scale',
  'stop',
  'start',
  'restart',
  'deploy',
  'provision',
  'destroy',
  'terminate',
  'fix it',
  'remediate',
  'perform',
];

/**
 * Every interactive element, not just `<button>` — see the note in walk B.
 *
 * Rooted at `document.body`, NOT at RTL's render container. Fluent renders
 * `Dialog` through a PORTAL, so the staged confirm ("Confirm and perform") lands
 * outside the container entirely. MEASURED while writing the allowlist walk
 * below: a container-scoped enumeration reported `['perform']` with the confirm
 * dialog open on screen. Any mutation control added inside a portal — dialog,
 * popover, drawer, menu surface — was invisible to this scan.
 */
function interactiveControls(root: ParentNode = document.body): Element[] {
  return Array.from(
    root.querySelectorAll(
      'button, a[href], input[type="submit"], input[type="button"], [role="button"], [role="link"], [role="menuitem"]',
    ),
  );
}

function controlLabel(c: Element): string {
  return `${c.textContent ?? ''} ${c.getAttribute('aria-label') ?? ''} ${
    c.getAttribute('href') ?? ''
  }`.toLowerCase();
}

function mutationVerbHits(c: Element): string[] {
  const label = controlLabel(c);
  return MUTATION_VERBS.filter((v) => label.includes(v));
}

describe('B — no rendered control carries a mutation verb', () => {
  it('the fixture rendered findings (otherwise this scan is vacuous)', () => {
    expect(snapshot.findings.length).toBeGreaterThan(0);
  });

  it('enumerates every interactive control and finds no mutation verb', () => {
    wrap(
      <Recommendations
        findings={snapshot.findings}
        onFocusNode={() => {}}
        loadPerformState={reviewOnly}
      />,
    );

    // NOT just `getAllByRole('button')`. A mutation control added as a link, a
    // submit input, or a menu item would pass a button-only scan — and "add it
    // as an <a>" is exactly the narrow evasion that gets through a guard scoped
    // to one element type. Query the DOM for every interactive element instead.
    const controls = interactiveControls();

    // POPULATION: if this were 0 the scan would pass having examined nothing.
    expect(controls.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const c of controls) {
      for (const verb of mutationVerbHits(c)) {
        offenders.push(`${controlLabel(c).trim().slice(0, 80)} (matched '${verb}')`);
      }
    }
    expect(offenders, `mutation-verb control(s) on the Brain surface: ${offenders.join('; ')}`)
      .toEqual([]);
  });

  it('THE CONTROL FOR THE SEAM: the same walk over a PERFORM-ENABLED registry goes red', async () => {
    // Without this, the spec above is green for the wrong reason and nobody can
    // tell. It is the mutation receipt for #4260 should-fix 5, run in-suite:
    // hand the SAME render the registry the server really ships, and the verb
    // list + the seam together must now SEE the perform control that the old
    // walk (defaulted loader → failed fetch → `unavailable`) could not.
    wrap(
      <Recommendations
        findings={ownedFindings}
        onFocusNode={() => {}}
        loadPerformState={async () => PERFORM_ON}
      />,
    );
    await screen.findAllByTestId('perform');
    const offenders = interactiveControls().filter((c) => mutationVerbHits(c).length > 0);
    expect(offenders.length).toBeGreaterThan(0);
    expect(offenders.map((c) => c.getAttribute('data-testid'))).toContain('perform');
  });

  it('there are no forms that could POST anywhere', () => {
    // A <form action=...> needs no button label at all and would evade the scan
    // above entirely.
    const { container } = wrap(
      <Recommendations
        findings={snapshot.findings}
        onFocusNode={() => {}}
        loadPerformState={reviewOnly}
      />,
    );
    const forms = Array.from(container.querySelectorAll('form[action]'));
    expect(forms.map((f) => f.getAttribute('action'))).toEqual([]);
  });

  it('THE CONTROL FOR THIS SCAN: the same matcher flags a synthetic Apply button', () => {
    // Without this, a matcher with a typo'd verb list would report a clean
    // surface forever and nothing would say so.
    const label = 'apply change'.toLowerCase();
    expect(MUTATION_VERBS.some((v) => label.includes(v))).toBe(true);
    // …and the two labels the Perform UI actually ships, which nothing in the
    // pre-#4260 list matched.
    expect(MUTATION_VERBS.some((v) => 'perform this recommendation'.includes(v))).toBe(true);
    expect(MUTATION_VERBS.some((v) => 'confirm and perform'.includes(v))).toBe(true);
  });

  it('renders the recommend-only banner so the guarantee is stated to the operator', () => {
    wrap(
      <Recommendations
        findings={snapshot.findings}
        onFocusNode={() => {}}
        loadPerformState={reviewOnly}
      />,
    );
    expect(screen.getByTestId('recommend-only-banner').textContent).toContain(
      'Nothing on this page changes anything in Azure',
    );
  });
});

// ---------------------------------------------------------------------------
// B2 — the ALLOWLIST over a perform-enabled render (#4260 review, should-fix 5)
// ---------------------------------------------------------------------------

/**
 * TWO walks, because one of them was blind and claimed not to be.
 *
 * ── WHAT THE ROUND-4 REVIEW MEASURED, AND WHY IT WAS RIGHT ─────────────────
 * The first version of this block had ONE walk — `mutationControlIds()` — and a
 * doc-block claiming "a THIRD control added later trips it whether or not its
 * label happens to contain a verb anyone thought of." That was FALSE. The walk
 * pre-filters by `mutationVerbHits(c).length > 0` BEFORE the comparison, so a
 * verbless control never reaches it at all. Measured on `be407a9`:
 *
 *   <Button data-testid="ship-it" onClick={onConfirm}>Go</Button>
 *   added to DialogActions, primary, no `disabled` prop
 *   -> 94 passed | 0 failed   GREEN
 *
 * That is a control wired to the REAL execute handler, bypassing the typed-name
 * speed bump, invisible because "Go" contains no listed verb. Third independent
 * blindness on this one feature, after the portal root and the missing `perform`
 * verb — so the pattern, not any single spelling, is the thing to guard.
 *
 * ── THE SPLIT ──────────────────────────────────────────────────────────────
 *   `mutationControlIds()`      VERB-based, WHOLE document. Catches a
 *                               mutation-verb control ANYWHERE on the surface,
 *                               including outside the execute subtrees — e.g. an
 *                               "Apply" button dropped onto a finding card.
 *                               Its filter is the point; it is not an allowlist.
 *   `executeSubtreeControlIds()` UNFILTERED, execute subtrees ONLY. EVERY
 *                               interactive control inside `perform-block` or
 *                               `perform-confirm-dialog` must be named below —
 *                               verb or no verb, label or no label. This is the
 *                               one that has to be exhaustive, because the
 *                               subtree is where the execute handler lives.
 *
 * Neither subsumes the other: the first covers the whole page but only known
 * verbs; the second covers all controls but only where it matters most.
 */
const ALLOWED_MUTATION_CONTROLS = ['perform', 'perform-confirm'];

/**
 * EVERY control the execute subtrees are allowed to contain, by `data-testid`.
 * `perform-cancel` is in here because the walk is unfiltered, not because
 * cancelling mutates anything — that is exactly the property being asserted:
 * the set is CLOSED, so anything new must be added here deliberately.
 */
const ALLOWED_EXECUTE_SUBTREE_CONTROLS = ['perform', 'perform-cancel', 'perform-confirm'];

/** The subtrees that can reach the execute handler. */
const EXECUTE_SUBTREE_SELECTOR =
  '[data-testid="perform-block"], [data-testid="perform-confirm-dialog"]';

describe('B2 — a perform-enabled render carries EXACTLY the sanctioned controls', () => {
  function performEnabled(perform?: (b: PerformRequestBody) => Promise<PerformOutcomeResult>) {
    return wrap(
      <Recommendations
        findings={ownedFindings}
        onFocusNode={() => {}}
        loadPerformState={async () => PERFORM_ON}
        {...(perform ? { performRecommendation: perform } : {})}
      />,
    );
  }

  /**
   * Testids of every mutation-verb-matching control, deduped and sorted.
   * VERB-FILTERED and document-wide — see the block comment above. This one is
   * NOT the exhaustive guard; `executeSubtreeControlIds` is.
   */
  function mutationControlIds(): string[] {
    return [
      ...new Set(
        interactiveControls()
          .filter((c) => mutationVerbHits(c).length > 0)
          .map((c) => c.getAttribute('data-testid') ?? `UNLABELLED:${controlLabel(c).trim().slice(0, 60)}`),
      ),
    ].sort();
  }

  /**
   * Testids of EVERY interactive control inside the execute subtrees. No verb
   * filter, no label requirement: a control with no `data-testid` is reported
   * by its label, and a control with neither is reported as `UNLABELLED:` —
   * either way it lands in the comparison and fails the allowlist.
   */
  function executeSubtreeControlIds(): string[] {
    const roots = Array.from(document.querySelectorAll(EXECUTE_SUBTREE_SELECTOR));
    // POPULATION, inside the helper so no caller can forget it: an empty root
    // set would make every assertion below pass over nothing.
    expect(roots.length, 'no execute subtree rendered — this walk would be vacuous')
      .toBeGreaterThan(0);
    const ids: string[] = [];
    for (const root of roots) {
      for (const c of interactiveControls(root)) {
        ids.push(
          c.getAttribute('data-testid') ?? `UNLABELLED:${controlLabel(c).trim().slice(0, 60)}`,
        );
      }
    }
    return [...new Set(ids)].sort();
  }

  it('idle: the only mutation-capable control is the staged Perform button', async () => {
    performEnabled();
    const buttons = await screen.findAllByTestId('perform');
    // POPULATION — the feature really rendered, so "exactly one kind" is not
    // "nothing rendered".
    expect(buttons.length).toBeGreaterThan(0);
    expect(mutationControlIds()).toEqual(['perform']);
    // …and UNFILTERED over the execute subtree: nothing else is in there at
    // all, verb or no verb.
    expect(executeSubtreeControlIds()).toEqual(['perform']);
  });

  it('staged: the confirm joins it, and nothing else does', async () => {
    const staged = async (b: PerformRequestBody): Promise<PerformOutcomeResult> =>
      b.confirmToken
        ? { kind: 'refused', reason: 'not reached in this walk' }
        : {
            kind: 'staged',
            executor: 'scale-to-zero',
            confirmToken: 'tok',
            expiresAt: '2026-09-01T12:10:00.000Z',
            note: 'nothing changed',
          };
    performEnabled(staged);
    fireEvent.click((await screen.findAllByTestId('perform'))[0]!);
    await screen.findByTestId('perform-confirm-dialog');
    await waitFor(() => expect(mutationControlIds()).toEqual(ALLOWED_MUTATION_CONTROLS));
    // THE ONE THAT HAS TO BE EXHAUSTIVE. Unfiltered over both execute subtrees,
    // so a verbless control wired to `onConfirm` — the measured M12 bypass,
    // `<Button data-testid="ship-it" onClick={onConfirm}>Go</Button>` — lands in
    // this array and fails, where the verb-filtered walk above never sees it.
    expect(executeSubtreeControlIds()).toEqual(ALLOWED_EXECUTE_SUBTREE_CONTROLS);
    // Both subtrees really are in the walked set; otherwise the equality above
    // could hold over the block alone with the dialog unexamined.
    expect(document.querySelectorAll('[data-testid="perform-confirm-dialog"]').length).toBe(1);
    expect(
      document.querySelectorAll('[data-testid="perform-block"]').length,
    ).toBeGreaterThan(0);
  });

  it('every allowlisted control is a REAL testid on the surface, not a dead string', async () => {
    // Anti-drift: an allowlist entry that no longer matches anything would let a
    // renamed control disappear from the walk silently.
    const staged = async (b: PerformRequestBody): Promise<PerformOutcomeResult> =>
      b.confirmToken
        ? { kind: 'refused', reason: 'not reached' }
        : {
            kind: 'staged',
            executor: 'scale-to-zero',
            confirmToken: 'tok',
            expiresAt: 'later',
            note: '',
          };
    performEnabled(staged);
    fireEvent.click((await screen.findAllByTestId('perform'))[0]!);
    await screen.findByTestId('perform-confirm-dialog');
    for (const id of [...ALLOWED_MUTATION_CONTROLS, ...ALLOWED_EXECUTE_SUBTREE_CONTROLS]) {
      expect(screen.queryAllByTestId(id).length, `no control carries data-testid="${id}"`)
        .toBeGreaterThan(0);
    }
  });
});

describe('A — the control walk makes no mutating call', () => {
  it('Approve reaches ONLY the review endpoint, with a review decision', async () => {
    const calls: Array<{ id: string; decision: string }> = [];
    const owned = snapshot.findings.filter((f) => f.ownershipConfirmed);
    const findings = owned.length > 0 ? owned : snapshot.findings.map((f) => ({ ...f, ownershipConfirmed: true }));

    wrap(
      <Recommendations
        findings={findings}
        onFocusNode={() => {}}
        loadPerformState={reviewOnly}
        submitDecision={async (id, decision) => {
          calls.push({ id, decision });
          return { ok: true };
        }}
      />,
    );

    const approve = screen.getAllByTestId('approve');
    expect(approve.length).toBeGreaterThan(0);
    fireEvent.click(approve[0]!);

    await waitFor(() => expect(calls.length).toBe(1));
    // The ONLY verb the surface can send. `apply`/`execute` are rejected at the
    // route (asserted in authz-mutation.test.ts) and unreachable from here.
    expect(['approved', 'dismissed']).toContain(calls[0]!.decision);
  });

  it('after a decision the surface says nothing in Azure changed', async () => {
    const findings = snapshot.findings.map((f) => ({ ...f, ownershipConfirmed: true }));
    wrap(
      <Recommendations
        findings={findings}
        onFocusNode={() => {}}
        loadPerformState={reviewOnly}
        submitDecision={async () => ({ ok: true })}
      />,
    );
    fireEvent.click(screen.getAllByTestId('approve')[0]!);
    await waitFor(() => {
      expect(screen.getAllByTestId('decision-recorded')[0]!.textContent).toContain(
        'Nothing in Azure was changed',
      );
    });
  });

  it('a finding with UNESTABLISHED ownership offers no approve control at all', () => {
    const unowned = snapshot.findings.map((f) => ({ ...f, ownershipConfirmed: false }));
    wrap(<Recommendations findings={unowned} onFocusNode={() => {}} loadPerformState={reviewOnly} />);
    // Reported — reports cover all subscriptions...
    expect(screen.getAllByTestId('finding-card').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('ownership-withheld').length).toBeGreaterThan(0);
    // ...but not approvable.
    expect(screen.queryAllByTestId('approve')).toHaveLength(0);
    expect(screen.queryAllByTestId('dismiss')).toHaveLength(0);
  });

  it('the proposed change is rendered as TEXT to copy, never executed', () => {
    const findings = snapshot.findings.map((f) => ({ ...f, ownershipConfirmed: true }));
    wrap(<Recommendations findings={findings} onFocusNode={() => {}} loadPerformState={reviewOnly} />);

    // The proposal is VISIBLE BY DEFAULT (#4241 defect 10) — no expansion
    // needed. This is itself an assertion: a card whose actual proposed change
    // is hidden behind a drawer is the hierarchy defect that shipped.
    const pres = screen.getAllByTestId('proposed-change');
    expect(pres.length).toBeGreaterThan(0);
    // It is a <pre>, not a form action, an href, or a button.
    expect(pres[0]!.tagName.toLowerCase()).toBe('pre');

    // The accordion header still exists and says the change is NOT applied.
    const headers = screen.getAllByRole('button', { name: /Proposed change/i });
    expect(headers.length).toBeGreaterThan(0);
    expect(headers[0]!.textContent).toContain('not applied');

    // Evidence is still collapsed by default — expand it, so the behavioral
    // walk keeps one accordion toggle and confirms the toggle renders text
    // rather than doing anything.
    const evidence = screen.getAllByRole('button', { name: /Evidence/i });
    expect(evidence.length).toBeGreaterThan(0);
    fireEvent.click(evidence[0]!);
    expect(screen.getAllByText(/What the code established/).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// C — the source scan, with its embedded control
// ---------------------------------------------------------------------------

/**
 * An ARM write, as it would actually appear.
 *
 * ── A WEAKNESS THIS SCANNER HAD, AND HOW IT WAS FOUND ──────────────────────
 * The first version keyed on `method: 'X'` FOLLOWED BY an ARM path. It reported
 * the Brain clean — correctly, but by accident: the one real Azure call in the
 * tree (`arg-collect.ts`) writes the URL FIRST and the method second, so the
 * pattern simply never reached it. A violation written in that same, entirely
 * ordinary order would have been invisible.
 *
 * Passing is not evidence when the pattern cannot see the code. So the rules
 * below are ORDER-INDEPENDENT, and the genuinely-mutating verbs (PUT / PATCH /
 * DELETE) are banned outright rather than only near an ARM path — there is no
 * legitimate reason for any of them to appear in a read-only analysis surface.
 *
 * POST needs a narrower rule because two legitimate POSTs exist: the Resource
 * Graph QUERY endpoint (POST is how ARG accepts a query; the endpoint has no
 * mutating operation) and the Brain's own review-decision route. Both are
 * named explicitly, so adding a third POST anywhere trips this.
 */
interface MutationRule {
  readonly name: string;
  readonly find: (src: string) => boolean;
}

const MUTATING_VERB = /method:\s*['"`](PUT|PATCH|DELETE)['"`]/i;
const POST_CALL = /method:\s*['"`]POST['"`]/i;
const POST_CALL_G = /method:\s*['"`]POST['"`]/gi;
const ALLOWED_POST_TARGETS = [
  'providers/Microsoft.ResourceGraph/resources', // ARG query API — no mutating op
  '/api/admin/brain/proposals', // the Brain's own review-decision route
  // #4242 — THE ONE SANCTIONED MUTATION PATH. Guarded by the four-layer design:
  // the executors live in lib/brain-actions/** (outside lib/brain and outside
  // this scan's roots), the route delegates (asserted below — it carries no
  // inline ARM verb), every guard is re-derived server-side at execute time,
  // and destructive classes stage a two-step confirm. A client POSTing here is
  // invoking that guarded path, not writing to Azure itself.
  '/api/admin/brain/perform',
];

/**
 * The POST rule is bound to the CALL SITE, not the file (#4246 review — a
 * measured bypass). The first version tested `src.includes(target)` over the
 * WHOLE file, so any file whose doc-block happened to contain an allow-token
 * (the perform route's header literally names `/api/admin/brain/perform`)
 * could carry an unrelated inline ARM POST-*action* — `…/containerApps/x/
 * restart`, `…/start`, `…/stop` are all POSTs — and stay green.
 *
 * Now the allowed target must appear WITHIN THE SAME CALL as the `method:
 * 'POST'` key: a 400-chars-back / 200-forwards window around the match, sized
 * from the real shapes in this tree (arg-collect.ts writes the URL ~100 chars
 * before the method; the review-route fetches are single-line). A doc-block
 * token elsewhere in the file no longer launders anything. The window is an
 * approximation of "same statement" — its own control below proves a
 * far-token + POST pair goes red.
 */
function postCallsOutsideAllowedTargets(src: string): number {
  let offenders = 0;
  for (const m of src.matchAll(POST_CALL_G)) {
    const at = m.index ?? 0;
    const window = src.slice(Math.max(0, at - 400), at + 200);
    if (!ALLOWED_POST_TARGETS.some((t) => window.includes(t))) offenders += 1;
  }
  return offenders;
}

const MUTATION_RULES: readonly MutationRule[] = [
  {
    name: 'mutating HTTP verb (PUT/PATCH/DELETE)',
    // Order-independent by construction: it does not care what is near it.
    find: (src) => MUTATING_VERB.test(src),
  },
  {
    name: 'POST whose own call site names no allowed target',
    // POST_CALL is the cheap pre-filter; the per-call window does the work.
    find: (src) => POST_CALL.test(src) && postCallsOutsideAllowedTargets(src) > 0,
  },
  {
    name: 'az CLI mutation',
    find: (src) => /\baz\s+(containerapp|resource|group|webapp)\s+(update|delete|create|scale|stop|start)\b/i.test(src),
  },
  {
    name: 'ARM write helper',
    find: (src) => /\barm(Put|Patch|Delete|Post)\s*\(/.test(src),
  },
  {
    name: 'Azure SDK mutation call',
    find: (src) => /\.(beginCreateOrUpdate|beginDelete|createOrUpdate|deleteMethod)\s*\(/.test(src),
  },
];

function scanForMutations(source: string): string[] {
  return MUTATION_RULES.filter((r) => r.find(source)).map((r) => r.name);
}

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('C — the Brain source contains no Azure write', () => {
  const roots = [
    join(process.cwd(), 'app', 'admin', 'brain'),
    join(process.cwd(), 'app', 'api', 'admin', 'brain'),
  ];
  const files = roots.flatMap((r) => collectFiles(r));

  it('THE CONTROL: the scanner flags a synthetic ARM write, in EITHER order', () => {
    // This runs FIRST on purpose. A scanner over a clean tree returns [] whether
    // it works or not; this is the only evidence that a real violation would be
    // caught. Every rule gets its own synthetic violation, so one broken rule is
    // visible rather than masked by the others.
    expect(scanForMutations(`await fetch(url, { method: 'DELETE' })`)).not.toEqual([]);
    expect(scanForMutations(`await fetch(url, { method: 'PATCH' })`)).not.toEqual([]);
    expect(scanForMutations(`await exec('az containerapp update --min-replicas 0')`)).not.toEqual([]);
    expect(scanForMutations(`await armPut(id, body)`)).not.toEqual([]);
    expect(scanForMutations(`await client.beginCreateOrUpdate(rg, name, body)`)).not.toEqual([]);
    expect(scanForMutations(`await fetch('https://x/api/scale', { method: 'POST' })`)).not.toEqual([]);
  });

  it('ORDER INDEPENDENCE: a write with the URL written first is still caught', () => {
    // The bug the first version of this scanner had. `arg-collect.ts` writes the
    // URL first and the method second — an entirely ordinary style — and the
    // original `method-then-path` pattern could not see that shape at all. It
    // reported the Brain clean for the wrong reason.
    const urlFirst = `
      const res = await doFetch(
        \`\${base}/subscriptions/x/providers/Microsoft.App/containerApps/y?api-version=2024-03-01\`,
        { method: 'PATCH', body: JSON.stringify({ properties: {} }) },
      );`;
    expect(scanForMutations(urlFirst)).not.toEqual([]);
  });

  it('THE CONTROL for the call-site binding: a doc-block allow-token does NOT launder a distant POST', () => {
    // The reviewer's measured bypass on #4246: perform/route.ts's header
    // legitimately names /api/admin/brain/perform, and under the old
    // file-scoped rule that token exempted an inline ARM POST-action appended
    // hundreds of lines later. Reconstruct exactly that shape — allow-token
    // far away, ARM restart POST at the end — and require it flagged.
    const probe =
      `// BFF — POST /api/admin/brain/perform — delegates to lib/brain-actions\n` +
      `${'// padding line to separate the doc-block from the call site\n'.repeat(12)}` +
      `const r = await doFetch(\n` +
      `  \`\${base}/subscriptions/x/resourceGroups/y/providers/Microsoft.App/containerApps/z/restart?api-version=2024-03-01\`,\n` +
      `  { method: 'POST' },\n` +
      `);`;
    expect(scanForMutations(probe)).not.toEqual([]);
    // And the pre-filter alone would have passed it — the window is what bites.
    expect(ALLOWED_POST_TARGETS.some((t) => probe.includes(t))).toBe(true);
  });

  it('and does NOT flag the two legitimate POSTs', () => {
    // A scanner that flags everything is as useless as one that flags nothing.
    expect(
      scanForMutations(
        `await doFetch(\`\${base}/providers/Microsoft.ResourceGraph/resources\`, { method: 'POST' })`,
      ),
    ).toEqual([]);
    expect(
      scanForMutations(`await fetch('/api/admin/brain/proposals', { method: 'POST' })`),
    ).toEqual([]);
  });

  it('examined a non-empty set of Brain source files', () => {
    // POPULATION. A scan over zero files is green and blind.
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it('finds no mutation in any Brain module', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const hits = scanForMutations(readFileSync(f, 'utf8'));
      if (hits.length > 0) offenders.push(`${f}: ${hits.join(', ')}`);
    }
    expect(offenders, `Azure write found in the Brain: ${offenders.join(' | ')}`).toEqual([]);
  });

  it('#4242: the perform route is IN the walked set and carries NO inline Azure verb', () => {
    // The perform route is the one sanctioned mutation path, and the contract
    // is that it DELEGATES: its executors live in lib/brain-actions/**,
    // deliberately outside these roots and outside lib/brain, behind the
    // server-re-derived guard chain. If someone inlines an ARM write into the
    // route file itself, the walk above goes red — this spec additionally
    // proves the file is actually in the walked population (a route that moved
    // out of the scanned roots would otherwise pass silently) and that it
    // still imports the guarded orchestrator rather than an ARM client.
    const performRoute = files.find((f) =>
      f.includes(join('api', 'admin', 'brain', 'perform', 'route.ts')),
    );
    expect(performRoute, 'perform/route.ts must be inside the scanned roots').toBeDefined();
    const src = readFileSync(performRoute!, 'utf8');
    expect(scanForMutations(src)).toEqual([]);
    expect(src).toContain("@/lib/brain-actions/perform");
  });

  it('the only Azure call in the Brain is the Resource Graph QUERY', () => {
    const arg = readFileSync(
      join(process.cwd(), 'app', 'api', 'admin', 'brain', '_lib', 'arg-collect.ts'),
      'utf8',
    );
    // It IS a POST — Resource Graph's query endpoint is POST — so the shape
    // check above cannot distinguish it from a write by method alone. The
    // distinguishing fact is the PATH: /providers/Microsoft.ResourceGraph/resources
    // is a query API with no mutating operation.
    expect(arg).toContain('providers/Microsoft.ResourceGraph/resources');
    expect(arg).not.toMatch(/method:\s*['"`](PUT|PATCH|DELETE)['"`]/);
  });
});

describe('P4 — a proposal cannot declare itself an action', () => {
  it('every remediation pins requiresHumanApproval and mutatesAzure', () => {
    expect(snapshot.findings.length).toBeGreaterThan(0);
    for (const f of snapshot.findings) {
      expect(f.remediation.kind).toBe('proposal');
      expect(f.remediation.requiresHumanApproval).toBe(true);
      expect(f.remediation.mutatesAzure).toBe(false);
    }
  });
});
