/**
 * R30 fragment — the 'observability' domain slice of GATE_META (created by V1,
 * loom-next-level ws-verification-dr.md; entries sit in the same domain as
 * their ENV_CHECKS specs in lib/admin/env-checks/observability.ts).
 * Import ONLY from './types' here — never './index' (barrel-cycle rule).
 */
import { L, type GateMeta } from './types';

export const OBSERVABILITY_GATE_META: Record<string, GateMeta> = {
  'svc-synthetic-monitor': {
    surfaces: [
      { path: '/admin/health?tab=journeys', label: 'Health & Reliability hub — Journeys tab' },
      { path: '/api/admin/synthetic-runs', label: 'Synthetic-run summaries route' },
    ],
    // Fix-it: pick the real storage account (ARM-enumerated) + set the container
    // through the shared env-apply write path; the scheduled job itself is
    // deployed by synthetic-monitor-job.bicep (default-ON via observabilityConfig).
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_UAT_RESULTS_ACCOUNT: L.storage },
  },
  'svc-synthetic-login': {
    surfaces: [
      { path: '/admin/health?tab=journeys', label: 'Journeys tab — J1 MSAL login probe' },
    ],
    // Fix-it: a one-time operator action (create the least-privilege automation
    // account + KV secret + Conditional-Access named-location exception) — a
    // wizard-style grant, not a pure env write.
    fixit: {
      kind: 'wizard',
      grantNote: 'Create a least-privilege Entra automation account (member of only the synthetic test workspace), store its password in Key Vault as synthetic-login-secret, wire SYNTHETIC_LOGIN_UPN + SYNTHETIC_LOGIN_SECRET (secretRef) on the loom-synthetic-monitor job, and scope a Conditional-Access named-location exception to the monitor egress. See docs/fiab/runbooks/synthetic-journeys.md.',
    },
    autoResolveNote: 'Unset → J1 (the real MSAL login probe) records an honest SKIP while the minted-session journeys J2–J6 keep monitoring the live app — fully functional detection minus the sign-in-path check.',
  },
  'svc-client-rum': {
    surfaces: [
      { path: '/admin/rum', label: 'Real-user monitoring (admin view)' },
      { path: '/api/telemetry/rum', label: 'Browser beacon ingest (session-gated BFF)' },
    ],
    // Fix-it: plain env writes (enable flag + sample rate; the connection
    // string is auto-wired by the monitoring module on a push-button deploy).
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Default-ON on a push-button deploy (LOOM_RUM_ENABLED=true + the App Insights connection string from the monitoring module). Unset → capture is a SILENT no-op with zero user impact; /admin/rum explains the gate. Instant kill without a roll: the rum1-client-telemetry runtime flag.',
  },
  'svc-alert-action-group': {
    surfaces: [
      { path: '/admin/health?tab=journeys', label: 'Synthetic-failure alerting (shared action group)' },
      { path: '/monitor', label: 'Monitor — Alerts (default action group)' },
    ],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Auto-derived from monitoring-default-alerts.bicep (loom-default-alerts) on every push-button deploy — operators never set it by hand.',
  },
  'svc-alerting': {
    // O1 — optional on-call webhook bridge for the unified dispatchAlert path.
    surfaces: [
      { path: '/monitor', label: 'Monitor — Alerts (severity routing P1 page / P3 email)' },
      { path: '/admin/health', label: 'Health & Reliability hub — alert consumers (journeys, secret health)' },
    ],
    // Fix-it: a one-time operator action (create the Teams-workflow / PagerDuty
    // webhook, store it in KV, flip the bag flag) — a wizard-style grant, not a
    // plain env write (the URL is secret-typed and rides a secretRef).
    fixit: {
      kind: 'wizard',
      grantNote: 'Create the on-call incoming webhook (Teams workflow / PagerDuty Events / bridge), store the URL in Key Vault as loom-alert-webhook-url, and set observabilityConfig.alertWebhookEnabled=true on the admin-plane deploy so LOOM_ALERT_WEBHOOK_URL is wired as a secretRef. P1/P2 then page the webhook; P3 stays email-band. See docs/fiab/runbooks/on-call.md.',
    },
    autoResolveNote: 'Unset → the unified alert path still delivers every severity through the shared action group\'s email + subscription-Owner receivers (fully functional day-one); the webhook only adds the P1/P2 page channel.',
  },
};
