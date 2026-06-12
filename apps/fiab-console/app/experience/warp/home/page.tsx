'use client';

/**
 * /experience/warp/home — the Warp experience landing page.
 *
 * Warp is CSA Loom's unified visual + code transform / pipeline builder. It is a
 * branded surface over three existing production pillars (visual-query compiler,
 * dbt-job codegen/runner, and the data-pipeline / Spark-job editors) — see
 * csa_loom_weave_epic.md. This page wraps <WarpHubContent> in the standard
 * PageShell chrome (breadcrumbs + <h1> for the UAT h1-coverage check). All data
 * is real — see lib/components/warp/warp-hub-content.tsx and
 * app/api/experience/warp/home/route.ts.
 */

import { PageShell } from '@/lib/components/page-shell';
import { WarpHubContent } from '@/lib/components/warp/warp-hub-content';

export default function WarpHomePage() {
  return (
    <PageShell
      title="Warp"
      subtitle="Build data transforms visually or in code — emitting and running real Spark / SQL. Azure-native by default; no Microsoft Fabric capacity required."
      breadcrumbs={[
        { label: 'Home', href: '/' },
        { label: 'Experiences', href: '/workload-hub' },
        { label: 'Warp' },
      ]}
    >
      <WarpHubContent />
    </PageShell>
  );
}
