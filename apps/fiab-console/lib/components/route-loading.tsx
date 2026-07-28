'use client';

/**
 * RouteLoading — the shared App Router `loading.tsx` body (apex A2).
 *
 * Rendered by `app/<group>/loading.tsx` while a segment (including the two
 * force-dynamic async server pages, /setup and /admin/health) is streaming in,
 * so navigation shows a centered, labeled spinner inside the shell chrome
 * instead of a blank body (research/page-errors.md finding #2 / G-1).
 */

import { Spinner, makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '60vh',
    padding: tokens.spacingVerticalXXL,
  },
});

export function RouteLoading({ section }: { section?: string }) {
  const s = useStyles();
  return (
    <div className={s.root} role="status" aria-live="polite">
      <Spinner
        size="large"
        labelPosition="below"
        label={section ? `Loading ${section}...` : 'Loading...'}
      />
    </div>
  );
}
