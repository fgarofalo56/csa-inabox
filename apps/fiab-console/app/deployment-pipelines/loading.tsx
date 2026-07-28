// apex A2: segment loading state for /deployment-pipelines (shared centered spinner -
// see lib/components/route-loading.tsx).
import { RouteLoading } from '@/lib/components/route-loading';

export default function DeploymentPipelinesLoading() {
  return <RouteLoading section="Deployment pipelines" />;
}
