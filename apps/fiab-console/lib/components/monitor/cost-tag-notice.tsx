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
export const listErrors = (errors: TagQueryError[]) => {
  const shown = errors.slice(0, ERRORS_SHOWN)
    .map((s) => `${shortSub(s.subscription)}: ${s.error || 'no error text returned'}`).join(' · ');
  const more = errors.length - ERRORS_SHOWN;
  return more > 0 ? `${shown} · and ${more} more` : shown;
};

export function CostTagNotice({ summary, loading = false, onRetry }: {
  summary: (TagSummaryLike & { tagKey?: string }) | null | undefined;
  /** The summary is still being read: render a skeleton, claim nothing. */
  loading?: boolean;
  /** Re-reads the summary. Offered on every state that is not a final answer. */
  onRetry?: () => void;
}) {
  const state = tagLoadState(summary);
  const key = summary?.tagKey || 'Environment';
  const retry = onRetry ? (
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
          The cost summary was not read, so nothing is known yet about the <strong>{key}</strong> tag. The message
          above says why.
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
