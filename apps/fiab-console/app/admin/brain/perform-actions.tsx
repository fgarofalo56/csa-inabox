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
 */
export function performOfferSummary(
  findings: readonly PerformSubject[],
  state: PerformStateResult | null,
  records: ReadonlyMap<string, RecommendationStateRecord>,
  performedInSession: ReadonlySet<string>,
): { readonly offered: number; readonly alreadyPerformed: number } {
  let offered = 0;
  let alreadyPerformed = 0;
  for (const f of findings) {
    const d = performDisposition(f, state, records.get(f.id), performedInSession);
    if (d.kind === 'offer') offered += 1;
    else if (d.kind === 'already-performed') alreadyPerformed += 1;
  }
  return { offered, alreadyPerformed };
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
          subject, so the server would refuse at the ownership guard. Stamp the estate ownership
          tag in the deploy and this becomes available.
        </MessageBarBody>
      </MessageBar>
    );
  }

  const entry = disposition.entry;
  const busy = live.phase === 'busy';

  return (
    <div className={s.block} data-testid="perform-block" data-executor={entry.executor}>
      <div className={s.row}>
        <Badge appearance="tint" color="danger" data-testid="perform-class">
          destructive · {entry.executor}
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
 * The typed-resource-name confirm.
 *
 * It opens only AFTER the server staged and returned a token, so the dialog can
 * state truthfully that nothing has changed yet, and the confirm button is the
 * only control that carries the token back.
 */
function StagedConfirmDialog({
  executor,
  expiresAt,
  resourceName,
  subjectNodeId,
  typed,
  onTyped,
  onCancel,
  onConfirm,
}: {
  executor: PerformExecutorKind;
  expiresAt: string;
  resourceName: string;
  subjectNodeId: string;
  typed: string;
  onTyped: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const s = useStyles();
  return (
    <Dialog open modalType="alert" onOpenChange={(_, d) => !d.open && onCancel()}>
      <DialogSurface data-testid="perform-confirm-dialog">
        <DialogBody>
          <DialogTitle>Confirm this change</DialogTitle>
          <DialogContent>
            <div className={s.dialogBlock}>
              <Body1>
                {executor === 'delete-resource'
                  ? 'The platform will issue an ARM delete for this resource. It is not recoverable from this page.'
                  : 'The platform will drop this app’s always-on replica floor to zero. The app stays deployed and scales back up on demand; the always-on billing stops and a cold start returns.'}
              </Body1>
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Staged. Nothing has changed yet.</MessageBarTitle>
                  The server minted a single-use confirmation for this exact finding and subject; it
                  expires at {expiresAt}. Cancelling leaves the estate untouched.
                </MessageBarBody>
              </MessageBar>
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
        not evidence that the platform cannot act.
      </MessageBarBody>
      <MessageBarActions>
        <Button size="small" appearance="secondary" onClick={onRetry} data-testid="perform-state-retry">
          Retry
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
