// apex A2: segment loading state for /catalog (shared centered spinner -
// see lib/components/route-loading.tsx).
import { RouteLoading } from '@/lib/components/route-loading';

export default function CatalogLoading() {
  return <RouteLoading section="the Catalog" />;
}
