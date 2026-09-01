/**
 * BRAIN — the PERFORM UI (#4242, UI lane).
 *
 * The backend already refuses everything it should: the executor registry, the
 * guard chain re-derived server-side, the staged single-use token, the etag
 * arbitration. So the specs here are NOT a second copy of those guards — they
 * assert the properties that are the CLIENT's alone to lose:
 *
 *   1. NOTHING EXECUTES WITHOUT THE TYPED CONFIRM. The first click stages; the
 *      dialog's confirm is the only control that sends a token, and it stays
 *      disabled until the resource name is typed exactly.
 *   2. THE TOKEN IS THE SERVER'S. The confirm leg carries back exactly the
 *      string the stage response returned — never a value this code invented,
 *      defaulted, or carried over from a different staging.
 *   3. A REFUSAL IS RENDERED, NEVER A DEAD BUTTON. A finding the server says is
 *      not performable shows the server's own reason (`ux-baseline.md` G2), and
 *      an unknown detector shows that it is unknown rather than nothing.
 *   4. THE OUTCOME IS STATED ONLY AS FIRMLY AS IT WAS ESTABLISHED
 *      (`deploy-integrity.md` R7). A 502 says the write was attempted and the
 *      result is not established; an unrecognised status says so too. Neither
 *      is allowed to claim "nothing changed".
 *   5. `persisted:false` IS DISCLOSED. A confirmed write whose record did not
 *      land is a real, visible condition, not a detail to swallow.
 *   6. THE PERSISTED STATE IS REFLECTED. A reload shows the decision, the
 *      receipt or the real error — the decision-amnesia the state store cures.
 *   7. THE HEADER BANNER IS TRUE IN BOTH DIRECTIONS. It may claim "nothing on
 *      this page changes anything in Azure" ONLY while the page offers no
 *      Perform control. That claim is the one the long-standing
 *      `lib/brain/__tests__/ui/no-mutation-controls.test.tsx` contract reads,
 *      and it stays honest here because it is DERIVED from what rendered.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { Recommendations } from '../recommendations';
import {
  PerformControls,
  interpretPerformResponse,
  subjectResourceName,
  type PerformOutcomeResult,
  type PerformRequestBody,
  type PerformStateResult,
} from '../perform-actions';
import type { WireFinding } from '@/app/api/admin/brain/_lib/wire';
import type {
  PerformReceipt,
  PerformRegistryEntry,
  RecommendationStateRecord,
} from '@/lib/brain-actions/types';

// ---------------------------------------------------------------------------
// Fixtures — built here rather than pulled from the estate fixture so the
// detector kinds under test are explicit and cannot drift when the estate
// fixture changes.
//
// ── ONE CONSTRAINT ON FIXTURE STRINGS, MEASURED ────────────────────────────
// `no-mutation-controls.test.tsx`'s source scan (C) walks `app/admin/brain/**`,
// which now includes THIS directory. A first draft wrote `proposedChange` as a
// runnable Azure CLI scale command and turned that scan red — correctly: the
// rule bans a CLI mutation verb anywhere in the Brain's tree and it cannot tell
// a fixture from a call site. It is also not what the detectors actually emit:
// `lib/brain/detectors/always-on-unused.ts` proposes prose ("propose
// minReplicas 0 so it scales to zero between calls"), never a runnable command.
// The fixture below matches the real shape. Do not "fix" the scan.
// ---------------------------------------------------------------------------

const SUBJECT =
  'azure:/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg-loom/providers/microsoft.app/containerapps/loom-console';

function finding(over: Partial<WireFinding> = {}): WireFinding {
  return {
    id: 'f-always-on-1',
    detector: 'always-on-unused',
    severity: 'medium',
    title: 'loom-console is always-on and unreachable',
    summary: 'minReplicas is 1 with no inbound configured edge.',
    subjects: [SUBJECT],
    confidence: 'high',
    remediation: {
      kind: 'proposal',
      summary: 'Drop the always-on floor to zero.',
      proposedChange:
        'Confirm nothing calls loom-console, then propose minReplicas 0 so it scales to zero between calls.',
      requiresHumanApproval: true,
      mutatesAzure: false,
    },
    population: {
      subject: 'nodes',
      examined: 29,
      edgesExamined: 140,
      scope: '29 azure-resource nodes of type Microsoft.App/containerApps',
      blind: false,
      byProvenance: { declared: 0, configured: 140, imports: 0, observed: 0, owns: 3 },
    },
    evidence: {
      nodes: [SUBJECT],
      edges: [],
      query: 'nodesWithNoInboundEdge(g, "configured")',
      notes: ['minReplicas=1', 'inbound configured edges = 0'],
    },
    ownershipConfirmed: true,
    ...over,
  } as WireFinding;
}

const PERFORMABLE: PerformRegistryEntry = {
  detector: 'always-on-unused',
  performable: true,
  executor: 'scale-to-zero',
  destructive: true,
};

const NOT_PERFORMABLE_REASON =
  'The remediation for this finding is a REPOSITORY EDIT (the empty env wire is authored in bicep).';

const NOT_PERFORMABLE: PerformRegistryEntry = {
  detector: 'dangling-empty-wire',
  performable: false,
  notPerformableReason: NOT_PERFORMABLE_REASON,
};

function ready(
  performability: readonly PerformRegistryEntry[] = [PERFORMABLE, NOT_PERFORMABLE],
  states: readonly RecommendationStateRecord[] = [],
): PerformStateResult {
  return { kind: 'ready', performability, states };
}

const RECEIPT: PerformReceipt = {
  executor: 'scale-to-zero',
  detector: 'always-on-unused',
  findingId: 'f-always-on-1',
  resourceId:
    '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-loom/providers/Microsoft.App/containerApps/loom-console',
  before: { minReplicas: 1, maxReplicas: 3, provisioningState: 'Succeeded' },
  after: { minReplicas: 0, maxReplicas: 3, provisioningState: 'Succeeded' },
  performedAt: '2026-09-01T12:00:00.000Z',
  mutatedAzure: true,
};

function wrap(ui: ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

/** The claim the long-standing `no-mutation-controls` contract reads. */
const SENTENCE = 'Nothing on this page changes anything in Azure';

