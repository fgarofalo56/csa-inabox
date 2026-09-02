'use client';

/**
 * LOOM BRAIN — the PERFORM half of a recommendation card (#4242, UI lane).
 *
 * The backend for this landed first and deliberately: the executor registry,
 * the server-re-derived guard chain, the staged two-step confirm and the
 * per-finding state store all live in `lib/brain-actions/**` behind
 * `POST /api/admin/brain/perform`. NOTHING in this file decides whether a
 * change may happen. It renders what the server already decided, sends the
 * three lookup keys, and shows the receipt or the refusal verbatim.
 *
 * ── WHAT THIS FILE MAY NOT DO, AND WHY ─────────────────────────────────────
 *   - It NEVER decides performability. The registry ships on the GET read-back
 *     (`performability`), keyed by detector kind. A detector absent from that
 *     map is UNKNOWN to this client, and unknown renders the server's own
 *     refusal text — never a guess, never a hidden card.
 *   - It NEVER mints or reuses a confirm token. The token is minted server-side
 *     by `RecommendationStateStore.stage`, returned once, single-use, bounded,
 *     and consumed by an etag-guarded write. The typed-name dialog here is a
 *     SECOND, client-side speed bump on top of that gate — not the gate itself.
 *     A client that skipped this dialog would still have to present a token it
 *     could only have obtained by staging.
 *   - It NEVER states an outcome the response did not establish
 *     (`deploy-integrity.md` R7). A transport failure mid-write says exactly
 *     that: the outcome was NOT established. It does not say "failed, nothing
 *     changed", because that is a claim about Azure this code cannot make.
 *     R7 binds the TITLES too, and that is where it was first broken: a 409 was
 *     titled "Refused by a server guard" for both of the route's 409s, printing
 *     that headline over "No executor is registered for detector kind x" — a
 *     guard that never ran. `interpretPerformResponse` now reads the
 *     discriminator the route already sends (`performable:false` vs `guard`).
 *     The 503 arm has no such discriminator — `apiHonestError` emits only
 *     `{ok:false, error}` and the route answers 503 for a Resource Graph
 *     collection failure as well as for a missing deploy value — so that title
 *     states only what the status established and defers to the server's own
 *     message, rather than asserting "not configured".
 *   - It NEVER re-arms a destructive control under its own success receipt.
 *     `performDisposition` is the SINGLE predicate for "does this render offer
 *     a Perform control", and the header banner counts the same function. Two
 *     hand-written copies of that rule disagreed in both directions (#4260
 *     review); there is now nothing left to drift.
 *
 * ── THE `persisted:false` DISCLOSURE ───────────────────────────────────────
 * A confirmed ARM write whose state-store record did not land comes back
 * `performed: true, persisted: false`. That is a real, visible condition — the
 * change happened and a reload will NOT remember it — so it is rendered as a
 * warning next to the receipt, never swallowed.
 */

import * as React from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { CheckmarkCircle20Regular, PlayCircle20Regular } from '@fluentui/react-icons';
import type {
  PerformExecutorKind,
  PerformReceipt,
  PerformRegistryEntry,
  RecommendationStateRecord,
  RecommendationStateValue,
} from '@/lib/brain-actions/types';

// ---------------------------------------------------------------------------
// Wire results — every arm of them is a state this UI actually renders
// ---------------------------------------------------------------------------

/** The GET read-back: recorded states + the server's performability registry. */
export type PerformStateResult =
  | {
      readonly kind: 'ready';
      readonly states: readonly RecommendationStateRecord[];
      readonly performability: readonly PerformRegistryEntry[];
    }
  /**
   * The read did not succeed. `reason` is the server's own message when there
   * was one. This is NEVER collapsed into "nothing is performable": an
   * unreadable registry establishes nothing about what the platform can do.
   */
  | { readonly kind: 'unavailable'; readonly reason: string };

/** The POST result, one arm per outcome the route can return. */
export type PerformOutcomeResult =
  | {
      readonly kind: 'staged';
      readonly executor: PerformExecutorKind;
      readonly confirmToken: string;
      readonly expiresAt: string;
      readonly note: string;
    }
  | {
      readonly kind: 'performed';
      readonly receipt: PerformReceipt;
      readonly persisted: boolean;
      readonly persistError?: string;
    }
  /**
   * A NAMED server guard said no. Nothing was changed.
   *
   * This is one of the TWO things the route answers 409 with, and it is not the
   * other one — see `not-performable` below. Collapsing them produced a
   * measurably false title (#4260 review): a not-performable answer was being
   * headed "Refused by a server guard." above a body that said no executor is
   * registered at all, which names a guard that never ran.
   */
  | { readonly kind: 'refused'; readonly reason: string; readonly guard?: string }
  /**
   * The route's OTHER 409: the detector kind has no registered executor, so no
   * guard was ever reached. Discriminated by `performable: false` in the body,
   * which `route.ts` has always sent and this client previously ignored.
   */
  | { readonly kind: 'not-performable'; readonly reason: string; readonly detector?: string }
  /**
   * The request was REJECTED BEFORE the perform route ran — 400 / 401 / 403.
   *
   * R7 in the other direction (#4260 review, should-fix 1). These three used to
   * fall through to `indeterminate`, which renders "whether Azure was changed
   * was NOT established by this call" under an error bar. That is over-claiming
   * uncertainty: every one of them resolves BEFORE `performRecommendation` is
   * reached, so the code knows for certain that nothing was attempted.
   *
   *   401 / 403 — `withTenantAdmin` answers before the handler body runs
   *               (`lib/api/route-toolkit.ts`). An expired session on a
   *               long-open admin tab is by far the most common failure here,
   *               and telling that operator a destructive scale-to-zero MAY
   *               have landed is a worse error than any it prevents.
   *   400       — `parseBody` → `apiBadRequest` at `route.ts:110`, four lines
   *               ABOVE the `performRecommendation` call at `:114`.
   *
   * Kept distinct from `refused` deliberately: `refused` is a NAMED server guard
   * that ran and declined, and its copy points at the Brain audit trail. Nothing
   * reached the audit trail here, so it must not say so.
   */
  | { readonly kind: 'rejected'; readonly reason: string; readonly status: number }
  /**
   * A 503 — the route stopped at a precondition and performed nothing.
   *
   * R7 WARNING, and the reason this arm is NOT called "not configured": the
   * route returns 503 for `BrainActionsNotConfiguredError` and
   * `AcaNotConfiguredError` (genuine configuration gaps) AND for
   * `ResourceGraphCollectionError`, which `arg-collect.ts` throws on a token
   * acquisition failure and on ANY non-OK ARG response — a throttle, a 403, a
   * 500. Those are not configuration gaps. `apiHonestError` emits only
   * `{ok:false, error}`, so the body carries NO field that separates them: the
   * server's own message is the only discriminator, and this client renders it
   * rather than inventing a cause.
   */
  | { readonly kind: 'gate'; readonly reason: string }
  /** The write was ATTEMPTED and reported an error. */
  | {
      readonly kind: 'failed';
      readonly error: string;
      readonly executor?: PerformExecutorKind;
      readonly persisted?: boolean;
    }
  /** The call did not complete, or answered a shape with no stated outcome. */
  | { readonly kind: 'indeterminate'; readonly reason: string };

