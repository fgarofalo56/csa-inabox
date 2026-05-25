import { redirect } from 'next/navigation';

export default function WorkloadHubPage() {
  // /workload-hub and /workloads converge — keep the canonical page at /workloads
  // (Cosmos workloads-catalog), redirect the legacy URL here.
  redirect('/workloads');
}
