// apex A2: segment loading state for /items (shared centered spinner -
// see lib/components/route-loading.tsx).
import { RouteLoading } from '@/lib/components/route-loading';

export default function ItemsLoading() {
  return <RouteLoading section="this item" />;
}
