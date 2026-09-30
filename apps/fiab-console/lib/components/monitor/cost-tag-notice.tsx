'use client';
/**
 * The MessageBar for the cost-allocation TAG breakdown, one per
 * {@link tagLoadState} outcome. Split out of `monitor-pane.tsx` (frozen at its
 * file-size ceiling) so the state logic is a pure, tested function.
 *
 * `none` — the only state that says no tags were found — carries no Fix-it:
 * the remedy is tagging Azure resources or changing the `LOOM_COST_TAG_KEY`
 * container env var, neither of which the console can perform from this
 * surface today. That gap is disclosed here rather than papered over with a
 * button that does nothing.
 */
import {
  Button, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle, Skeleton, SkeletonItem, tokens,
} from '@fluentui/react-components';
import { tagLoadState, type TagQueryError, type TagSummaryLike } from './cost-tag-state';

export const shortSub = (s: string) => (s.length > 12 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s);

/** How many per-subscription errors are listed inline before the rest are counted. */
export const ERRORS_SHOWN = 3;
/** Longest raw Azure error text shown per subscription; longer text is cut and marked with an ellipsis. */
export const ERROR_TEXT_MAX = 300;
const clip = (t: string) => (t.length > ERROR_TEXT_MAX ? `${t.slice(0, ERROR_TEXT_MAX)}…` : t);
export const listErrors = (errors: TagQueryError[]) => {
  const shown = errors.slice(0, ERRORS_SHOWN)
    .map((s) => `${shortSub(s.subscription)}: ${clip(s.error || 'no error text returned')}`).join(' · ');
  const more = errors.length - ERRORS_SHOWN;
  return more > 0 ? `${shown} · and ${more} more` : shown;
};

/**
 * The empty text for a breakdown table, which must never claim emptiness it did
 * not read: a gate, a failed read, and a breakdown missing whole subscriptions
 * each say so instead of "No cost recorded." (#4771 round 8, B-2).
 *
 * `omitted` is for a site with no partial-breakdown notice beside it (the
 * Monitor distribution donuts, #4771 round 9): the count goes into the text
 * itself instead of pointing at a notice that is not there.
 */
export function breakdownEmptyText({ gated, failed, partial, omitted }: {
  gated: boolean; failed: boolean; partial: boolean; omitted?: number;
}) {
  if (gated) return 'Grant Cost Management Reader to see this breakdown.';
  if (failed) return 'The cost read did not complete, so nothing is known about this breakdown. The message above says why.';
  if (partial && omitted !== undefined) {
    return `No cost recorded in the subscriptions that answered. ${omitted} subscription${omitted === 1 ? '' : 's'} did not answer, so this is not a complete answer.`;
  }
  if (partial) return 'No cost recorded in the subscriptions that answered. The partial-breakdown notice above names the ones that did not.';
  return 'No cost recorded.';
}

/**
 * A breakdown on any dimension that omits whole subscriptions whose cost read
 * failed (`subscriptionErrors`). Rendered with the rows, so a partial answer is
 * never read as complete (#4771 round 8, B-1 and A-4). The tag dimension folds
 * the same errors into {@link CostTagNotice} instead.
 */
export function PartialBreakdownNotice({ errors, dimension, onRetry }: {
  errors: TagQueryError[] | null | undefined;
  /** The dimension the breakdown is grouped by, as the user reads it. */
  dimension: string;
  /** Re-reads the breakdown. */
  onRetry?: () => void;
}) {
  if (!errors?.length) return null;
  return (
    <MessageBar intent="warning">
      <MessageBarBody>
        <MessageBarTitle>Partial breakdown</MessageBarTitle>
        Partial: the <strong>{dimension}</strong> breakdown omits spend from {errors.length} subscription
        {errors.length === 1 ? '' : 's'} whose cost read failed — {listErrors(errors)}.
      </MessageBarBody>
      {onRetry ? <MessageBarActions><Button size="small" onClick={onRetry}>Retry</Button></MessageBarActions> : null}
    </MessageBar>
  );
}

export function CostTagNotice({ summary, loading = false, gated = false, onRetry }: {
  summary: (TagSummaryLike & { tagKey?: string }) | null | undefined;
  /** The summary is still being read: render a skeleton, claim nothing. */
  loading?: boolean;
  /**
   * A gate answered instead of a summary. The gate's own bar carries the fix;
   * a Retry here could only hit the same gate, so it is withheld.
   */
  gated?: boolean;
  /** Re-reads the summary. Offered on every state that is not a final answer. */
  onRetry?: () => void;
}) {
  const state = tagLoadState(summary);
  const key = summary?.tagKey || 'Environment';
  const retry = onRetry && !gated ? (
    <MessageBarActions><Button size="small" onClick={onRetry}>Retry</Button></MessageBarActions>
  ) : null;
  if (state.kind === 'ok') return null;
  if (state.kind === 'unknown') {
    if (loading) {
      return (
        <Skeleton aria-label="Loading the tag breakdown">
          <SkeletonItem style={{ height: tokens.lineHeightBase500, borderRadius: tokens.borderRadiusMedium }} />
        </Skeleton>
      );
    }
    return (
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Tag breakdown unavailable</MessageBarTitle>
          The cost summary was not read, so nothing is known yet about the <strong>{key}</strong> tag.
          {gated ? ' Cost is not configured on this deployment; the notice above names what is missing and how to fix it.' : ' The message above says why.'}
        </MessageBarBody>
        {retry}
      </MessageBar>
    );
  }
  if (state.kind === 'failed') {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Tag breakdown could not be loaded</MessageBarTitle>
          The <strong>{key}</strong> tag breakdown could not be loaded: {listErrors(state.errors)}. This says
          nothing about whether your resources carry the tag.
        </MessageBarBody>
        {retry}
      </MessageBar>
    );
  }
  if (state.kind === 'partial') {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Partial tag breakdown</MessageBarTitle>
          Partial: the <strong>{key}</strong> breakdown below omits spend from {state.errors.length} subscription
          {state.errors.length === 1 ? '' : 's'} whose tag query failed — {listErrors(state.errors)}.
        </MessageBarBody>
        {retry}
      </MessageBar>
    );
  }
  return (
    <MessageBar intent="warning">
      <MessageBarBody>
        <MessageBarTitle>No tags found</MessageBarTitle>
        No cost-allocation tags found for tag key <strong>{key}</strong>. Tag your Azure resources with this key (or
        set <strong>LOOM_COST_TAG_KEY</strong> to a tag your estate already applies, e.g. CostCenter, Project, Owner)
        to break spend down by tag value.
      </MessageBarBody>
    </MessageBar>
  );
}
