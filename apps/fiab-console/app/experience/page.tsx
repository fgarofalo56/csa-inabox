'use client';

/**
 * /experience — the experience landing hub (the "front door" to Loom's
 * per-persona experiences).
 *
 * Individual experiences live under /experience/<name>/home (e.g.
 * /experience/data-science/home, /experience/warp/home). Hitting the bare
 * /experience segment used to blind-redirect to Data Science, which meant an
 * old bookmark or the nav root silently jumped and never showed the choice.
 * UX-baseline (UX-1012, SC-4 guided launcher + SC-6 teaching banner): render a
 * real landing hub with a guided launcher card per experience so the segment is
 * a designed surface, not a redirect. Every card navigates to a real,
 * fully-built experience home — no dead tiles (no-vaporware).
 */

import { useRouter } from 'next/navigation';
import { PageShell } from '@/lib/components/page-shell';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { GuidedEmptyState, type GuidedPath } from '@/lib/components/shared/guided-empty-state';
import { LOOM_ACCENT } from '@/lib/components/shared/accent-tokens';
import {
  CompassNorthwest24Regular, BrainCircuit24Regular, Flow24Regular, Sparkle24Regular,
} from '@fluentui/react-icons';

export default function ExperienceLanding() {
  const router = useRouter();

  const paths: GuidedPath[] = [
    {
      key: 'data-science',
      title: 'Data Science',
      body: 'Notebooks, experiments and models — powered by Azure Machine Learning.',
      icon: BrainCircuit24Regular,
      accent: LOOM_ACCENT.violet,
      href: '/experience/data-science/home',
      onClick: () => router.push('/experience/data-science/home'),
    },
    {
      key: 'warp',
      title: 'Orchestration (Warp)',
      body: 'Schedule, chain and monitor data pipelines across every Loom runtime.',
      icon: Flow24Regular,
      accent: LOOM_ACCENT.teal,
      href: '/experience/warp/home',
      onClick: () => router.push('/experience/warp/home'),
    },
    {
      key: 'workloads',
      title: 'All workloads',
      body: 'Browse every workload experience and switch personas from the hub.',
      icon: CompassNorthwest24Regular,
      accent: LOOM_ACCENT.blue,
      href: '/workload-hub',
      onClick: () => router.push('/workload-hub'),
    },
  ];

  return (
    <PageShell
      title="Experiences"
      subtitle="Persona-tuned workspaces — pick where you want to work today"
      breadcrumbs={[{ label: 'Home', href: '/' }, { label: 'Experiences' }]}
    >
      <TeachingBanner
        surfaceKey="experience-hub"
        title="One product, many experiences"
        message="Each experience tailors the ribbon, home page and Copilot to a persona — Data Science for ML, Warp for orchestration — while every item stays available everywhere. Choose a starting point below; you can switch any time from the workload hub."
        icon={Sparkle24Regular}
        accent={LOOM_ACCENT.violet}
      />
      <GuidedEmptyState
        title="Choose an experience"
        intro="Every experience opens a fully-built home with real data — pick the one that matches what you're doing."
        heroIcon={CompassNorthwest24Regular}
        paths={paths}
        learnMoreHref="https://learn.microsoft.com/fabric/get-started/fabric-home"
        ariaLabel="Loom experiences"
      />
    </PageShell>
  );
}
