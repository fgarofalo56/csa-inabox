'use client';

// apex A2: segment error boundary for /dev (dev-only harness routes) - renders
// the shared Loom recovery card (see lib/components/route-error.tsx).
import { RouteError, type RouteErrorProps } from '@/lib/components/route-error';

export default function DevError(props: RouteErrorProps) {
  return <RouteError {...props} section="Dev" />;
}
