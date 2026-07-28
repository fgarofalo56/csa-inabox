'use client';

// apex A2: segment error boundary for /data-agent - keeps the shell chrome and
// renders the shared Loom recovery card (see lib/components/route-error.tsx).
import { RouteError, type RouteErrorProps } from '@/lib/components/route-error';

export default function DataAgentError(props: RouteErrorProps) {
  return <RouteError {...props} section="the Data agent" />;
}
