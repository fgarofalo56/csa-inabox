'use client';

// apex A2: segment error boundary for /semantic-model - keeps the shell chrome and
// renders the shared Loom recovery card (see lib/components/route-error.tsx).
import { RouteError, type RouteErrorProps } from '@/lib/components/route-error';

export default function SemanticModelError(props: RouteErrorProps) {
  return <RouteError {...props} section="this semantic model" />;
}