export interface PerformRequestBody {
  readonly findingId: string;
  readonly detector: string;
  readonly subjectNodeId: string;
  readonly confirmToken?: string;
}

// ---------------------------------------------------------------------------
// The real network calls (the defaults; tests inject their own)
// ---------------------------------------------------------------------------

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** GET the recorded states + the performability registry. */
export async function fetchPerformState(): Promise<PerformStateResult> {
  let res: Response;
  try {
    res = await fetch('/api/admin/brain/perform', { headers: { accept: 'application/json' } });
  } catch (e) {
    return {
      kind: 'unavailable',
      reason:
        `the request did not complete (${errText(e)}). Which recommendations the ` +
        'platform can perform is therefore UNKNOWN — this is not a finding that none can be.',
    };
  }
  const json = (await res.json().catch(() => null)) as
    | {
        ok?: boolean;
        error?: string;
        states?: readonly RecommendationStateRecord[];
        performability?: readonly PerformRegistryEntry[];
      }
    | null;
  if (!res.ok || !json?.ok) {
    return { kind: 'unavailable', reason: json?.error ?? `the read-back answered HTTP ${res.status}` };
  }
  return {
    kind: 'ready',
    states: json.states ?? [],
    performability: json.performability ?? [],
  };
}

/**
 * POST one perform attempt.
 *
 * The body is exactly the three lookup keys plus, on the confirm leg, the
 * server-minted token. No resource id, no executor choice, no ARM payload — the
 * server re-derives every one of those from its own fresh snapshot.
 */
