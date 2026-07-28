'use client';

// apex A2: segment error boundary for /settings - keeps the shell chrome and
// renders the shared Loom recovery card (see lib/components/route-error.tsx).
import { RouteError, type RouteErrorProps } from '@/lib/components/route-error';

export default function SettingsError(props: RouteErrorProps) {
  return <RouteError {...props} section="Settings" />;
}
