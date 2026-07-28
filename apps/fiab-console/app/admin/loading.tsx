// apex A2: segment loading state for /admin (shared centered spinner -
// see lib/components/route-loading.tsx).
import { RouteLoading } from '@/lib/components/route-loading';

export default function AdminLoading() {
  return <RouteLoading section="Admin" />;
}
