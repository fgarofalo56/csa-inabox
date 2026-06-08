'use client';

/**
 * /governance/govern — the "Govern" tab (OneLake Catalog → Govern parity).
 *
 * Two scopes, selected via `?view=`:
 *   - `owner` (default) — the data-owner "My items" view (F3). Rendered by
 *     GovernOwnerPane: posture for items the signed-in user owns, refreshed on
 *     tab-open. Fabric defaults data owners to "My items".
 *   - `admin` — the Admin view (F2): three sub-tabs (Manage estate / Protect,
 *     secure, comply / Discover, trust, reuse) with live posture tiles, a
 *     governance Copilot, and an embedded report. Rendered by GovernAdminPane.
 *     Restricted to tenant admins by the BFF (the pane renders the honest admin
 *     gate on a 403).
 *
 * The route always renders something useful (per ui-parity.md, no dead tab).
 */

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@fluentui/react-components';
import { Open16Regular } from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { GovernAdminPane } from '@/lib/panes/govern-admin';
import { GovernOwnerPane } from '@/lib/panes/govern-owner';

function GovernAdminView() {
  return (
    <PageShell
      title="Govern"
      subtitle="Estate posture, protection, and catalog trust — live from your tenant. No fake numbers."
      breadcrumbs={[{ label: 'Home', href: '/' }, { label: 'Governance', href: '/governance' }, { label: 'Govern' }]}
      actions={
        <Button as="a" href="/governance/govern" appearance="subtle" size="small" icon={<Open16Regular />}>
          My items view
        </Button>
      }
    >
      <GovernAdminPane />
    </PageShell>
  );
}

function GovernContent() {
  const params = useSearchParams();
  const view = params.get('view') ?? 'owner';
  if (view === 'admin') return <GovernAdminView />;
  return <GovernOwnerPane />;
}

export default function GovernPage() {
  return (
    <Suspense fallback={null}>
      <GovernContent />
    </Suspense>
  );
}
