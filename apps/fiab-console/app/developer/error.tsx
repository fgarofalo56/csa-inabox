'use client';

// apex A2: segment error boundary for /developer - keeps the shell chrome and
// renders the shared Loom recovery card (see lib/components/route-error.tsx).
import { RouteError, type RouteErrorProps } from '@/lib/components/route-error';

export default function DeveloperError(props: RouteErrorProps) {
  return <RouteError {...props} section="the Developer hub" />;
}