export async function postPerform(body: PerformRequestBody): Promise<PerformOutcomeResult> {
  let res: Response;
  try {
    res = await fetch('/api/admin/brain/perform', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return {
      kind: 'indeterminate',
      reason:
        `the request did not complete (${errText(e)}). Whether the change reached Azure ` +
        'was NOT established by this call — read the Brain audit trail before retrying.',
    };
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return interpretPerformResponse(res.status, json);
}

/**
 * Map an HTTP status + body to an outcome. Exported so a spec can drive every
 * arm without a network, and so the mapping itself is testable — the R7 risk
 * lives here, not in the rendering.
 */
export function interpretPerformResponse(
  status: number,
  json: Record<string, unknown> | null,
): PerformOutcomeResult {
  const ok = json?.ok === true;
  if (status >= 200 && status < 300 && ok) {
    if (json?.staged === true) {
      return {
        kind: 'staged',
        executor: String(json.executor ?? '') as PerformExecutorKind,
        confirmToken: String(json.confirmToken ?? ''),
        expiresAt: String(json.expiresAt ?? ''),
        note: typeof json.note === 'string' ? json.note : '',
      };
    }
    if (json?.performed === true && json.receipt) {
      return {
        kind: 'performed',
        receipt: json.receipt as PerformReceipt,
        persisted: json.persisted !== false,
        ...(typeof json.persistError === 'string' ? { persistError: json.persistError } : {}),
      };
    }
    return {
      kind: 'indeterminate',
      reason:
        `the route answered HTTP ${status} with ok:true but stated neither a staging ` +
        'nor a receipt, so no outcome was established.',
    };
  }
  const error = typeof json?.error === 'string' ? json.error : `HTTP ${status}`;
  if (status === 409) {
    // TWO distinct 409s, and the discriminator is already on the wire:
    // `not-performable` sends `performable: false` + `detector`; `refused`
    // sends `performable: true` + `guard`. Read it rather than titling both
    // as a guard refusal.
    if (json?.performable === false) {
      return {
        kind: 'not-performable',
        reason: error,
        ...(typeof json?.detector === 'string' ? { detector: json.detector } : {}),
      };
    }
    return {
      kind: 'refused',
      reason: error,
      ...(typeof json?.guard === 'string' ? { guard: json.guard } : {}),
    };
  }
  if (status === 503) return { kind: 'gate', reason: error };
  // 400 / 401 / 403 resolve BEFORE `performRecommendation` runs, so "nothing was
  // attempted" is ESTABLISHED, not assumed — see the `rejected` arm's doc-block.
  // These must never reach the indeterminate fallback below: doing so told an
  // operator whose session had merely expired that a destructive write MIGHT
  // have landed on their estate (`deploy-integrity.md` R7, inverted).
  if (status === 400 || status === 401 || status === 403) {
    return { kind: 'rejected', status, reason: error };
  }
  if (status === 502) {
    return {
      kind: 'failed',
      error,
      ...(typeof json?.executor === 'string'
        ? { executor: json.executor as PerformExecutorKind }
        : {}),
      ...(typeof json?.persisted === 'boolean' ? { persisted: json.persisted } : {}),
    };
  }
  return {
    kind: 'indeterminate',
    reason:
      `the route answered HTTP ${status}: ${error}. That status carries no stated ` +
      'outcome, so whether Azure was changed was NOT established by this call.',
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The resource name a typed confirm asks for, taken from the SUBJECT NODE ID.
 *
 * Node ids are `azure:<lowercased ARM id>` (`lib/brain/graph/node-id.ts`), so
 * the last path segment is the ARM resource name — the same string the server
 * derives its ARM id from. Deriving it here is display-only: the executing
 * authority is the server-minted token, never this string.
 */
export function subjectResourceName(nodeId: string): string {
  const withoutPrefix = nodeId.includes(':') ? nodeId.slice(nodeId.indexOf(':') + 1) : nodeId;
  const trimmed = withoutPrefix.replace(/\/+$/, '');
  const last = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return last || trimmed || nodeId;
}

/** Index the registry by detector kind. */
export function performabilityFor(
  performability: readonly PerformRegistryEntry[],
  detector: string,
): PerformRegistryEntry | undefined {
  return performability.find((e) => e.detector === detector);
}

/**
 * THE ONE PREDICATE. What this render does about ONE finding's perform half.
 *
 * ── WHY THIS EXISTS (both #4260 review blockers were the same bug) ─────────
 * The button's withdrawal condition and the header banner's count used to be
 * written twice, and the two copies disagreed in BOTH directions:
 *
 *   - A finding performed IN THIS SESSION kept a live, enabled Perform button
 *     rendered directly beneath its own success receipt. The executor is
 *     `scale-to-zero` today and an ARM DELETE tomorrow; the server refuses the
 *     second attempt (every guard is re-derived from a fresh snapshot), so this
 *     was never a hole — but it invited a click that lands on a red refusal.
 *   - A finding with a PERSISTED performed record correctly rendered no button,
 *     yet still counted toward the banner, which then read "Review, or perform.
 *     1 of 1 finding(s)…" over a page offering nothing.
 *
 * So every consumer now reads THIS function: `PerformControls` switches on it,
 * and `performOfferSummary` counts it. There is no second predicate left to
 * drift. `performedInSession` is an INPUT to the one predicate, not a rival to
 * it — deliberately NOT a re-fetch of the read-back, because a re-fetch races
 * (the button stays armed until it lands) and because a `persisted:false` write
 * legitimately does NOT produce a performed record, so the read-back would
 * re-arm the control under a receipt saying the write already happened.
 */
export type PerformDisposition =
  /** The read-back has not answered yet. Not "nothing is performable". */
  | { readonly kind: 'unread' }
  /** The read-back failed. Also not "nothing is performable". */
  | { readonly kind: 'unreadable'; readonly reason: string }
  /** The server's registry has no executor for this detector kind. */
  | { readonly kind: 'no-executor'; readonly reason: string }
  /** Performable class, but no resolved ownership edge covers the subject. */
  | { readonly kind: 'withheld-ownership' }
  /** Done. The control is WITHDRAWN — never re-armed under its own receipt. */
  | {
      readonly kind: 'already-performed';
      readonly via: 'record' | 'session';
      readonly entry: PerformRegistryEntry;
    }
  /** This render offers the Perform control for this finding. */
  | { readonly kind: 'offer'; readonly entry: PerformRegistryEntry };

/** The three fields the disposition reads off a finding. */
export interface PerformSubject {
  readonly id: string;
  readonly detector: string;
  readonly ownershipConfirmed: boolean;
}

/**
 * What the offer SUMMARY reads: a disposition subject PLUS the subject list the
 * render draws buttons from.
 *
 * Deliberately a separate type rather than a field on `PerformSubject`:
 * `performDisposition` decides per FINDING and must not be able to read
 * `subjects` at all, or a future edit could quietly make performability depend
 * on subject count. The summary is the only consumer that needs it, because it
 * is the only one that has to agree with the DOM (#4260 review, should-fix 4).
 */
export interface PerformCountable extends PerformSubject {
  readonly subjects: readonly string[];
}

export function performDisposition(
  finding: PerformSubject,
  state: PerformStateResult | null,
  record: RecommendationStateRecord | undefined,
  performedInSession: ReadonlySet<string>,
): PerformDisposition {
  if (state === null) return { kind: 'unread' };
  if (state.kind === 'unavailable') return { kind: 'unreadable', reason: state.reason };

  const entry = performabilityFor(state.performability, finding.detector);
  if (!entry || entry.performable !== true) {
    return {
      kind: 'no-executor',
      reason:
        entry?.notPerformableReason ??
        `Detector '${finding.detector}' is not in the server's performability registry, so this ` +
          'console does not know of an executor for it. Nothing is offered rather than a ' +
          'control that would refuse — and the registry, not this page, is where a kind is added.',
    };
  }
  if (!finding.ownershipConfirmed) return { kind: 'withheld-ownership' };
  // The persisted record is the durable truth and is checked first; the
  // in-session set covers the window before a reload, INCLUDING the
  // `persisted:false` case in which no record will ever appear.
  if (record?.state === 'performed') return { kind: 'already-performed', via: 'record', entry };
  if (performedInSession.has(finding.id)) {
    return { kind: 'already-performed', via: 'session', entry };
  }
  return { kind: 'offer', entry };
}

/**
 * What the header banner is allowed to say, counted from the SAME predicate the
 * buttons render from — so "computed from what the render actually offers" is a
 * measurable fact rather than a claim.
 *
 * ── TWO NUMBERS, BECAUSE THE RENDER DRAWS TWO SHAPES (#4260 review, S4) ────
 * The round-2 fix counted `offered` once per FINDING and then asserted it equal
 * to the number of rendered `data-testid="perform"` controls. `PerformControls`
 * renders one button PER SUBJECT, so those two agreed only because every fixture
 * finding carried exactly one subject. Reachability was checked before treating
 * it as latent-not-live: every currently-performable detector emits a single
 * subject (`always-on-unused.ts`, `unreachable-service.ts`, `orphan.ts`), and
 * the multi-subject detectors (`config-drift.ts`, `dangling-wire.ts`) are all
 * `performable:false`. But the render already HAS the multi-subject branch, so
 * the invariant was accidental. It is now derived, with a two-subject fixture
 * pinning it:
 *
 *   `offeredFindings`  — findings the page offers at all (the prose's "N of M").
 *   `offeredControls`  — Perform buttons on screen (what `data-performable` is,
 *                        and the number the equality spec compares to the DOM).
 */
export function performOfferSummary(
  findings: readonly PerformCountable[],
  state: PerformStateResult | null,
  records: ReadonlyMap<string, RecommendationStateRecord>,
  performedInSession: ReadonlySet<string>,
): {
  readonly offeredFindings: number;
  readonly offeredControls: number;
  readonly alreadyPerformed: number;
} {
  let offeredFindings = 0;
  let offeredControls = 0;
  let alreadyPerformed = 0;
  for (const f of findings) {
    const d = performDisposition(f, state, records.get(f.id), performedInSession);
    if (d.kind === 'offer') {
      offeredFindings += 1;
      offeredControls += f.subjects.length;
    } else if (d.kind === 'already-performed') alreadyPerformed += 1;
  }
  return { offeredFindings, offeredControls, alreadyPerformed };
}

/**
 * Whether the LIST-level read-back disclosure is on screen.
 *
 * `PerformStateDisclosure` renders exactly when this is true, and the per-card
 * copy of the same warning is suppressed exactly when this is true — one
 * predicate, so the two can never disagree and leave the operator with either
 * 31 identical warning bars on a 30-finding estate (the #4260 review's measured
 * state) or none at all.
 */
export function performStateNoticeShown(state: PerformStateResult | null): boolean {
  return state !== null && state.kind !== 'ready';
}

/** Fluent badge colour per persisted lifecycle state. */
function stateColor(state: RecommendationStateValue): 'success' | 'danger' | 'warning' | 'brand' | 'informative' {
  switch (state) {
    case 'performed':
      return 'success';
    case 'failed':
      return 'danger';
    case 'staged':
      return 'warning';
    case 'approved':
      return 'brand';
    default:
      return 'informative';
  }
}

// ---------------------------------------------------------------------------
// Styles — tokens only (web3-ui.md §1)
// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  block: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minWidth: 0,
  },
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
    alignItems: 'center',
  },
  pre: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    minWidth: 0,
    margin: 0,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  mono: { fontFamily: tokens.fontFamilyMonospace, overflowWrap: 'anywhere' },
  hint: {
    color: tokens.colorNeutralForeground3,
    minWidth: 0,
    overflowWrap: 'anywhere',
  },
  confirmInput: { width: '100%' },
  dialogBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minWidth: 0,
  },
});

