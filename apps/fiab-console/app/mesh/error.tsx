'use client';

// apex A2: segment error boundary for /mesh - keeps the shell chrome and
// renders the shared Loom recovery card (see lib/components/route-error.tsx).
import { RouteError, type RouteErrorProps } from '@/lib/components/route-error';

export default function MeshError(props: RouteErrorProps) {
  return <RouteError {...props} section="Mesh" />;
}