/**
 * A perform seam that stages on the tokenless leg and performs on the token
 * leg — i.e. the real two-step shape. Module-scope because the withdrawal and
 * banner specs below drive the SAME flow and must not fork a second stub that
 * could drift from this one.
 */
function stagingPerform() {
  const calls: PerformRequestBody[] = [];
  const perform = async (b: PerformRequestBody): Promise<PerformOutcomeResult> => {
    calls.push(b);
    if (!b.confirmToken) {
      return {
        kind: 'staged',
        executor: 'scale-to-zero',
        confirmToken: 'server-minted-token-abc',
        expiresAt: '2026-09-01T12:10:00.000Z',
        note: 'Nothing was changed in Azure.',
      };
    }
    return { kind: 'performed', receipt: RECEIPT, persisted: true };
  };
  return { calls, perform };
}

/** Render one performable finding and land `outcome` on the first click. */
async function performOnce(outcome: PerformOutcomeResult) {
  const perform = async (): Promise<PerformOutcomeResult> => outcome;
  renderList({ perform });
  fireEvent.click(await screen.findByTestId('perform'));
}

/** Drive stage → type → confirm to a real receipt. */
async function stageTypeAndConfirm() {
  fireEvent.click(await screen.findByTestId('perform'));
  await screen.findByTestId('perform-confirm-dialog');
  fireEvent.change(screen.getByTestId('perform-confirm-input'), {
    target: { value: 'loom-console' },
  });
  fireEvent.click(screen.getByTestId('perform-confirm'));
  await screen.findByTestId('perform-receipt');
}

