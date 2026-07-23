'use client';

import { AdminShell } from '@/lib/components/admin-shell';
import { DiagnosticsPane } from '@/lib/components/admin/diagnostics-pane';
import { SectionExplainer } from '@/lib/components/ui/learn-popover';
import { makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  explainer: { marginBottom: tokens.spacingVerticalL },
});

export default function AdminDiagnosticsPage() {
  const s = useStyles();
  return (
    <AdminShell
      sectionTitle="Diagnostics"
      learn={{
        title: 'Diagnostics & support bundle',
        content:
          'One-click incident triage. Export a single JSON that captures the deployment posture at a moment in time: the running version + ACA revision, the full gate-registry state, the masked env posture, live dependency probes, the last synthetic-journey run, and the most recent audit rows. Env values are masked at source (secrets become ***) and the whole bundle is run through a secret scrubber, so it is safe to attach to an incident ticket or share with support.',
        tips: [
          'Export the bundle FIRST when opening an incident — it snapshots posture before anything is changed.',
          'The bundle carries ZERO secrets: env secrets are masked and every field is secret-scrubbed server-side.',
          'The gate summary tells you at a glance what is blocked vs cloud-unavailable — the first thing support asks.',
          'The live probes prove whether the core dependencies (Cosmos) are reachable from this replica right now.',
        ],
        learnMoreHref: 'https://learn.microsoft.com/azure/azure-monitor/overview',
      }}
    >
      <div className={s.explainer}>
        <SectionExplainer>
          A support bundle is a point-in-time, secret-scrubbed snapshot of the deployment&apos;s posture —
          version, gate states, masked env, live probes, last synthetic run, and recent audit rows — in one
          downloadable JSON. Export it when triaging an incident so support has the whole picture without a
          screen-share, and without any risk of leaking a token or connection string.
        </SectionExplainer>
      </div>
      <DiagnosticsPane />
    </AdminShell>
  );
}