// ---------------------------------------------------------------------------
// Receipt + state rendering
// ---------------------------------------------------------------------------

/** The real before/after, exactly as the server recorded it. */
export function PerformReceiptView({ receipt }: { receipt: PerformReceipt }) {
  const s = useStyles();
  return (
    <div className={s.block} data-testid="perform-receipt">
      <div className={s.row}>
        <Badge appearance="tint" color="success">
          performed
        </Badge>
        <Badge appearance="outline">{receipt.executor}</Badge>
        <Badge appearance="outline">mutatedAzure: {String(receipt.mutatedAzure)}</Badge>
      </div>
      <Caption1 className={s.hint}>
        {receipt.resourceId} · {receipt.performedAt}
      </Caption1>
      <Caption1 className={s.hint}>Before</Caption1>
      <pre className={s.pre} data-testid="perform-receipt-before">
        {JSON.stringify(receipt.before, null, 2)}
      </pre>
      <Caption1 className={s.hint}>After</Caption1>
      <pre className={s.pre} data-testid="perform-receipt-after">
        {JSON.stringify(receipt.after, null, 2)}
      </pre>
    </div>
  );
}

/**
 * What the STORE remembers about this finding, so a reload no longer forgets.
 * Rendered from the persisted record, not from anything this session did.
 */
