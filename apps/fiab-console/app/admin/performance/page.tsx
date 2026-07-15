import { AdminShell } from '@/lib/components/admin-shell';
import { PerformanceEditor } from '@/lib/components/admin/performance-editor';

export const dynamic = 'force-dynamic';

export default function AdminPerformancePage() {
  return (
    <AdminShell
      sectionTitle="Performance"
      learn={{
        title: 'Performance & benchmarks',
        content:
          'Runs the repeatable PSR-1 perf suite on demand — p50/p95/p99 and cold-vs-warm for Spark attach, warehouse/ADX query, dashboard tile TTI, Copilot turn and page TTI — trended against the published Microsoft Fabric bars. Real Azure-native backends, no synthetic timings.',
        tips: [
          'Each run writes a perf-benchmarks row; the chart trends across rolls',
          'CI enforces budgets via perf-gate.yml + perf-budgets.json',
          'Optional Log Analytics export stays off until LOOM_PERF_DCR_* is set',
        ],
        learnMoreHref: 'https://learn.microsoft.com/azure/well-architected/performance-efficiency/',
      }}
    >
      <PerformanceEditor />
    </AdminShell>
  );
}
