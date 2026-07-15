'use client';

import { makeStyles, tokens } from '@fluentui/react-components';
import { AdminShell } from '@/lib/components/admin-shell';
import { EnvConfigPane } from '@/lib/components/admin/env-config-pane';
import { PowerBiBackendCard } from '@/lib/components/admin/power-bi-backend-card';
import { AzureMapsCard } from '@/lib/components/admin/azure-maps-card';
import { SectionExplainer, LearnPopover } from '@/lib/components/ui/learn-popover';

const useStyles = makeStyles({
  explainer: { marginBottom: tokens.spacingVerticalL },
  explainerList: {
    marginTop: tokens.spacingVerticalS,
    marginBottom: 0,
    paddingLeft: tokens.spacingHorizontalXL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
});

export default function AdminEnvConfigPage() {
  const s = useStyles();
  return (
    <AdminShell
      sectionTitle="Runtime configuration"
      learn={{
        title: 'Runtime configuration',
        content:
          'View and set the console deployment env vars (Cosmos, AOAI, Synapse, ADX, …) from the UI — a real ARM revision + audit trail, no Azure portal. Secret-typed keys are stored as ACA secrets, never in plaintext.',
        tips: [
          'Apply rolls a new loom-console Container App revision (durable)',
          'Emits a bicep reconcile snippet so the change survives the next deploy',
          'Needs Contributor on the loom-console Container App',
        ],
        learnMoreHref: 'https://learn.microsoft.com/azure/container-apps/environment-variables',
      }}
    >
      <div className={s.explainer}>
        <SectionExplainer>
          These are the deployment environment variables that turn Loom features on and point them at your Azure services — set them here instead of the Azure portal&apos;s Container Apps → Environment variables blade. Each key is grouped by what it drives:
          <ul className={s.explainerList}>
            <li><strong>Identity &amp; session</strong> — Entra app + session settings that gate sign-in and tenant-admin access.</li>
            <li><strong>Data plane</strong> — the Cosmos endpoint + containers that are Loom&apos;s own store.</li>
            <li><strong>Azure services</strong> — the AOAI, Synapse, ADX, Event Hubs, AI Search, and related endpoints each editor calls; a feature that isn&apos;t wired shows an honest gate naming the exact key to set.</li>
            <li><strong>Permissions &amp; security posture</strong> — Purview account, role-assignment principals, and security toggles.</li>
          </ul>
          <span>
            {' '}Values are stored as desired-state — every Save persists to Cosmos and applies a real ARM PATCH (a new container-app revision).{' '}
            <LearnPopover
              title="How Save works"
              content="Saving a value writes the desired state to Cosmos, patches the running container app (rolling a new revision), and records an audit entry. Secret-typed keys (SESSION_SECRET, *_KEY, *CONNECTION*) render as password inputs, never echo their value, and are stored as Azure Container Apps secrets."
              tips={['Secrets are stored as ACA secrets, never shown', 'Save rolls a new revision (brief restart)', 'A bicep-reconcile snippet is shown so the change survives the next deploy']}
              learnMoreHref="https://learn.microsoft.com/azure/container-apps/environment-variables"
            />
          </span>
        </SectionExplainer>
      </div>
      <PowerBiBackendCard />
      <AzureMapsCard />
      <EnvConfigPane />
    </AdminShell>
  );
}