/** Render the list with the perform seams injected. */
function renderList(opts: {
  findings?: readonly WireFinding[];
  state?: PerformStateResult;
  perform?: (b: PerformRequestBody) => Promise<PerformOutcomeResult>;
  loadPerformState?: () => Promise<PerformStateResult>;
}) {
  const load = opts.loadPerformState ?? (async () => opts.state ?? ready());
  const perform =
    opts.perform ??
    (async () =>
      ({ kind: 'indeterminate', reason: 'no perform stub was supplied' }) as PerformOutcomeResult);
  return wrap(
    <Recommendations
      findings={opts.findings ?? [finding()]}
      onFocusNode={() => {}}
      loadPerformState={load}
      performRecommendation={perform}
    />,
  );
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('subjectResourceName', () => {
  it('takes the ARM resource name out of a brain node id', () => {
    expect(subjectResourceName(SUBJECT)).toBe('loom-console');
  });

  it('survives a trailing slash and a prefix-less id', () => {
    expect(subjectResourceName('azure:/subscriptions/s/x/loom-api/')).toBe('loom-api');
    expect(subjectResourceName('loom-api')).toBe('loom-api');
  });
});

describe('interpretPerformResponse — R7: only as firm as the response established', () => {
  it('maps a staging', () => {
    const r = interpretPerformResponse(200, {
      ok: true,
      staged: true,
      executor: 'scale-to-zero',
      confirmToken: 'tok',
      expiresAt: 'later',
      note: 'nothing changed',
    });
    expect(r.kind).toBe('staged');
  });

  it('maps a receipt', () => {
    const r = interpretPerformResponse(200, { ok: true, performed: true, receipt: RECEIPT, persisted: true });
    expect(r.kind).toBe('performed');
  });

  it('a 409 is a refusal, carrying the guard', () => {
    const r = interpretPerformResponse(409, { ok: false, error: 'REFUSED: …', guard: 'ownership-confirmed' });
    expect(r).toMatchObject({ kind: 'refused', guard: 'ownership-confirmed' });
  });

  it('a 503 is an honest infra gate, not a failure', () => {
    expect(interpretPerformResponse(503, { ok: false, error: 'LOOM_COSMOS_ENDPOINT is not set' }).kind).toBe(
      'gate',
    );
  });

  it('a 502 is a failure whose Azure outcome is NOT claimed either way', () => {
    const r = interpretPerformResponse(502, { ok: false, error: 'ARM 429', mutationConfirmed: false });
    expect(r.kind).toBe('failed');
  });

  it('an ok:true body that states no outcome is INDETERMINATE, never a success', () => {
    const r = interpretPerformResponse(200, { ok: true });
    expect(r.kind).toBe('indeterminate');
  });

  it('an unrecognised status is INDETERMINATE and says the outcome was not established', () => {
    const r = interpretPerformResponse(500, { ok: false, error: 'boom' });
    expect(r.kind).toBe('indeterminate');
    expect(r.kind === 'indeterminate' && r.reason).toContain('NOT established');
  });
});

// ---------------------------------------------------------------------------
// Render states
// ---------------------------------------------------------------------------

describe('the honest not-performable state (G2 — never a dead button)', () => {
  it("renders the SERVER's reason for a class the platform cannot perform", async () => {
    renderList({
      findings: [finding({ id: 'f-wire', detector: 'dangling-empty-wire' })],
      state: ready(),
    });
    const bar = await screen.findByTestId('perform-not-performable');
    expect(bar.textContent).toContain(NOT_PERFORMABLE_REASON);
    expect(screen.queryAllByTestId('perform')).toHaveLength(0);
  });

  it('a detector absent from the registry says it is UNKNOWN — not silently nothing', async () => {
    renderList({
      findings: [finding({ id: 'f-new', detector: 'brand-new-detector' })],
      state: ready([PERFORMABLE]),
    });
    const bar = await screen.findByTestId('perform-not-performable');
    expect(bar.getAttribute('data-detector')).toBe('brand-new-detector');
    expect(bar.textContent).toContain("performability registry");
    expect(screen.queryAllByTestId('perform')).toHaveLength(0);
  });

  it('a performable class with UNESTABLISHED ownership is withheld, with the reason', async () => {
    renderList({ findings: [finding({ ownershipConfirmed: false })], state: ready() });
    expect((await screen.findByTestId('perform-withheld-ownership')).textContent).toContain(
      'ownership',
    );
    expect(screen.queryAllByTestId('perform')).toHaveLength(0);
  });

  it('a performable, owned finding gets the Perform control and its executor class', async () => {
    renderList({ state: ready() });
    expect(await screen.findByTestId('perform')).toBeTruthy();
    expect(screen.getByTestId('perform-class').textContent).toContain('scale-to-zero');
  });
});

describe('the perform-state read-back could not be read', () => {
  it('discloses the failure ONCE for the whole list, and offers no Perform action', async () => {
    // #4260 review, should-fix 4: every card also rendered its own copy of this
    // warning, so a 30-finding estate showed 31 identical warning MessageBars.
    const findings = [finding(), finding({ id: 'f-2' }), finding({ id: 'f-3' })];
    renderList({ findings, state: { kind: 'unavailable', reason: 'the read-back answered HTTP 503' } });

    const bar = await screen.findByTestId('perform-state-disclosure');
    expect(bar.textContent).toContain('HTTP 503');
    expect(screen.queryAllByTestId('perform')).toHaveLength(0);
    // And it does NOT collapse "unreadable" into "not performable" — the
    // sentence moved here with the bar rather than being dropped.
    expect(bar.textContent).toContain('not evidence that the platform cannot act');

    // POPULATION first: three cards rendered, so "zero per-card bars" is not
    // zero because nothing rendered.
    expect(screen.getAllByTestId('finding-card')).toHaveLength(3);
    expect(screen.queryAllByTestId('perform-state-disclosure')).toHaveLength(1);
    expect(screen.queryAllByTestId('perform-state-unavailable')).toHaveLength(0);
  });

  it('the per-card bar still exists for a consumer that shows NO list-level disclosure', () => {
    // Anti-vacuity for the spec above: the suppression must be a suppression,
    // not a deletion. A standalone `PerformControls` still discloses.
    wrap(
      <PerformControls
        findingId="f-always-on-1"
        detector="always-on-unused"
        subjects={[SUBJECT]}
        ownershipConfirmed
        state={{ kind: 'unavailable', reason: 'the read-back answered HTTP 503' }}
        perform={async () => ({ kind: 'indeterminate', reason: 'not reached' })}
        performedInSession={new Set<string>()}
        onPerformed={() => {}}
        stateNoticeShownAtListLevel={false}
      />,
    );
    expect(screen.getByTestId('perform-state-unavailable').textContent).toContain('HTTP 503');
  });

  it('Retry re-invokes the loader', async () => {
    const load = vi
      .fn<() => Promise<PerformStateResult>>()
      .mockResolvedValueOnce({ kind: 'unavailable', reason: 'first read failed.' })
      .mockResolvedValue(ready());
    renderList({ loadPerformState: load });
    fireEvent.click(await screen.findByTestId('perform-state-retry'));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('perform')).toBeTruthy();
  });

  it('a loader that REJECTS becomes a rendered disclosure, never a missing control', async () => {
    renderList({ loadPerformState: async () => Promise.reject(new Error('network down')) });
    expect((await screen.findByTestId('perform-state-disclosure')).textContent).toContain(
      'network down',
    );
  });
});

