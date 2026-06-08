'use client';

/**
 * /governance/govern — the Govern tab (OneLake Catalog → Govern parity).
 *
 * Two scopes, selected via `?view=`:
 *   - `owner` (default) — the data-owner "My items" view (F3). Rendered by
 *     GovernOwnerPane: posture for items the signed-in user owns, refreshed on
 *     tab-open.
 *   - `admin` — the tenant-wide governance posture. Loom already ships this as
 *     a full, real surface at /governance/insights (compliance score, coverage
 *     by item type, policy effectiveness, audit activity), so this scope links
 *     straight to it rather than duplicating the dashboard.
 *
 * Fabric defaults data owners to "My items" and admins to "All data"; Loom
 * defaults to the owner scope here and exposes the tenant-wide view via the
 * Insights nav entry.
 */

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Button, Body1 } from '@fluentui/react-components';
import { Open16Regular } from '@fluentui/react-icons';
import { GovernanceShell } from '@/lib/components/governance-shell';
import { GovernOwnerPane } from '@/lib/panes/govern-owner';

function GovernAdminRedirect() {
  return (
    <GovernanceShell sectionTitle="Govern" sectionBadge="All data">
      <Body1 style={{ display: 'block', marginBottom: 16 }}>
        The tenant-wide governance posture — compliance score, coverage by item type, policy
        effectiveness, and audit activity — lives in Insights.
      </Body1>
      <Link href="/governance/insights">
        <Button appearance="primary" icon={<Open16Regular />}>Open tenant-wide Insights</Button>
      </Link>
    </GovernanceShell>
  );
}

function GovernContent() {
  const params = useSearchParams();
  const view = params.get('view') ?? 'owner';
  if (view === 'admin') return <GovernAdminRedirect />;
  return <GovernOwnerPane />;
}

export default function GovernPage() {
  return (
    <Suspense fallback={null}>
      <GovernContent />
    </Suspense>
  );
}
