// apex A2: segment loading state for /semantic-model (shared centered spinner -
// see lib/components/route-loading.tsx).
import { RouteLoading } from '@/lib/components/route-loading';

export default function SemanticModelLoading() {
  return <RouteLoading section="this semantic model" />;
}
