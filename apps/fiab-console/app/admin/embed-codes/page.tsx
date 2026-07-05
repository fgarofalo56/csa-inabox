'use client';

import { AdminShell } from '@/lib/components/admin-shell';
import { EmbedCodesPane } from '@/lib/panes/embed-codes';

export default function EmbedCodesPage() {
  return (
    <AdminShell
      sectionTitle="Embed codes"
      learn={{
        title: 'Embed codes',
        content: 'Generate and revoke read-only, signed embed URLs for reports and visuals so they can be surfaced in external portals and apps. URLs are backed by Azure Blob user-delegation SAS tokens — no Fabric or Power BI workspace is required, and access is Azure-native and time-bounded.',
        tips: [
          'Each embed URL is a scoped, expiring user-delegation SAS — share it without granting portal access.',
          'Revoke a code the moment a report should no longer be externally visible.',
          'Embeds are read-only by design and require no Power BI / Fabric licensing.',
        ],
      }}
    >
      <EmbedCodesPane />
    </AdminShell>
  );
}
