/**
 * notify — failure notifications for the unified scheduler (rel-T81).
 *
 * When a scheduled run FAILS and the schedule has failure-notification enabled,
 * we fan out over the delivery channels the operator configured, reusing the
 * EXISTING Loom notification plumbing:
 *
 *   • in-app  — always: a real Cosmos doc in the `notifications` container keyed
 *               to the schedule owner's oid (the same inbox /api/notifications
 *               reads). This is Loom's first-party notification transport.
 *   • webhook — optional: a real HTTP POST to the configured URL with a compact
 *               JSON payload (runId, status, error). No mock — a genuine fetch.
 *   • email   — optional: relayed via LOOM_SCHEDULER_EMAIL_WEBHOOK when set (an
 *               ACS/Logic-App/SMTP relay endpoint). When that relay isn't
 *               configured we DON'T pretend to send SMTP — the failure still
 *               lands in the owner's Loom inbox and the response notes email
 *               needs a relay (honest, per no-vaporware.md).
 *
 * Best-effort: a delivery failure on any channel is swallowed (logged) so it can
 * never turn a recorded run into a 500.
 */

import crypto from 'node:crypto';
import type { ScheduleDoc, RunDoc } from '@/lib/azure/scheduler-store';

export interface NotifyOutcome {
  inApp: boolean;
  webhook: boolean;
  email: boolean;
  /** Honest note when a requested channel couldn't be delivered as asked. */
  note?: string;
}

export async function notifyFailure(schedule: ScheduleDoc, run: RunDoc): Promise<NotifyOutcome> {
  const out: NotifyOutcome = { inApp: false, webhook: false, email: false };
  const notify = schedule.notify;
  if (!notify?.onFailure) return out;

  const title = `Scheduled job failed: ${schedule.displayName}`;
  const body =
    `The scheduled ${schedule.jobKind} run for "${schedule.itemRef.type}/${schedule.itemRef.id}" failed` +
    `${run.runId ? ` (run ${run.runId})` : ''}. ${run.error || ''}`.trim();

  // 1) In-app inbox notification to the schedule owner (always).
  if (schedule.createdBy) {
    try {
      const { notificationsContainer } = await import('@/lib/azure/cosmos-client');
      const c = await notificationsContainer();
      await c.items.create({
        id: crypto.randomUUID(),
        userId: schedule.createdBy,
        title,
        body,
        severity: 'error',
        link: `/scheduler?schedule=${encodeURIComponent(schedule.id)}`,
        read: false,
        createdAt: new Date().toISOString(),
      });
      out.inApp = true;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[scheduler/notify] in-app delivery failed:', e instanceof Error ? e.message : e);
    }
  }

  // 2) Webhook (real HTTP POST).
  if (notify.webhook) {
    try {
      const res = await fetch(notify.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'loom.scheduler.run.failed',
          scheduleId: schedule.id,
          displayName: schedule.displayName,
          jobKind: schedule.jobKind,
          itemRef: schedule.itemRef,
          runId: run.runId,
          status: run.status,
          error: run.error,
          at: run.finishedAt || new Date().toISOString(),
        }),
      });
      out.webhook = res.ok;
      if (!res.ok) out.note = `webhook returned ${res.status}`;
    } catch (e) {
      out.note = 'webhook POST failed';
      // eslint-disable-next-line no-console
      console.error('[scheduler/notify] webhook delivery failed:', e instanceof Error ? e.message : e);
    }
  }

  // 3) Email via optional relay.
  if (notify.email) {
    const relay = process.env.LOOM_SCHEDULER_EMAIL_WEBHOOK;
    if (relay) {
      try {
        const res = await fetch(relay, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ to: notify.email, subject: title, text: body }),
        });
        out.email = res.ok;
        if (!res.ok) out.note = `email relay returned ${res.status}`;
      } catch (e) {
        out.note = 'email relay POST failed';
        // eslint-disable-next-line no-console
        console.error('[scheduler/notify] email relay failed:', e instanceof Error ? e.message : e);
      }
    } else {
      // Honest: no SMTP/ACS relay configured — the failure still reached the
      // owner's Loom inbox above; we do not fake an email send.
      out.note = 'email relay not configured (set LOOM_SCHEDULER_EMAIL_WEBHOOK); alert delivered to Loom inbox';
    }
  }

  return out;
}
