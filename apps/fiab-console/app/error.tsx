'use client';

// apex A2: root error boundary - catches page-segment errors that no
// first-level group boundary covers, keeping the shell chrome (root layout)
// and rendering the shared Loom recovery card. The root LAYOUT itself is
// covered by app/global-error.tsx.
import { RouteError, type RouteErrorProps } from '@/lib/components/route-error';

export default function RootError(props: RouteErrorProps) {
  return <RouteError {...props} />;
}
