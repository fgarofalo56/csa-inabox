'use client';

// apex A2: segment error boundary for /auth — keeps the shell chrome and
// renders the shared Loom recovery card (see lib/components/route-error.tsx).
//
// This segment earned a boundary when #3334 added /auth/blocked, the circuit
// breaker's terminal page. It matters more here than on most segments: a user
// only reaches /auth/blocked because sign-in is ALREADY failing, so an
// unhandled render error on that page would leave them with nothing at all.
import { RouteError, type RouteErrorProps } from '@/lib/components/route-error';

export default function AuthError(props: RouteErrorProps) {
  return <RouteError {...props} section="Sign-in" />;
}
