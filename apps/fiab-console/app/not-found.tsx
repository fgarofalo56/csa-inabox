'use client';

/**
 * Branded 404 — renders for any unmatched route and for `notFound()` calls
 * (e.g. an unknown item type in /items/[type]/[id]). Replaces the bare Next.js
 * default 404 so a bad URL still reads as the same polished product
 * (web3-ui.md: EmptyState + Loom tokens, never an unstyled page). rel-T09d.
 */

import { useRouter } from 'next/navigation';
import { makeStyles, tokens } from '@fluentui/react-components';
import { EmptyState } from '@/lib/components/empty-state';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '70vh',
    padding: tokens.spacingVerticalXXL,
  },
  inner: { width: '100%', maxWidth: '560px' },
});

export default function NotFound() {
  const s = useStyles();
  const router = useRouter();
  return (
    <div className={s.root}>
      <div className={s.inner}>
        <EmptyState
          icon="⚲"
          title="We couldn't find that page"
          body="The page or item you're looking for doesn't exist, was renamed, or was removed. Check the URL, or head back to your workspace to keep going."
          primaryAction={{ label: 'Go to home', onClick: () => router.push('/') }}
          secondaryAction={{ label: 'Browse the catalog', href: '/browse' }}
        />
      </div>
    </div>
  );
}
