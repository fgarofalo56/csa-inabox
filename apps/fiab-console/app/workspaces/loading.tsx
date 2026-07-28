// apex A2: segment loading state for /workspaces (shared centered spinner -
// see lib/components/route-loading.tsx).
import { RouteLoading } from '@/lib/components/route-loading';

export default function WorkspacesLoading() {
  return <RouteLoading section="Workspaces" />;
}
