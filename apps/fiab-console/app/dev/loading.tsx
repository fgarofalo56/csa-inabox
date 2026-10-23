// apex A2: segment loading state for /dev (dev-only harness routes) - shared
// centered spinner, see lib/components/route-loading.tsx.
import { RouteLoading } from '@/lib/components/route-loading';

export default function DevLoading() {
  return <RouteLoading section="Dev" />;
}
