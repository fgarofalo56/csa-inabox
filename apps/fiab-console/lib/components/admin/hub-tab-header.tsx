'use client';

/**
 * HubTabHeader — the heading row a consolidated admin hub renders at the top of
 * each tab pane: the tab's own title plus the LearnPopover that used to sit on
 * that surface's standalone page.
 *
 * Folding N pages into one hub must not lose N sets of contextual help: the
 * AdminShell header carries the HUB's Learn content, and this carries the TAB's
 * (ux-baseline §guidance UX — every surface keeps its LearnPopover).
 *
 * Fluent v9 + Loom tokens only.
 */

import { Subtitle2, makeStyles, tokens } from '@fluentui/react-components';
import { LearnPopover, type LearnPopoverProps } from '@/lib/components/ui/learn-popover';

const useStyles = makeStyles({
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    flexWrap: 'wrap',
    minWidth: 0,
    marginBottom: tokens.spacingVerticalM,
  },
  title: { minWidth: 0, overflowWrap: 'anywhere' },
});

export function HubTabHeader({ title, learn }: { title: string; learn: LearnPopoverProps }) {
  const styles = useStyles();
  return (
    <div className={styles.head}>
      <Subtitle2 as="h3" className={styles.title}>{title}</Subtitle2>
      <LearnPopover {...learn} />
    </div>
  );
}