export function PersistedStateBanner({ record }: { record: RecommendationStateRecord }) {
  const s = useStyles();
  return (
    <div className={s.block} data-testid="persisted-state" data-state={record.state}>
      <div className={s.row}>
        <Badge appearance="tint" color={stateColor(record.state)}>
          {record.state}
        </Badge>
        <Caption1 className={s.hint}>
          recorded {record.updatedAt} by {record.actorUpn}
        </Caption1>
      </div>
      {record.state === 'failed' && record.error ? (
        <MessageBar intent="error" data-testid="persisted-failure">
          <MessageBarBody>
            <MessageBarTitle>The last attempt failed.</MessageBarTitle>
            {record.error}
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {record.state === 'staged' && record.staging ? (
        <MessageBar intent="warning" data-testid="persisted-staging">
          <MessageBarBody>
            <MessageBarTitle>A confirm is pending.</MessageBarTitle>
            This change was staged at {record.staging.mintedAt} and nothing was changed in Azure.
            The single-use token is held by the session that staged it and expires at{' '}
            {record.staging.expiresAt}; staging again from here mints a new one and voids that.
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {record.state === 'performed' && record.receipt ? (
        <PerformReceiptView receipt={record.receipt} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The per-finding perform controls
// ---------------------------------------------------------------------------

interface PerformControlsProps {
  readonly findingId: string;
  /**
   * The finding's own title, shown in the confirm dialog so the operator
   * confirms against the same statement they read on the card rather than
   * against a bare ARM id (#4260 review, blocker).
   */
  readonly findingTitle: string;
  readonly detector: string;
  readonly subjects: readonly string[];
  readonly ownershipConfirmed: boolean;
  readonly state: PerformStateResult | null;
  readonly record?: RecommendationStateRecord;
  readonly perform: (body: PerformRequestBody) => Promise<PerformOutcomeResult>;
  /**
   * Findings this SESSION already performed, owned by the list so the header
   * banner and this control read one set. REQUIRED, not optional: a consumer
   * that forgot it would silently re-arm a destructive control under its own
   * receipt, which is precisely the defect this pair of props fixes.
   */
  readonly performedInSession: ReadonlySet<string>;
  /** Called once with the findingId on a `performed` outcome. */
  readonly onPerformed: (findingId: string) => void;
  /**
   * True when the LIST already renders `PerformStateDisclosure` for a failed
   * read-back. The per-card copy is then suppressed — same reason, same retry,
   * once per page instead of once per card.
   */
  readonly stateNoticeShownAtListLevel: boolean;
}

type Live =
  | { readonly phase: 'idle' }
  | { readonly phase: 'busy' }
  | {
      readonly phase: 'staged';
      readonly subjectNodeId: string;
      readonly executor: PerformExecutorKind;
      readonly confirmToken: string;
      readonly expiresAt: string;
    }
  | { readonly phase: 'outcome'; readonly outcome: PerformOutcomeResult };

export function PerformControls({
  findingId,
  findingTitle,
  detector,
  subjects,
  ownershipConfirmed,
  state,
  record,
  perform,
  performedInSession,
  onPerformed,
  stateNoticeShownAtListLevel,
}: PerformControlsProps) {
  const s = useStyles();
  const [live, setLive] = React.useState<Live>({ phase: 'idle' });
  const [typed, setTyped] = React.useState('');

  /**
   * Land an outcome AND, when it is a confirmed write, tell the list — which
   * is what withdraws this control and drops the banner's count. Both legs go
   * through here so a future third caller cannot land a `performed` outcome
   * without reporting it.
   */
  const settle = React.useCallback(
    (out: PerformOutcomeResult) => {
      setLive({ phase: 'outcome', outcome: out });
      if (out.kind === 'performed') onPerformed(findingId);
    },
    [findingId, onPerformed],
  );

  const stage = React.useCallback(
    async (subjectNodeId: string) => {
      setLive({ phase: 'busy' });
      // The typed confirm is a SPEED BUMP, so it must reset between stagings:
      // without this, cancel-then-restage reopens the dialog with the previous
      // text still in it and "Confirm and perform" already enabled, which is
      // no speed bump at all. Covered by its own spec + mutation receipt.
      setTyped('');
      const out = await perform({ findingId, detector, subjectNodeId });
      if (out.kind === 'staged') {
        setLive({
          phase: 'staged',
          subjectNodeId,
          executor: out.executor,
          confirmToken: out.confirmToken,
          expiresAt: out.expiresAt,
        });
        return;
      }
      settle(out);
    },
    [detector, findingId, perform, settle],
  );

  const confirm = React.useCallback(async () => {
    if (live.phase !== 'staged') return;
    const { subjectNodeId, confirmToken } = live;
    setLive({ phase: 'busy' });
    // The token travels back EXACTLY as the server minted it. It is never
    // reconstructed, never defaulted, never sent when absent.
    const out = await perform({ findingId, detector, subjectNodeId, confirmToken });
    settle(out);
  }, [detector, findingId, live, perform, settle]);

  const disposition = performDisposition(
    { id: findingId, detector, ownershipConfirmed },
    state,
    record,
    performedInSession,
  );

  // ── the read-back has not answered ──────────────────────────────────────
  if (disposition.kind === 'unread') return null;

  // ── the read-back could not be read ─────────────────────────────────────
  if (disposition.kind === 'unreadable') {
    // The list-level disclosure carries this same reason plus a Retry. One
    // page-level warning, not one per card.
    if (stateNoticeShownAtListLevel) return null;
    return (
      <MessageBar intent="warning" data-testid="perform-state-unavailable">
        <MessageBarBody>
          <MessageBarTitle>Perform is unavailable.</MessageBarTitle>
          The recommendation state read-back did not succeed: {disposition.reason} Whether this
          recommendation can be performed is not known here, so no action is offered — an
          unreadable registry is not evidence that the platform cannot act.
        </MessageBarBody>
      </MessageBar>
    );
  }

  // ── the class is not performable, with the server's own reason ──────────
  if (disposition.kind === 'no-executor') {
    return (
      <MessageBar intent="warning" data-testid="perform-not-performable" data-detector={detector}>
        <MessageBarBody>
          <MessageBarTitle>The platform cannot perform this one.</MessageBarTitle>
          {disposition.reason}
        </MessageBarBody>
      </MessageBar>
    );
  }

  // ── performable, but ownership is not established ───────────────────────
  if (disposition.kind === 'withheld-ownership') {
    return (
      <MessageBar intent="warning" data-testid="perform-withheld-ownership">
        <MessageBarBody>
          <MessageBarTitle>Performable class, withheld subject.</MessageBarTitle>
          An executor exists for this detector, but no resolved ownership edge covers the
          subject, so the server would refuse at the ownership guard
          (`guardOwnership`, 409).
          {/* ── #4260 review, should-fix 2 — DELIBERATELY NOT A FIX-IT ──────
              `ux-baseline.md` G2 asks for an inline Fix-it on a gate. This one
              does not get one, and the reason is measured rather than stylistic.

              Until #4261's `guardScalableToZero` merges, the ownership guard is
              — by accident, not by design — the ONLY thing standing between a
              click and an unrecoverable scale-to-zero on a stateful singleton
              (#4261 measured three on the committed template). A one-click
              button that stamps the tag would remove that protection in a
              single gesture, from the surface that ranks findings by saving.

              So this bar names the SEQUENCE instead of offering the shortcut.
              The previous copy — "Stamp the estate ownership tag in the deploy
              and this becomes available" — read as an instruction to do exactly
              that, with nothing saying what it unlocks. */}
          <br />
          This is a data condition, not a configuration gate: the tag is stamped by the deploy
          (#4274) and backfilled onto existing resources (#4267). Both are sequenced BEHIND the
          statefulness guard in #4261 on purpose — while that guard is unmerged, ownership is
          the last check between this control and a scale-to-zero on a runtime that holds state
          in-process. Nothing here offers to stamp it for you.
        </MessageBarBody>
      </MessageBar>
    );
  }

  const entry = disposition.entry;
  const busy = live.phase === 'busy';

  return (
    <div className={s.block} data-testid="perform-block" data-executor={entry.executor}>
      <div className={s.row}>
        {/* DERIVED from the registry entry, not asserted. `destructive` is
            optional on `PerformRegistryEntry` (`?: true`), so the shipped
            literal "destructive · {executor}" was true only by accident —
            exactly the shape of round 2's blocker. An entry that omits the flag
            now says the class is UNCLASSIFIED rather than silently calling it
            destructive (or, worse, safe). */}
        <Badge
          appearance="tint"
          color={entry.destructive === true ? 'danger' : 'warning'}
          data-testid="perform-class"
          data-destructive={String(entry.destructive === true)}
        >
          {entry.destructive === true ? 'destructive' : 'class unclassified'} · {entry.executor}
        </Badge>
        <Caption1 className={s.hint}>
          Two steps: the first click stages a single-use, time-bounded confirm server-side and
          changes nothing; typing the resource name and confirming is what executes.
        </Caption1>
      </div>

      {disposition.kind === 'already-performed' ? (
        <MessageBar intent="success" data-testid="perform-already" data-performed-via={disposition.via}>
          <MessageBarBody>
            {disposition.via === 'session'
              ? 'This was performed in this session and its receipt is below. The control is ' +
                'withdrawn rather than left armed underneath its own receipt — reload the Brain ' +
                'for a fresh snapshot before acting on this finding again.'
              : 'This recommendation is already recorded as performed; its receipt is above. ' +
                'Reload the Brain for a fresh snapshot rather than performing it twice.'}
          </MessageBarBody>
        </MessageBar>
      ) : (
        <div className={s.row}>
          {subjects.map((subjectNodeId) => (
            <Button
              key={subjectNodeId}
              appearance="primary"
              size="small"
              icon={<PlayCircle20Regular />}
              disabled={busy || live.phase === 'staged'}
              onClick={() => void stage(subjectNodeId)}
              data-testid="perform"
              data-subject={subjectNodeId}
            >
              {subjects.length === 1
                ? 'Perform this recommendation'
                : `Perform on ${subjectResourceName(subjectNodeId)}`}
            </Button>
          ))}
          {busy ? <Spinner size="tiny" label="Working…" /> : null}
        </div>
      )}

      {live.phase === 'staged' ? (
        <StagedConfirmDialog
          executor={live.executor}
          expiresAt={live.expiresAt}
          findingTitle={findingTitle}
          resourceName={subjectResourceName(live.subjectNodeId)}
          subjectNodeId={live.subjectNodeId}
          typed={typed}
          onTyped={setTyped}
          onCancel={() => setLive({ phase: 'idle' })}
          onConfirm={() => void confirm()}
        />
      ) : null}

      {live.phase === 'outcome' ? <PerformOutcomeView outcome={live.outcome} /> : null}
    </div>
  );
}

/**
 * What the confirm dialog says about ONE executor — an EXHAUSTIVE switch, not a
 * ternary.
 *
 * ── WHY THIS IS A SWITCH (#4260 review round 4, nit 2) ─────────────────────
 * This started as two `executor === 'delete-resource' ? … : …` ternaries: one
 * for the action sentence, one gating the statefulness caveat. Under a ternary a
 * THIRD `PerformExecutorKind` would silently take the else-branch and inherit
 * the `minReplicas` sentence — a confident, specific, WRONG claim about the
 * change, rendered directly above a typed confirm that then executes it. That
 * is the exact defect this whole review round existed to fix, re-introduced
 * later and silently, by an author who edited the registry and never opened
 * this file.
 *
 * "Only two executors exist" is a weak guarantee. #4262 went looking for two
 * known gate mismatches and its rewritten guard found TWELVE across six sites;
 * latent-because-small is how this class survives. The `never` assignment in the
 * default branch converts it from "a wrong sentence ships and an operator acts
 * on it" into "the build fails" — adding a kind to `PerformExecutorKind`
 * without a case here is a COMPILE error on that line, not a runtime surprise.
 *
 * The runtime default still has to do something, because a server could send a
 * kind this bundle predates. It FAILS TOWARD WARNING: it refuses to describe the
 * change, says so plainly, and keeps the statefulness caveat on. An unknown
 * executor is the case where this page knows LEAST, so it is the last case that
 * should sound reassuring.
 *
 * Exported so a spec can drive every arm — including the one the type system
 * says is unreachable, which is precisely the arm no fixture would otherwise
 * reach.
 */
export function confirmCopyFor(executor: PerformExecutorKind): {
  /** The single sentence naming the change this will make. */
  readonly action: string;
  /** Whether the in-process-state caveat applies to this executor. */
  readonly statefulnessCaveat: boolean;
} {
  switch (executor) {
    case 'delete-resource':
      return {
        action:
          'The platform will issue an ARM delete for this resource. It is not recoverable from this page.',
        statefulnessCaveat: false,
      };
    case 'scale-to-zero':
      return {
        action: 'The platform will PATCH minReplicas to 0 on this Container App.',
        statefulnessCaveat: true,
      };
    default: {
      // COMPILE-TIME EXHAUSTIVENESS. Add a kind to `PerformExecutorKind`
      // without a case above and `executor` is no longer narrowed to `never`
      // here, so THIS LINE fails to typecheck. That is the point of the whole
      // function.
      const unhandled: never = executor;
      return {
        action:
          `This console does not recognise the '${String(unhandled)}' executor, so it cannot ` +
          'tell you what this change will do. Nothing about the effect is established here — ' +
          'read the server’s registry entry for this executor before confirming.',
        statefulnessCaveat: true,
      };
    }
  }
}

/**
 * The typed-resource-name confirm.
 *
 * It opens only AFTER the server staged and returned a token, so the dialog can
 * state truthfully that nothing has changed yet, and the confirm button is the
 * only control that carries the token back.
 */
function StagedConfirmDialog({
  executor,
  expiresAt,
  findingTitle,
  resourceName,
  subjectNodeId,
  typed,
  onTyped,
  onCancel,
  onConfirm,
}: {
  executor: PerformExecutorKind;
  expiresAt: string;
  findingTitle: string;
  resourceName: string;
  subjectNodeId: string;
  typed: string;
  onTyped: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const s = useStyles();
  // ONE derivation, read by both the sentence and the caveat. Two independent
  // ternaries could disagree with each other; one exhaustive switch cannot.
  const copy = confirmCopyFor(executor);
  return (
    <Dialog open modalType="alert" onOpenChange={(_, d) => !d.open && onCancel()}>
      <DialogSurface data-testid="perform-confirm-dialog">
        <DialogBody>
          <DialogTitle>Confirm this change</DialogTitle>
          <DialogContent>
            <div className={s.dialogBlock}>
              <Body1 data-testid="perform-confirm-action">{copy.action}</Body1>
              {/* ── #4260 review, BLOCKER ───────────────────────────────────
                  What stood here asserted, unconditionally and for EVERY
                  scale-to-zero subject, that "the app stays deployed and scales
                  back up on demand". This client knows the detector kind and the
                  node id. It knows NOTHING about whether the workload holds
                  state in-process, and for the estate's own highest-value
                  finding the repo's bicep says the opposite verbatim:

                    "a scaled-to-zero replica loses every MV definition and its
                     progress"
                    — platform/fiab/bicep/modules/data-plane/loom-risingwave-aca.bicep

                  #4261 measured THREE such pinned singletons on the committed
                  template (loom-risingwave, iceberg-catalog, loom-airflow) and
                  is where the server-side `guardScalableToZero` lands. Until it
                  does, this sentence is the last thing the operator reads before
                  a typed confirm — so it states what is established and names
                  what is not (`deploy-integrity.md` R7). Do not restore a
                  reversibility claim here; a spec asserts its absence.

                  Round 4: the gate is now `confirmCopyFor(executor)
                  .statefulnessCaveat` rather than a second ternary, so an
                  executor added without a case in that switch fails the build
                  instead of silently landing on the wrong side of this. */}
              {copy.statefulnessCaveat ? (
                <MessageBar intent="warning" data-testid="perform-statefulness-caveat">
                  <MessageBarBody>
                    <MessageBarTitle>
                      What this costs depends on the workload, and this page cannot tell which
                      this is.
                    </MessageBarTitle>
                    A stateless app cold-starts and resumes with nothing lost. A runtime that holds
                    state IN-PROCESS — materialized views, catalog metadata, an in-memory index —
                    loses that state when its last replica stops, and raising the floor again does
                    NOT bring it back. Nothing available to this page distinguishes the two: read
                    the app&apos;s own deploy module before confirming.
                  </MessageBarBody>
                </MessageBar>
              ) : null}
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Staged. Nothing has changed yet.</MessageBarTitle>
                  The server minted a single-use confirmation for this exact finding and subject; it
                  expires at {expiresAt}. Cancelling leaves the estate untouched.
                </MessageBarBody>
              </MessageBar>
              {/* The FINDING, next to its subject — so the operator confirms
                  against the same statement they just read on the card rather
                  than against a bare ARM id. */}
              <Caption1 className={s.hint} data-testid="perform-confirm-finding">
                Finding <strong>{findingTitle}</strong>
              </Caption1>
              <Caption1 className={s.hint}>
                Subject <span className={s.mono}>{subjectNodeId}</span>
              </Caption1>
              <Caption1 className={s.hint}>
                Type <span className={s.mono}>{resourceName}</span> to confirm.
              </Caption1>
              <Input
                className={s.confirmInput}
                value={typed}
                placeholder={resourceName}
                aria-label="Type the resource name to confirm"
                data-testid="perform-confirm-input"
                onChange={(_, d) => onTyped(d.value)}
              />
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel} data-testid="perform-cancel">
              Cancel
            </Button>
            <Button
              appearance="primary"
              icon={<CheckmarkCircle20Regular />}
              disabled={typed.trim() !== resourceName}
              onClick={onConfirm}
              data-testid="perform-confirm"
            >
              Confirm and perform
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** The outcome of THIS session's attempt, rendered honestly per arm. */
export function PerformOutcomeView({ outcome }: { outcome: PerformOutcomeResult }) {
  switch (outcome.kind) {
    case 'performed':
      return (
        <>
          <PerformReceiptView receipt={outcome.receipt} />
          {outcome.persisted ? null : (
            <MessageBar intent="warning" data-testid="perform-not-persisted">
              <MessageBarBody>
                <MessageBarTitle>Performed, but NOT recorded.</MessageBarTitle>
                Azure was changed and the receipt above is real, but the recommendation state
                store did not accept the record
                {outcome.persistError ? `: ${outcome.persistError}` : ''}. A reload will show this
                finding as if it had never been performed — the audit stream carries the receipt.
              </MessageBarBody>
            </MessageBar>
          )}
        </>
      );
    case 'refused':
      return (
        <MessageBar intent="warning" data-testid="perform-refused" data-guard={outcome.guard ?? ''}>
          <MessageBarBody>
            {/* The title names the guard the RESPONSE named. When the response
                named none, it says so instead of inventing one — a 409 with no
                `guard` field establishes that the server refused, not which
                guard did it (`deploy-integrity.md` R7). */}
            <MessageBarTitle>
              {outcome.guard
                ? `Refused by the ${outcome.guard} guard.`
                : 'Refused by the server.'}
            </MessageBarTitle>
            {outcome.reason}
            {outcome.guard
              ? ''
              : ' The response named no guard, so WHICH check refused is not established here — ' +
                'the Brain audit trail records it.'}
          </MessageBarBody>
        </MessageBar>
      );
    case 'not-performable':
      // The route's OTHER 409. Titling this "Refused by a server guard" —
      // which is what shipped — asserted a guard ran when the truth is that no
      // executor exists for the class, so nothing ever reached a guard.
      return (
        <MessageBar
          intent="warning"
          data-testid="perform-response-not-performable"
          data-detector={outcome.detector ?? ''}
        >
          <MessageBarBody>
            <MessageBarTitle>No executor for this class.</MessageBarTitle>
            {outcome.reason} No guard was reached and nothing was changed in Azure: the server&apos;s
            registry, not a check on this subject, is what declined.
          </MessageBarBody>
        </MessageBar>
      );
    case 'rejected':
      // R7, inverted (#4260 review, should-fix 1). A 400/401/403 is the ONE
      // family of failures on this surface whose Azure outcome IS established:
      // all three resolve above `performRecommendation`, so the honest claim is
      // the strong one. Warning, not error — an expired session is ordinary and
      // the estate is untouched.
      return (
        <MessageBar intent="warning" data-testid="perform-rejected" data-status={outcome.status}>
          <MessageBarBody>
            <MessageBarTitle>Rejected before anything was attempted.</MessageBarTitle>
            {outcome.reason}
            {` The route answered HTTP ${outcome.status}, which it does BEFORE the perform ` +
              'handler runs — so nothing was staged, nothing was executed, and nothing in Azure ' +
              'changed. '}
            {outcome.status === 401 || outcome.status === 403
              ? 'Sign in again (or with an account in the Loom admin group) and retry.'
              : 'The request body was rejected; nothing about the estate is implied by this.'}
          </MessageBarBody>
        </MessageBar>
      );
    case 'gate':
      return (
        <MessageBar intent="warning" data-testid="perform-gate">
          <MessageBarBody>
            {/* NOT "Not configured in this deployment." That titled every 503 as
                a configuration gap, and the route also answers 503 for a
                Resource Graph collection failure — a token acquisition failure,
                a throttle, a 403, a 500. `apiHonestError` sends only
                `{ok:false, error}`, so nothing in the body separates the two.
                The status establishes that the attempt stopped before running;
                the server's own message is the only thing that says why. */}
            <MessageBarTitle>Stopped at a precondition — nothing was performed.</MessageBarTitle>
            {outcome.reason} This status covers BOTH a value the deploy did not set AND an estate
            read that did not succeed (token acquisition, throttling, or a non-OK Resource Graph
            answer). The response carries no field separating them, so the server&apos;s message
            above is the only discriminator and this page does not guess between them.
          </MessageBarBody>
          {/* G2, as far as this lane can honestly take it. The ONE day-one
              configuration gate behind this status is `cosmos-config`, which is
              already in the registry (`lib/gates/registry/data-plane.ts`) with a
              real ARM resource-picker Fix-it for LOOM_COSMOS_ENDPOINT and a
              wildcard surface that covers this page — so it is discoverable and
              resolvable at /admin/gates today.

              What is NOT shipped here is an INLINE `<HonestGate>`: its bar reads
              "<surface> needs <gate> wired in this deployment", and rendering
              that over a 503 which may equally be an ARG throttle would assert
              the very cause this arm was just fixed to stop guessing at
              (`deploy-integrity.md` R7). The honest inline Fix-it needs the
              route to send a `gate` envelope (`lib/api/gate-envelope.ts`) so the
              client can tell the two apart — a change to
              `app/api/admin/brain/perform/route.ts`, which is the backend
              lane's file. Tracked; see the PR body. */}
          <MessageBarActions>
            <Button
              as="a"
              size="small"
              appearance="secondary"
              href="/admin/gates"
              data-testid="perform-gate-registry"
            >
              Open the gate registry
            </Button>
          </MessageBarActions>
        </MessageBar>
      );
    case 'failed':
      return (
        <MessageBar intent="error" data-testid="perform-failed">
          <MessageBarBody>
            <MessageBarTitle>The change was attempted and reported an error.</MessageBarTitle>
            {outcome.error}
            {' — the write was attempted, so whether Azure changed is NOT established by this '}
            {'result. Re-read the estate before retrying.'}
            {outcome.persisted === false
              ? ' The failure record also did not reach the state store, so a reload will not show it.'
              : ''}
          </MessageBarBody>
        </MessageBar>
      );
    case 'indeterminate':
      return (
        <MessageBar intent="error" data-testid="perform-indeterminate">
          <MessageBarBody>
            <MessageBarTitle>Outcome not established.</MessageBarTitle>
            {outcome.reason}
          </MessageBarBody>
        </MessageBar>
      );
    default:
      // 'staged' never reaches here — it is held as a live phase, not an outcome.
      return null;
  }
}

/**
 * The one-line disclosure the list header carries when the read-back failed,
 * with the retry the operator would otherwise have to reload the page for.
 *
 * This is the ONLY place that warning belongs. Every card used to render its
 * own copy underneath it, which on a 30-finding estate is 31 identical warning
 * MessageBars; `performStateNoticeShown` is the shared predicate that keeps the
 * per-card copy suppressed exactly while this one is up, and the honest
 * "unreadable is not evidence" sentence moved here with it so nothing is lost.
 */
export function PerformStateDisclosure({
  state,
  onRetry,
}: {
  state: PerformStateResult | null;
  onRetry: () => void;
}) {
  if (!performStateNoticeShown(state) || state === null || state.kind === 'ready') return null;
  return (
    <MessageBar intent="warning" data-testid="perform-state-disclosure">
      <MessageBarBody>
        <MessageBarTitle>Recommendation state could not be read.</MessageBarTitle>
        {state.reason} Recorded decisions, receipts and performability are therefore not shown,
        and no Perform action is offered until this read succeeds — an unreadable registry is
        not evidence that the platform cannot act. When the cause IS a value the deploy did not
        set, it is the registered <code>cosmos-config</code> gate, whose Fix-it (an ARM
        resource-picker for <code>LOOM_COSMOS_ENDPOINT</code>) lives in the gate registry.
      </MessageBarBody>
      <MessageBarActions>
        <Button size="small" appearance="secondary" onClick={onRetry} data-testid="perform-state-retry">
          Retry
        </Button>
        <Button
          as="a"
          size="small"
          appearance="transparent"
          href="/admin/gates"
          data-testid="perform-state-gate-registry"
        >
          Open the gate registry
        </Button>
      </MessageBarActions>
    </MessageBar>
  );
}

/** Convenience for the list: index records by findingId. */
export function recordsByFinding(
  state: PerformStateResult | null,
): ReadonlyMap<string, RecommendationStateRecord> {
  const m = new Map<string, RecommendationStateRecord>();
  if (state?.kind === 'ready') for (const r of state.states) m.set(r.findingId, r);
  return m;
}

/**
 * The recommend-only sentence, kept as a constant so the banner, the honesty
 * spec, and the long-standing `no-mutation-controls` contract all read the SAME
 * string rather than three copies that can drift apart.
 */
export const RECOMMEND_ONLY_SENTENCE = 'Nothing on this page changes anything in Azure';
