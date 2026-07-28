// apex A2: segment loading state for /api-marketplace (shared centered spinner -
// see lib/components/route-loading.tsx).
import { RouteLoading } from '@/lib/components/route-loading';

export default function ApiMarketplaceLoading() {
  return <RouteLoading section="the API marketplace" />;
}
