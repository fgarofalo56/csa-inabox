'use client';

import { AdminShell } from '@/lib/components/admin-shell';
import { WebhooksPanel } from '@/lib/components/admin/webhooks-panel';
import { SectionExplainer, LearnPopover } from '@/lib/components/ui/learn-popover';
import { makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  explainer: { marginBottom: tokens.spacingVerticalL },
});

export default function AdminWebhooksPage() {
  const s = useStyles();
  return (
    <AdminShell
      sectionTitle="Event subscriptions & webhooks"
      learn={{
        title: 'Event subscriptions',
        content:
          'Register outbound webhook endpoints that receive Loom events (item lifecycle, workspace, pipeline runs, marketplace subscribe / SLA breach, admin changes). HMAC-SHA256-signed direct HTTPS by default, or Azure Event Grid when configured.',
        tips: [
          'Verify the X-Loom-Signature HMAC on your receiver',
          'Test-fire before relying on an endpoint; per-hook delivery history (last 100)',
          'Event Grid transport is opt-in via LOOM_EVENTGRID_TOPIC_ENDPOINT',
        ],
        learnMoreHref: 'https://learn.microsoft.com/azure/event-grid/overview',
      }}
    >
      <div className={s.explainer}>
        <SectionExplainer>
          Register outbound webhook endpoints that receive CSA Loom events — item lifecycle (create/update/delete),
          workspace changes, pipeline-run outcomes, marketplace subscribe / SLA-breach, and admin-plane mutations.
          Each delivery is a direct HTTPS POST signed with HMAC-SHA256 (the zero-infra default), or routed through an
          Azure Event Grid custom topic when one is configured. Use “Test” to fire a real signed event and see the
          live delivery receipt.{' '}
          <LearnPopover
            title="Verifying the signature"
            content="Each POST carries X-Loom-Signature: sha256=<hex>, X-Loom-Timestamp (unix seconds), and X-Loom-Event. Recompute HMAC-SHA256(secret, `${timestamp}.${rawBody}`) and constant-time compare with the header. Reject timestamps outside a ~5 minute window to prevent replay."
            tips={['Signature = HMAC-SHA256 over `${timestamp}.${body}`', 'Retries use exponential backoff on 5xx/408/429/network errors', 'The last 100 delivery attempts per hook are retained']}
            learnMoreHref="https://learn.microsoft.com/azure/event-grid/receive-events"
          />
        </SectionExplainer>
      </div>
      <WebhooksPanel />
    </AdminShell>
  );
}
