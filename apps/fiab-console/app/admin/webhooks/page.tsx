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
    <AdminShell sectionTitle="Event subscriptions & webhooks">
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
