import { AdminShell } from '@/lib/components/admin-shell';
import { PerformanceEditor } from '@/lib/components/admin/performance-editor';

export const dynamic = 'force-dynamic';

export default function AdminPerformancePage() {
  return (
    <AdminShell sectionTitle="Performance">
      <PerformanceEditor />
    </AdminShell>
  );
}
