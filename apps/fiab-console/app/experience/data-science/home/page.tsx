'use client';

/**
 * /experience/data-science/home — the Data Science experience landing page.
 *
 * This is the destination the Data Science entry in the experience switcher
 * (workload-hub `homeHref`) navigates to. It wraps the shared
 * <DataScienceHomeContent> in the standard PageShell chrome (breadcrumbs +
 * <h1> for the UAT h1-coverage check). All data is real — see
 * lib/components/data-science/home-content.tsx and
 * app/api/items/data-science/home/route.ts.
 */

import { PageShell } from '@/lib/components/page-shell';
import { DataScienceHomeContent } from '@/lib/components/data-science/home-content';

export default function DataScienceHomePage() {
  return (
    <PageShell
      title="Data Science"
      subtitle="Notebooks, experiments and models — powered by Azure Machine Learning."
      breadcrumbs={[
        { label: 'Home', href: '/' },
        { label: 'Experiences', href: '/workload-hub' },
        { label: 'Data Science' },
      ]}
    >
      <DataScienceHomeContent />
    </PageShell>
  );
}
