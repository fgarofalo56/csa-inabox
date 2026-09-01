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
  /** A guard said no, or the class is not performable. Nothing was changed. */
  | { readonly kind: 'refused'; readonly reason: string; readonly guard?: string }
  /** An honest infra gate (503) — a value the deploy emits is missing. */
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

/** How many of these findings the server says the platform can perform. */
export function performableCount(
  findings: readonly { readonly detector: string; readonly ownershipConfirmed: boolean }[],
  state: PerformStateResult | null,
): number {
  if (!state || state.kind !== 'ready') return 0;
  return findings.filter((f) => {
    if (!f.ownershipConfirmed) return false;
    const entry = performabilityFor(state.performability, f.detector);
    return entry?.performable === true;
  }).length;
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
}: PerformControlsProps) {
  const s = useStyles();
  const [live, setLive] = React.useState<Live>({ phase: 'idle' });
  const [typed, setTyped] = React.useState('');

  const entry = state?.kind === 'ready' ? performabilityFor(state.performability, detector) : undefined;

  const stage = React.useCallback(
    async (subjectNodeId: string) => {
      setLive({ phase: 'busy' });
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
      setLive({ phase: 'outcome', outcome: out });
    },
    [detector, findingId, perform],
  );

  const confirm = React.useCallback(async () => {
    if (live.phase !== 'staged') return;
    const { subjectNodeId, confirmToken } = live;
    setLive({ phase: 'busy' });
    // The token travels back EXACTLY as the server minted it. It is never
    // reconstructed, never defaulted, never sent when absent.
    const out = await perform({ findingId, detector, subjectNodeId, confirmToken });
    setLive({ phase: 'outcome', outcome: out });
  }, [detector, findingId, live, perform]);

  // ── the read-back could not be read ─────────────────────────────────────
  if (state === null) return null;
  if (state.kind === 'unavailable') {
    return (
      <MessageBar intent="warning" data-testid="perform-state-unavailable">
        <MessageBarBody>
          <MessageBarTitle>Perform is unavailable.</MessageBarTitle>
          The recommendation state read-back did not succeed: {state.reason} Whether this
          recommendation can be performed is not known here, so no action is offered — an
          unreadable registry is not evidence that the platform cannot act.
        </MessageBarBody>
      </MessageBar>
    );
  }

  // ── the class is not performable, with the server's own reason ──────────
  if (!entry || entry.performable !== true) {
    const reason =
      entry?.notPerformableReason ??
      `Detector '${detector}' is not in the server's performability registry, so this ` +
        'console does not know of an executor for it. Nothing is offered rather than a ' +
        'control that would refuse — and the registry, not this page, is where a kind is added.';
    return (
      <MessageBar intent="warning" data-testid="perform-not-performable" data-detector={detector}>
        <MessageBarBody>
          <MessageBarTitle>The platform cannot perform this one.</MessageBarTitle>
          {reason}
        </MessageBarBody>
      </MessageBar>
    );
  }

  // ── performable, but ownership is not established ───────────────────────
  if (!ownershipConfirmed) {
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

  const alreadyPerformed = record?.state === 'performed';
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

      {alreadyPerformed ? (
        <MessageBar intent="success" data-testid="perform-already">
          <MessageBarBody>
            This recommendation is already recorded as performed; its receipt is above. Reload the
            Brain for a fresh snapshot rather than performing it twice.
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
        <MessageBar intent="warning" data-testid="perform-refused">
          <MessageBarBody>
            <MessageBarTitle>Refused by a server guard.</MessageBarTitle>
            {outcome.guard ? `[${outcome.guard}] ` : ''}
            {outcome.reason}
          </MessageBarBody>
        </MessageBar>
      );
    case 'gate':
      return (
        <MessageBar intent="warning" data-testid="perform-gate">
          <MessageBarBody>
            <MessageBarTitle>Not configured in this deployment.</MessageBarTitle>
            {outcome.reason}
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
 */
export function PerformStateDisclosure({
  state,
  onRetry,
}: {
  state: PerformStateResult | null;
  onRetry: () => void;
}) {
  if (state === null || state.kind === 'ready') return null;
  return (
    <MessageBar intent="warning" data-testid="perform-state-disclosure">
      <MessageBarBody>
        <MessageBarTitle>Recommendation state could not be read.</MessageBarTitle>
        {state.reason} Recorded decisions, receipts and performability are therefore not shown,
        and no Perform action is offered until this read succeeds.
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
