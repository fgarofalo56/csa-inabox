'use client';

/**
 * /governance/govern — the "Govern" tab.
 *
 * ?view=admin → the Admin view (F2): three sub-tabs (Manage estate / Protect,
 * secure, comply / Discover, trust, reuse) with live posture tiles, a
 * governance Copilot, and an embedded report. Restricted to tenant admins by
 * the BFF (the pane renders the honest admin gate on a 403).
 *
 * Any other ?view (or none) → a pointer to the governance landing experience,
 * so the route always renders something useful (per ui-parity.md, no dead tab).
 */

import { useSearchParams } from 'next/navigation';
import { Button } from '@fluentui/react-components';
import { Open16Regular } from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { Section } from '@/lib/components/ui/section';
import { GovernAdminPane } from '@/lib/panes/govern-admin';

export default function GovernPage() {
  const params = useSearchParams();
  const view = params.get('view');

  return (
    <PageShell
      title="Govern"
      subtitle="Estate posture, protection, and catalog trust — live from your tenant. No fake numbers."
      breadcrumbs={[{ label: 'Home', href: '/' }, { label: 'Governance', href: '/governance' }, { label: 'Govern' }]}
      actions={
        <Button as="a" href="/governance" appearance="subtle" size="small" icon={<Open16Regular />}>
          Governance overview
        </Button>
      }
    >
      {view === 'admin' ? (
        <GovernAdminPane />
      ) : (
        <Section title="Govern — Admin view">
          <p style={{ margin: 0 }}>
            The Govern tab&apos;s estate-wide posture, protection, and catalog-trust monitoring lives in the
            Admin view.{' '}
            <a href="/governance/govern?view=admin">Open the Admin view →</a>
          </p>
        </Section>
      )}
    </PageShell>
  );
}
