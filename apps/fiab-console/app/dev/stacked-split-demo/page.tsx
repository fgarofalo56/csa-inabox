/**
 * Isolated harness for the StackedSplit primitive (#3699 Phase 2, item B).
 * Dev-only: 404s in production builds and is not linked from any nav.
 */
import { notFound } from 'next/navigation';
import { StackedSplitDemo } from './demo';

export const dynamic = 'force-dynamic';

export default function StackedSplitDemoPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <StackedSplitDemo />;
}
