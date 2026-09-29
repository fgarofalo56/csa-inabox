'use client';
/**
 * The MessageBar for the cost-allocation TAG breakdown, one per
 * {@link tagLoadState} outcome. Split out of `monitor-pane.tsx` (frozen at its
 * file-size ceiling) so the state logic is a pure, tested function.
 */
import { MessageBar, MessageBarBody } from '@fluentui/react-components';
import { tagLoadState, type TagQueryError } from './cost-tag-state';

const shortSub = (s: string) => (s.length > 12 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s);
const listErrors = (errors: TagQueryError[]) =>
  errors.map((s) => `${shortSub(s.subscription)}: ${s.error || 'no error text returned'}`).join(' · ');

export function CostTagNotice({ summary }: {
  summary: { byTag?: { key: string; cost: number }[] | null; tagQueryErrors?: TagQueryError[] | null; tagKey?: string } | null | undefined;
}) {
  const state = tagLoadState(summary);
  const key = summary?.tagKey || 'Environment';
  if (state.kind === 'ok') return null;
  if (state.kind === 'failed') {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          The <strong>{key}</strong> tag breakdown could not be loaded: {listErrors(state.errors)}. This says
          nothing about whether your resources carry the tag.
        </MessageBarBody>
      </MessageBar>
    );
  }
  if (state.kind === 'partial') {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          Partial: the <strong>{key}</strong> breakdown below omits spend from {state.errors.length} subscription
          {state.errors.length === 1 ? '' : 's'} whose tag query failed — {listErrors(state.errors)}.
        </MessageBarBody>
      </MessageBar>
    );
  }
  return (
    <MessageBar intent="warning">
      <MessageBarBody>
        No cost-allocation tags found for tag key <strong>{key}</strong>. Tag your Azure resources with this key (or
        set <strong>LOOM_COST_TAG_KEY</strong> to a tag your estate already applies, e.g. CostCenter, Project, Owner)
        to break spend down by tag value.
      </MessageBarBody>
    </MessageBar>
  );
}