// ---------------------------------------------------------------------------
// The staged two-step confirm
// ---------------------------------------------------------------------------

describe('the staged confirm — NOTHING executes without the typed confirm', () => {
  it('the first click STAGES: one call, no token, and the dialog says nothing changed yet', async () => {
    const { calls, perform } = stagingPerform();
    renderList({ perform });
    fireEvent.click(await screen.findByTestId('perform'));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.confirmToken).toBeUndefined();
    // The body is the three lookup keys and nothing else — no resource id, no
    // executor choice, nothing the server would have to trust.
    expect(Object.keys(calls[0]!).sort()).toEqual(['detector', 'findingId', 'subjectNodeId']);

    const dialog = await screen.findByTestId('perform-confirm-dialog');
    expect(dialog.textContent).toContain('Nothing has changed yet');
  });

  it('the confirm stays DISABLED until the resource name is typed exactly, and sends nothing meanwhile', async () => {
    const { calls, perform } = stagingPerform();
    renderList({ perform });
    fireEvent.click(await screen.findByTestId('perform'));
    await screen.findByTestId('perform-confirm-dialog');

    const confirmBtn = screen.getByTestId('perform-confirm') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    fireEvent.change(screen.getByTestId('perform-confirm-input'), { target: { value: 'loom-conso' } });
    expect((screen.getByTestId('perform-confirm') as HTMLButtonElement).disabled).toBe(true);

    // A click on the disabled control must not execute — assert the CALL COUNT,
    // not merely the attribute, because "disabled" is a claim about the DOM and
    // the property under test is that no second request left the client.
    fireEvent.click(screen.getByTestId('perform-confirm'));
    expect(calls.length).toBe(1);
  });

  it('typing the exact name enables the confirm, and the confirm carries the SERVER-minted token', async () => {
    const { calls, perform } = stagingPerform();
    renderList({ perform });
    fireEvent.click(await screen.findByTestId('perform'));
    await screen.findByTestId('perform-confirm-dialog');

    fireEvent.change(screen.getByTestId('perform-confirm-input'), {
      target: { value: 'loom-console' },
    });
    const confirmBtn = screen.getByTestId('perform-confirm') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]!.confirmToken).toBe('server-minted-token-abc');
    expect(calls[1]!.findingId).toBe('f-always-on-1');
    expect(calls[1]!.subjectNodeId).toBe(SUBJECT);

    // …and the REAL receipt is rendered, before and after.
    const before = await screen.findByTestId('perform-receipt-before');
    expect(before.textContent).toContain('"minReplicas": 1');
    expect(screen.getByTestId('perform-receipt-after').textContent).toContain('"minReplicas": 0');
  });

  it('Cancel leaves the estate untouched — no second call', async () => {
    const { calls, perform } = stagingPerform();
    renderList({ perform });
    fireEvent.click(await screen.findByTestId('perform'));
    await screen.findByTestId('perform-confirm-dialog');
    fireEvent.click(screen.getByTestId('perform-cancel'));
    await waitFor(() => expect(screen.queryByTestId('perform-confirm-dialog')).toBeNull());
    expect(calls.length).toBe(1);
  });

  it('re-staging RESETS the typed confirm — a cancel never leaves the speed bump pre-satisfied', async () => {
    // #4260 review, M8: the reviewer deleted `setTyped('')` from `stage()` and
    // this suite stayed 35/35 green. The live code was correct and completely
    // unguarded, so a later edit could have removed it in silence. What it
    // protects: type the name, cancel, re-stage — without the reset the dialog
    // reopens carrying the previous text and "Confirm and perform" is already
    // live with zero typing, which is no second gate at all.
    const { perform } = stagingPerform();
    renderList({ perform });
    fireEvent.click(await screen.findByTestId('perform'));
    await screen.findByTestId('perform-confirm-dialog');
    fireEvent.change(screen.getByTestId('perform-confirm-input'), {
      target: { value: 'loom-console' },
    });
    // Precondition — otherwise this spec could pass over a dialog that never
    // accepted the text in the first place.
    expect((screen.getByTestId('perform-confirm') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('perform-cancel'));
    await waitFor(() => expect(screen.queryByTestId('perform-confirm-dialog')).toBeNull());

    fireEvent.click(screen.getByTestId('perform'));
    await screen.findByTestId('perform-confirm-dialog');
    expect((screen.getByTestId('perform-confirm-input') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('perform-confirm') as HTMLButtonElement).disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The control is WITHDRAWN once it has been performed (#4260 review, blocker 1)
// ---------------------------------------------------------------------------

describe('a performed control is withdrawn, never re-armed under its own receipt', () => {
  it('an IN-SESSION perform withdraws the Perform button and says why', async () => {
    // MEASURED on the shipped code: after a successful in-session perform the
    // button was still rendered and ENABLED (`buttons=1 disabled=false`), and a
    // re-click issued a fresh staging call with `token=undefined`. The server
    // refuses the second attempt — every guard is re-derived from a fresh
    // snapshot — so this was never a hole, but it invited a click that lands on
    // a red refusal directly beneath a receipt saying it already succeeded.
    const { calls, perform } = stagingPerform();
    renderList({ perform });
    await stageTypeAndConfirm();

    // GONE, not merely disabled: a disabled button is one someone re-enables.
    expect(screen.queryAllByTestId('perform')).toHaveLength(0);
    const already = screen.getByTestId('perform-already');
    expect(already.getAttribute('data-performed-via')).toBe('session');
    expect(already.textContent).toContain('withdrawn');
    // Two calls total — the staging and the confirm. No third could be issued.
    expect(calls.length).toBe(2);
  });

  it('a FAILED outcome does NOT withdraw it — the withdrawal is not blanket', async () => {
    // Anti-vacuity for the spec above: if `settle` withdrew on every outcome,
    // that one would still pass and the operator would lose the retry on a
    // write that never landed.
    await performOnce({
      kind: 'failed',
      error: 'ARM status 429: too many requests',
      executor: 'scale-to-zero',
    });
    await screen.findByTestId('perform-failed');
    expect(screen.queryAllByTestId('perform')).toHaveLength(1);
    expect(screen.queryByTestId('perform-already')).toBeNull();
  });

  it('a persisted PERFORMED record withdraws it too, and says the receipt is above', async () => {
    renderList({ state: ready([PERFORMABLE], [record({ state: 'performed', receipt: RECEIPT })]) });
    const already = await screen.findByTestId('perform-already');
    expect(already.getAttribute('data-performed-via')).toBe('record');
    expect(screen.queryAllByTestId('perform')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

describe('outcomes are rendered honestly', () => {
  it('a guard refusal shows the guard and the server reason', async () => {
    await performOnce({
      kind: 'refused',
      guard: 'snapshot-complete',
      reason: 'REFUSED: the fresh estate pull is INCOMPLETE',
    });
    const bar = await screen.findByTestId('perform-refused');
    expect(bar.textContent).toContain('snapshot-complete');
    expect(bar.textContent).toContain('INCOMPLETE');
  });

  it('an infra gate is rendered as a gate, naming what the deploy did not set', async () => {
    await performOnce({ kind: 'gate', reason: 'LOOM_COSMOS_ENDPOINT is not set' });
    expect((await screen.findByTestId('perform-gate')).textContent).toContain(
      'LOOM_COSMOS_ENDPOINT',
    );
  });

  it('a failure carries the classified error and REFUSES to claim nothing changed (R7)', async () => {
    await performOnce({ kind: 'failed', error: 'ARM status 429: too many requests', executor: 'scale-to-zero' });
    const bar = await screen.findByTestId('perform-failed');
    expect(bar.textContent).toContain('ARM status 429');
    expect(bar.textContent).toContain('NOT established');
  });

  it('an indeterminate call says the outcome was not established', async () => {
    await performOnce({ kind: 'indeterminate', reason: 'the request did not complete (socket hang up).' });
    expect((await screen.findByTestId('perform-indeterminate')).textContent).toContain(
      'socket hang up',
    );
  });

  it('persisted:false is DISCLOSED next to the receipt, never swallowed', async () => {
    await performOnce({
      kind: 'performed',
      receipt: RECEIPT,
      persisted: false,
      persistError: 'Cosmos 503',
    });
    const bar = await screen.findByTestId('perform-not-persisted');
    expect(bar.textContent).toContain('Cosmos 503');
    expect(bar.textContent).toContain('as if it had never been performed');
    // The receipt is still shown — a store outage does not un-claim the write.
    expect(screen.getByTestId('perform-receipt')).toBeTruthy();
  });

  it('persisted:true shows the receipt and NO disclosure', async () => {
    await performOnce({ kind: 'performed', receipt: RECEIPT, persisted: true });
    expect(await screen.findByTestId('perform-receipt')).toBeTruthy();
    expect(screen.queryByTestId('perform-not-persisted')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R7 — a TITLE is an assertion too (#4260 review, should-fix 1)
// ---------------------------------------------------------------------------

describe('R7 — the MessageBar titles assert only what the response established', () => {
  it('splits the route’s TWO 409s on the field the route already sends', () => {
    // `route.ts` answers 409 twice over: `refused` carries `performable:true` +
    // `guard`; `not-performable` carries `performable:false` + `detector` and
    // NO guard, because no guard was ever reached. The discriminator was on
    // the wire the whole time and this client ignored it.
    expect(
      interpretPerformResponse(409, {
        ok: false,
        error: 'REFUSED: no resolved ownership edge covers the subject',
        performable: true,
        guard: 'ownership-confirmed',
      }),
    ).toMatchObject({ kind: 'refused', guard: 'ownership-confirmed' });

    expect(
      interpretPerformResponse(409, {
        ok: false,
        error: "No executor is registered for detector kind 'dangling-empty-wire'.",
        performable: false,
        detector: 'dangling-empty-wire',
      }),
    ).toMatchObject({ kind: 'not-performable', detector: 'dangling-empty-wire' });
  });

  it('a not-performable 409 is NOT headlined as a guard refusal', async () => {
    // MEASURED on the shipped code: the rendered string was the nonsense
    // "Refused by a server guard.No executor is registered for detector kind x".
    await performOnce({
      kind: 'not-performable',
      reason: "No executor is registered for detector kind 'x'.",
      detector: 'x',
    });
    const bar = await screen.findByTestId('perform-response-not-performable');
    expect(bar.textContent).toContain('No executor for this class.');
    expect(bar.textContent).toContain('No guard was reached');
    expect(bar.textContent).not.toContain('Refused by');
    expect(screen.queryByTestId('perform-refused')).toBeNull();
  });

  it('a guard refusal names THAT guard in the title', async () => {
    await performOnce({
      kind: 'refused',
      guard: 'snapshot-complete',
      reason: 'REFUSED: the fresh estate pull is INCOMPLETE',
    });
    expect((await screen.findByTestId('perform-refused')).textContent).toContain(
      'Refused by the snapshot-complete guard.',
    );
  });

  it('a 409 that names no guard does not invent one', async () => {
    await performOnce({ kind: 'refused', reason: 'REFUSED: something the body did not attribute' });
    const bar = await screen.findByTestId('perform-refused');
    expect(bar.getAttribute('data-guard')).toBe('');
    expect(bar.textContent).toContain('not established');
  });

  it('a 503 does not assert a configuration gap it did not establish', async () => {
    // The 503 arm also carries every `ResourceGraphCollectionError`:
    // `arg-collect.ts` throws it when the console identity cannot get an ARM
    // token AND on any non-OK ARG response — a throttle, a 403, a 500. None of
    // those is "not configured in this deployment", which is what the shipped
    // title said over all of them. `apiHonestError` emits only
    // `{ok:false, error}`, so there is nothing in the body to split on and the
    // honest move is to defer to the server's own message.
    await performOnce({
      kind: 'gate',
      reason:
        'could not acquire an ARM token for the console identity; NO query was issued, so ' +
        'nothing is known about the estate',
    });
    const bar = await screen.findByTestId('perform-gate');
    expect(bar.textContent).toContain('NO query was issued');
    expect(bar.textContent).not.toContain('Not configured in this deployment');
    expect(bar.textContent).toContain('does not guess');
  });

  it('…and the same title serves a genuine missing-deploy-value 503, without renaming it', async () => {
    await performOnce({ kind: 'gate', reason: 'LOOM_COSMOS_ENDPOINT is not set' });
    const bar = await screen.findByTestId('perform-gate');
    expect(bar.textContent).toContain('Stopped at a precondition');
    expect(bar.textContent).toContain('LOOM_COSMOS_ENDPOINT');
  });
});

// ---------------------------------------------------------------------------
// Persisted state — the reload no longer forgets
// ---------------------------------------------------------------------------

function record(over: Partial<RecommendationStateRecord>): RecommendationStateRecord {
  return {
    findingId: 'f-always-on-1',
    estateId: 'estate-1',
    state: 'open',
    updatedAt: '2026-09-01T11:00:00.000Z',
    actorOid: 'oid-1',
    actorUpn: 'operator@example.com',
    ...over,
  } as RecommendationStateRecord;
}

describe('persisted recommendation state survives a reload', () => {
  it('a PERFORMED record renders its stored receipt with no interaction at all', async () => {
    renderList({ state: ready([PERFORMABLE], [record({ state: 'performed', receipt: RECEIPT })]) });
    const block = await screen.findByTestId('persisted-state');
    expect(block.getAttribute('data-state')).toBe('performed');
    expect(screen.getAllByTestId('perform-receipt-before')[0]!.textContent).toContain(
      '"minReplicas": 1',
    );
    // …and it does not offer to do it again behind the operator's back.
    expect(screen.getByTestId('perform-already')).toBeTruthy();
    expect(screen.queryAllByTestId('perform')).toHaveLength(0);
  });

  it('a FAILED record renders the real error', async () => {
    renderList({
      state: ready([PERFORMABLE], [record({ state: 'failed', error: 'ARM status 403: forbidden' })]),
    });
    expect((await screen.findByTestId('persisted-failure')).textContent).toContain(
      'ARM status 403: forbidden',
    );
  });

  it('a STAGED record says a confirm is pending and nothing was changed', async () => {
    renderList({
      state: ready(
        [PERFORMABLE],
        [
          record({
            state: 'staged',
            staging: {
              tokenSha256: 'deadbeef',
              detector: 'always-on-unused',
              subjectNodeId: SUBJECT,
              mintedAt: '2026-09-01T11:00:00.000Z',
              expiresAt: '2026-09-01T11:10:00.000Z',
            },
          }),
        ],
      ),
    });
    expect((await screen.findByTestId('persisted-staging')).textContent).toContain(
      'nothing was changed in Azure',
    );
  });

  it('an APPROVED record is reflected — the review buttons no longer offer a second decision', async () => {
    renderList({ state: ready([PERFORMABLE], [record({ state: 'approved' })]) });
    await screen.findByTestId('persisted-state');
    expect((screen.getByTestId('approve') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('dismiss') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('decision-recorded').textContent).toContain('approved');
  });

  it('with NO record the review buttons are live (the decided-state guard is not vacuous)', async () => {
    renderList({ state: ready() });
    await screen.findByTestId('perform');
    expect((screen.getByTestId('approve') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('persisted-state')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The header banner — the claim the no-mutation contract reads
// ---------------------------------------------------------------------------

describe('the recommend-only banner is DERIVED, so it is true in both directions', () => {
  it('states it while the read-back has not answered (no Perform control exists yet)', () => {
    // A loader that never settles: the banner must be honest about THIS render.
    wrap(
      <Recommendations
        findings={[finding()]}
        onFocusNode={() => {}}
        loadPerformState={() => new Promise<PerformStateResult>(() => {})}
      />,
    );
    expect(screen.getByTestId('recommend-only-banner').textContent).toContain(SENTENCE);
    expect(screen.queryAllByTestId('perform')).toHaveLength(0);
  });

  it('states it when the registry says nothing here is performable', async () => {
    renderList({
      findings: [finding({ id: 'f-wire', detector: 'dangling-empty-wire' })],
      state: ready(),
    });
    await screen.findByTestId('perform-not-performable');
    expect(screen.getByTestId('recommend-only-banner').textContent).toContain(SENTENCE);
  });

  it('RETRACTS it the moment a Perform control is rendered, and names the count', async () => {
    renderList({ state: ready() });
    await screen.findByTestId('perform');
    const banner = screen.getByTestId('recommend-only-banner');
    expect(banner.getAttribute('data-performable')).toBe('1');
    expect(banner.textContent).not.toContain(SENTENCE);
    expect(banner.textContent).toContain('REAL change to Azure');
  });

  it('does not count a performable class whose subject is not owned', async () => {
    renderList({ findings: [finding({ ownershipConfirmed: false })], state: ready() });
    await screen.findByTestId('perform-withheld-ownership');
    const banner = screen.getByTestId('recommend-only-banner');
    expect(banner.getAttribute('data-performable')).toBe('0');
    expect(banner.textContent).toContain(SENTENCE);
  });
});

// ---------------------------------------------------------------------------
// The banner counts THE BUTTON'S predicate (#4260 review, blocker 2)
// ---------------------------------------------------------------------------

describe('the banner count comes from the same predicate the buttons do', () => {
  it('a persisted PERFORMED record is not counted as offered', async () => {
    // MEASURED on the shipped code: this exact render produced ZERO Perform
    // controls and `data-performable=1`, dropped the recommend-only sentence,
    // and read "Review, or perform. 1 of 1 finding(s)…". It over-warned rather
    // than under-warned, so it was never dangerous — but the claim the PR asked
    // a reviewer to trust ("computed from what the render actually offers") was
    // measurably false.
    renderList({ state: ready([PERFORMABLE], [record({ state: 'performed', receipt: RECEIPT })]) });
    await screen.findByTestId('perform-already');
    const banner = screen.getByTestId('recommend-only-banner');

    expect(screen.queryAllByTestId('perform')).toHaveLength(0);
    expect(banner.getAttribute('data-performable')).toBe('0');
    expect(banner.getAttribute('data-already-performed')).toBe('1');
    expect(banner.textContent).not.toContain('Review, or perform.');
    // …and it does NOT swing to the recommend-only claim either. Azure WAS
    // changed for this finding; "nothing on this page changes anything in
    // Azure" would be the same error in the other direction.
    expect(banner.textContent).not.toContain(SENTENCE);
    expect(banner.textContent).toContain('already carry a performed receipt');
  });

  it('an IN-SESSION perform drops the count in the same render that withdraws the button', async () => {
    const { perform } = stagingPerform();
    renderList({ perform });
    await screen.findByTestId('perform');
    expect(screen.getByTestId('recommend-only-banner').getAttribute('data-performable')).toBe('1');

    await stageTypeAndConfirm();

    const banner = screen.getByTestId('recommend-only-banner');
    expect(screen.queryAllByTestId('perform')).toHaveLength(0);
    expect(banner.getAttribute('data-performable')).toBe('0');
    expect(banner.getAttribute('data-already-performed')).toBe('1');
    expect(banner.textContent).not.toContain(SENTENCE);
  });

  it('mixed: one still offered, one already performed — both counted, separately', async () => {
    renderList({
      findings: [finding(), finding({ id: 'f-always-on-2' })],
      state: ready([PERFORMABLE], [record({ state: 'performed', receipt: RECEIPT })]),
    });
    await screen.findByTestId('perform-already');
    const banner = screen.getByTestId('recommend-only-banner');
    expect(screen.queryAllByTestId('perform')).toHaveLength(1);
    expect(banner.getAttribute('data-performable')).toBe('1');
    expect(banner.getAttribute('data-already-performed')).toBe('1');
    expect(banner.textContent).toContain('1 of 2 finding(s) are offered for execution');
    expect(banner.textContent).toContain('Another 1 already carries a performed receipt');
  });

  it('the offered count is the number of rendered Perform controls, on a 3-finding list', async () => {
    // The property in one assertion: the banner's number and the DOM's number
    // are the same number, over a list where they could differ (one offered,
    // one performed, one whose class has no executor).
    renderList({
      findings: [
        finding(),
        finding({ id: 'f-perf-2' }),
        finding({ id: 'f-wire', detector: 'dangling-empty-wire' }),
      ],
      state: ready(
        [PERFORMABLE, NOT_PERFORMABLE],
        [record({ findingId: 'f-perf-2', state: 'performed', receipt: RECEIPT })],
      ),
    });
    await screen.findByTestId('perform-not-performable');
    const banner = screen.getByTestId('recommend-only-banner');
    expect(banner.getAttribute('data-performable')).toBe(
      String(screen.queryAllByTestId('perform').length),
    );
    expect(banner.getAttribute('data-performable')).toBe('1');
  });
});
