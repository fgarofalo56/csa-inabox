// apex A2: segment loading state for /auth (shared centered spinner —
// see lib/components/route-loading.tsx).
import { RouteLoading } from '@/lib/components/route-loading';

export default function AuthLoading() {
  return <RouteLoading section="Sign-in" />;
}
