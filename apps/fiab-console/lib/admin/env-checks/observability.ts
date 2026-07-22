/**
 * R30 fragment — the 'observability' domain slice of ENV_CHECKS (created by V1,
 * loom-next-level ws-verification-dr.md — synthetic user-journey monitoring).
 * Future observability items (V5 bicep-drift, O1 alert-dispatch, RUM1) add
 * their specs HERE, not to a monolith. Import ONLY from './core' — never
 * './index' (barrel-cycle rule, WS-E1 gotcha).
 */
import type { EnvSpec } from './core';

export const OBSERVABILITY_ENV_CHECKS: EnvSpec[] = [
  {
    // V1 — the scheduled in-VNet synthetic-journey monitor (loom-synthetic-monitor
    // ACA job) + the Health & Reliability hub's Journeys tab. The tab + the
    // /api/admin/synthetic-runs route read run artifacts from Blob; without the
    // results account/container they honest-gate (503) with this spec's Fix-it.
    id: 'svc-synthetic-monitor', category: 'observability',
    title: 'Synthetic journey monitor — results store (Blob)', severity: 'optional',
    required: ['LOOM_SYNTHETIC_MONITOR_ENABLED', 'LOOM_UAT_RESULTS_ACCOUNT', 'LOOM_UAT_RESULTS_CONTAINER'],
    warnOnMiss: true,
    remediation: 'Set LOOM_UAT_RESULTS_ACCOUNT (the storage account the in-VNet UAT/synthetic runners upload run artifacts to — the DLZ ADLS account on a push-button deploy) + LOOM_UAT_RESULTS_CONTAINER (default uat-results) + LOOM_SYNTHETIC_MONITOR_ENABLED=true so the Health & Reliability hub\'s Journeys tab can list the last synthetic-journey runs (verdicts + screenshots). The scheduled loom-synthetic-monitor Container App Job is deployed by modules/admin-plane/synthetic-monitor-job.bicep (enable flag rides the observabilityConfig bag, default-ON). The Console UAMI needs Storage Blob Data Reader on the account (it already holds Contributor on the DLZ account).',
    provisionedBy: 'modules/admin-plane/synthetic-monitor-job.bicep (scheduled Microsoft.App/jobs) + modules/admin-plane/main.bicep (observabilityConfig bag → apps[] env LOOM_UAT_RESULTS_ACCOUNT / LOOM_UAT_RESULTS_CONTAINER / LOOM_SYNTHETIC_MONITOR_ENABLED)',
    role: 'Storage Blob Data Contributor (Console UAMI) on the results storage account',
    docs: 'docs/fiab/runbooks/synthetic-journeys.md',
    availability: { commercial: 'ga', gccHigh: 'ga', il5: 'ga' },
  },
  {
    // V1 — the TRUE MSAL login-path probe credential (J1). A standing,
    // sign-in-capable automation account (least-privilege; KV-stored secret).
    // ABSENCE IS AN HONEST SKIP, not a gap (optionalDefault): the minted-session
    // journeys J2–J6 still monitor the app end-to-end; only the real
    // Entra-authorize → /auth/callback probe is skipped, and the Journeys tab
    // reports J1 as 'skip' with this exact reason.
    id: 'svc-synthetic-login', category: 'identity',
    title: 'Synthetic MSAL login probe — automation credential', severity: 'optional',
    required: ['SYNTHETIC_LOGIN_UPN', 'SYNTHETIC_LOGIN_SECRET'],
    warnOnMiss: true, optionalDefault: true,
    optionalDefaultDetail: 'the minted-session synthetic journeys (J2–J6) monitor the live app with zero config; the TRUE MSAL login-path probe (J1 — the check that catches the 2026-07-19 AADSTS7000215 secret-drift class while minted-session verify stays green) records an honest SKIP until an automation credential is wired.',
    remediation: 'Create a least-privilege Entra automation account (member of nothing beyond the one Loom synthetic test workspace), store its password in Key Vault as synthetic-login-secret, and set SYNTHETIC_LOGIN_UPN + SYNTHETIC_LOGIN_SECRET (secretRef) on the loom-synthetic-monitor job so J1 drives the REAL /auth/sign-in → Entra authorize → /auth/callback flow every 15 minutes. Scope a Conditional-Access named-location exception to the monitor\'s egress IP (never a blanket MFA carve-out), and add an Entra sign-in alert for any client other than the monitor (unexpected-use detection). Rotation is tracked by WS-S (S1).',
    provisionedBy: 'operator one-time (Entra automation account) + kv-loom-* secret synthetic-login-secret → modules/admin-plane/synthetic-monitor-job.bicep secretRef',
    role: 'none beyond membership of the synthetic test workspace (least-privilege account); Conditional-Access named-location exception for the monitor egress',
    docs: 'docs/fiab/runbooks/synthetic-journeys.md',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'limited',
      fallbackNote: 'IL5/air-gapped: the login probe signs in against the sovereign Entra authority from the in-enclave runner; if non-interactive password auth is prohibited by policy, run minted-session journeys only (J1 skips honestly).',
    },
  },
  {
    // The ONE shared derived alert var (rev-2 alert standard) — the ARM id of
    // monitoring-default-alerts.bicep's defaultActionGroup (loom-default-alerts).
    // Consumed by every alert emitter through O1's lib/azure/alert-dispatch.ts
    // (dispatchAlert — S1 secret-expiry, V1 synthetic journeys, later DR4/C3/A11).
    // Bicep derives it on every push-button deploy; operators never hand-set it.
    id: 'svc-alert-action-group', category: 'observability',
    title: 'Shared alert action group (LOOM_ALERT_ACTION_GROUP_ID)', severity: 'optional',
    required: ['LOOM_ALERT_ACTION_GROUP_ID'],
    warnOnMiss: true, derived: true,
    remediation: 'Auto-derived from modules/admin-plane/monitoring-default-alerts.bicep (defaultActionGroup loom-default-alerts) on a push-button deploy. If unset, redeploy the admin plane (or set it to the action group\'s ARM resource id) so every alert routed through lib/azure/alert-dispatch.ts (dispatchAlert — synthetic journeys, secret expiry, DR drills, cost anomaly) notifies through the ONE shared action group (admin email + subscription-Owner ARM-role receivers).',
    provisionedBy: 'modules/admin-plane/monitoring-default-alerts.bicep (defaultActionGroup output) → admin-plane/main.bicep apps[] env LOOM_ALERT_ACTION_GROUP_ID (derived)',
    availability: { commercial: 'ga', gccHigh: 'ga', il5: 'ga' },
  },
  {
    // O1 — the OPTIONAL on-call webhook bridge (Teams workflow / PagerDuty /
    // bridge URL, KV secretRef). Absence is the fully-functional day-one
    // default: dispatchAlert still delivers P1/P2/P3 through the shared action
    // group's email + subscription-Owner ARM-role receivers (the channels that
    // exist on every push-button deploy). When set, P1/P2 additionally page the
    // webhook (P3 stays email-band per the severity convention) — see
    // docs/fiab/runbooks/on-call.md. NOTE: LOOM_ALERT_ACTION_GROUP_ID is owned
    // by svc-alert-action-group above (dedupe — never double-counted here).
    id: 'svc-alerting', category: 'observability',
    title: 'Unified alert dispatch — on-call webhook (optional)', severity: 'optional',
    required: ['LOOM_ALERT_WEBHOOK_URL'],
    warnOnMiss: true, optionalDefault: true,
    optionalDefaultDetail: 'the unified alert path (lib/azure/alert-dispatch.ts → the shared loom-default-alerts action group) delivers every P1/P2/P3 via the email + subscription-Owner ARM-role receivers with zero config; the webhook is an optional page/bridge channel layered on top for P1/P2.',
    remediation: 'Optional on-call paging bridge: store the incoming-webhook URL (Teams workflow, PagerDuty Events, or bridge endpoint) in Key Vault as loom-alert-webhook-url, then set observabilityConfig.alertWebhookEnabled=true (admin-plane bag) so the Console reads LOOM_ALERT_WEBHOOK_URL via secretRef. dispatchAlert then pages the webhook on P1/P2 (P3 remains email-only) and mirrors it into the shared loom-default-alerts action-group notification. To persist the receiver ON the action group for the default LogAlert rules too, pass alertWebhookUrl to monitoring-default-alerts.bicep (secure param) or add it once via the /monitor Alerts editor. Escalation + ack: docs/fiab/runbooks/on-call.md.',
    provisionedBy: 'operator one-time (KV secret loom-alert-webhook-url) + modules/admin-plane/main.bicep observabilityConfig.alertWebhookEnabled → LOOM_ALERT_WEBHOOK_URL secretRef; receiver param on modules/admin-plane/monitoring-default-alerts.bicep',
    role: 'Monitoring Contributor (Console UAMI) on the alert RG — already granted for the /monitor Alerts editor',
    docs: 'docs/fiab/runbooks/on-call.md',
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'limited',
      fallbackNote: 'IL5/air-gapped: external webhook egress is prohibited — keep LOOM_ALERT_WEBHOOK_URL unset; alerting stays fully in-boundary on the action group\'s email/ARM-role receivers (an in-enclave bridge URL may be used where policy allows).',
    },
  },
];
