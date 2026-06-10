'use client';

import { AdminShell } from '@/lib/components/admin-shell';
import { EmbedCodesPane } from '@/lib/panes/embed-codes';

export default function EmbedCodesPage() {
  return (
    <AdminShell sectionTitle="Embed codes">
      <EmbedCodesPane />
    </AdminShell>
  );
}
