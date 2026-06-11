'use client';

/**
 * /workload-hub/[workload]/[type] — existing items of one item type, scoped
 * from a workload landing page.
 *
 * Wraps the shared <ItemsByTypePane> (real /api/items/by-type Cosmos query +
 * embedded + New CTA) for a single item-type slug, so the user can see what
 * they already have of that type and create more. The New item dialog opens
 * pre-scoped to the item type's workload category.
 *
 * This is the "open the workspace filtered to existing items of that type with
 * a + New CTA" surface — the manage half of create/manage-by-workload.
 */

import { use } from 'react';
import { notFound } from 'next/navigation';
import { PageShell } from '@/lib/components/page-shell';
import { ItemsByTypePane } from '@/lib/components/items-by-type-pane';
import { findWorkloadGroup } from '@/lib/catalog/workload-hub';
import { findItemType } from '@/lib/catalog/fabric-item-types';

interface Props {
  params: Promise<{ workload: string; type: string }>;
}

export default function WorkloadItemTypePage(props: Props) {
  const { workload, type } = use(props.params);

  const group = findWorkloadGroup(workload);
  const item = findItemType(type);
  if (!group || !item) notFound();

  return (
    <PageShell
      title={item.displayName}
      subtitle={`Your ${item.displayName.toLowerCase()} items — and create more in the ${group.name} workload.`}
      breadcrumbs={[
        { label: 'Home', href: '/' },
        { label: 'Workload hub', href: '/workload-hub' },
        { label: group.name, href: `/workload-hub/${group.key}` },
        { label: item.displayName },
      ]}
    >
      <ItemsByTypePane
        types={[item.slug]}
        defaultCategoryForNew={item.category}
        emptyHint={`No ${item.displayName.toLowerCase()} items yet in your tenant.`}
      />
    </PageShell>
  );
}
