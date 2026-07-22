/**
 * O1 — unified alert-dispatch (loom-next-level rev-2 alert standard).
 *
 * THE one alerting convention for the whole program: every programmatic alert
 * (S1 secret-expiry, V1 synthetic journeys, and later DR4/C3/A11/CH1/SLO1)
 * routes through `dispatchAlert()` targeting the ONE shared action group —
 * `monitoring-default-alerts.bicep::defaultActionGroup` (`loom-default-alerts`),
 * derived var `LOOM_ALERT_ACTION_GROUP_ID`. No per-item action groups, no
 * parallel Logic Apps; email / ARM-role / webhook are RECEIVERS on the one
 * group.
 *
 * Severity routing (the P1-page vs P3-email convention — the on-call runbook
 * `docs/fiab/runbooks/on-call.md` is the human side of this contract):
 *   P1 — page: ALL receivers (email + subscription-Owner ARM-role + webhook /
 *        Logic App receivers) + a direct POST to LOOM_ALERT_WEBHOOK_URL when
 *        that optional secretRef is wired (the on-call bridge).
 *   P2 — same channel set as P1 (urgent, next-business-hour class).
 *   P3 — email band ONLY: webhook / Logic App receivers are dropped from the
 *        notification and the direct webhook POST is skipped, so informational
 *        alerts never page anyone.
 *
 * Channel honesty (no-vaporware): the action-group leg delivers through the
 * Action Groups `createNotifications` API — the same mechanism the /monitor
 * Alerts editor's Test button uses (monitor-client.sendActionGroupTestNotification)
 * and the S1 Function's fireActionGroup mirrors. That API sends the Common
 * Alert Schema TEST payload to every mirrored receiver; the alert's OWN
 * title/body/source/dedupKey ride the DIRECT webhook leg (full JSON payload)
 * and the optional GitHub dedup-issue helper. Callers that need the text in
 * front of a human durably should pass a dedupKey and use the issue helper
 * (the V1 workflow + S1 Function both do).
 *
 * Never throws: alert dispatch is a best-effort side channel — a failed
 * dispatch must never take down the caller's real work. Every leg reports
 * per-leg {ok|skipped|error} in the structured result.
 *
 * Sovereign-cloud aware: ARM host/scope from cloud-endpoints (Commercial /
 * GCC-High `.us` / IL5). IL5: keep LOOM_ALERT_WEBHOOK_URL unset (in-tenant
 * sinks only, per the V1 IL5 note) — the action-group leg is fully in-boundary.
 */
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { armBase, armScope } from './cloud-endpoints';

export type AlertSeverity = 'P1' | 'P2' | 'P3';

export interface AlertInput {
  /** Emitting subsystem — 'secret-expiry' | 'synthetic-monitor' | 'dr-drill' | … */
  source: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  /** Stable key for downstream dedup (GitHub issue title, webhook consumers).
   * Convention: '<source>:<stable-slug>' (e.g. 'synthetic-monitor:J1'). */
  dedupKey?: string;
}

export interface AlertLegResult {
  /** 'sent' — delivered; 'skipped' — intentionally not attempted (unconfigured
   * or severity-routed away); 'error' — attempted and failed (message in detail). */
  status: 'sent' | 'skipped' | 'error';
  detail?: string;
  httpStatus?: number;
}

export interface AlertDispatchResult {
  /** True when at least one configured leg delivered. */
  ok: boolean;
  severity: AlertSeverity;
  actionGroup: AlertLegResult;
  webhook: AlertLegResult;
  /** Receiver counts mirrored into the action-group notification (post-routing). */
  receivers?: { emails: number; armRoles: number; webhooks: number; logicApps: number };
}

/** Injectable seams so the unit tests exercise the REAL routing/payload logic
 * against a mock fetch/token — no live ARM in vitest. */
export interface AlertDispatchDeps {
  fetchImpl?: typeof fetch;
  getToken?: (scope: string) => Promise<string>;
  env?: Record<string, string | undefined>;
}

const ACTION_GROUPS_API = '2023-01-01';

// Same credential chain as monitor-client (ACA MSI quirk → UAMI → default).
let cachedCredential: { getToken(scope: string): Promise<{ token?: string } | null> } | null = null;
function credential() {
  if (!cachedCredential) {
    const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
    cachedCredential = uamiClientId
      ? new ChainedTokenCredential(
          new AcaManagedIdentityCredential(),
          new ManagedIdentityCredential({ clientId: uamiClientId }),
          new DefaultAzureCredential(),
        )
      : new DefaultAzureCredential();
  }
  return cachedCredential;
}

async function defaultGetToken(scope: string): Promise<string> {
  const t = await credential().getToken(scope);
  if (!t?.token) throw new Error(`failed to acquire token for ${scope}`);
  return t.token;
}

/** Parse an action-group ARM id → {sub, rg, name}; null when malformed. */
export function parseActionGroupId(
  id: string | undefined,
): { sub: string; rg: string; name: string } | null {
  const m = /\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/[Mm]icrosoft\.[Ii]nsights\/actionGroups\/([^/?]+)/.exec(
    id || '',
  );
  return m ? { sub: m[1], rg: m[2], name: m[3] } : null;
}

interface ActionGroupProps {
  emailReceivers?: unknown[];
  smsReceivers?: unknown[];
  webhookReceivers?: Array<{ name?: string; serviceUri?: string }>;
  logicAppReceivers?: unknown[];
  armRoleReceivers?: unknown[];
}

/**
 * PURE severity routing — mirrors the group's live receivers into the
 * createNotifications body per the P1-page / P3-email convention, appending
 * the direct on-call webhook (LOOM_ALERT_WEBHOOK_URL) as an extra receiver on
 * P1/P2 when it is not already a receiver on the group.
 */
export function receiversForSeverity(
  props: ActionGroupProps,
  severity: AlertSeverity,
  directWebhookUrl?: string,
): {
  emailReceivers: unknown[];
  smsReceivers: unknown[];
  webhookReceivers: Array<{ name?: string; serviceUri?: string }>;
  logicAppReceivers: unknown[];
  armRoleReceivers: unknown[];
} {
  const emailReceivers = props.emailReceivers || [];
  const smsReceivers = props.smsReceivers || [];
  const armRoleReceivers = props.armRoleReceivers || [];
  if (severity === 'P3') {
    // Email band: informational — never page the webhook / Logic App bridge.
    return { emailReceivers, smsReceivers, webhookReceivers: [], logicAppReceivers: [], armRoleReceivers };
  }
  const webhookReceivers = [...(props.webhookReceivers || [])];
  if (
    directWebhookUrl &&
    !webhookReceivers.some((w) => (w?.serviceUri || '').trim() === directWebhookUrl.trim())
  ) {
    webhookReceivers.push({
      name: 'oncall-webhook',
      serviceUri: directWebhookUrl,
      // Common Alert Schema so Teams-workflow / PagerDuty / bridge consumers
      // get the same shape a fired Azure Monitor alert delivers.
      ...( { useCommonAlertSchema: true } as object),
    });
  }
  return {
    emailReceivers,
    smsReceivers,
    webhookReceivers,
    logicAppReceivers: props.logicAppReceivers || [],
    armRoleReceivers,
  };
}

/** PURE — the direct-webhook JSON body (the leg that carries the alert's own
 * text; the action-group leg is schema-fixed by createNotifications). */
export function webhookPayload(input: AlertInput): Record<string, unknown> {
  return {
    schema: 'loom-alert/v1',
    source: input.source,
    severity: input.severity,
    title: input.title,
    body: input.body,
    dedupKey: input.dedupKey || null,
    firedAt: new Date().toISOString(),
  };
}

/** PURE — the dedup GitHub-issue title convention ('<dedupKey>' wins so an
 * open issue is commented, never duplicated). */
export function dedupIssueTitle(input: Pick<AlertInput, 'source' | 'severity' | 'title' | 'dedupKey'>): string {
  return input.dedupKey
    ? `[${input.severity}] ${input.dedupKey}`
    : `[${input.severity}] ${input.source}: ${input.title}`;
}

/**
 * Dispatch one alert through the unified convention. Never throws.
 */
export async function dispatchAlert(
  input: AlertInput,
  deps: AlertDispatchDeps = {},
): Promise<AlertDispatchResult> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? ((url: any, init?: any) => fetchWithTimeout(url, init));
  const getToken = deps.getToken ?? defaultGetToken;

  const result: AlertDispatchResult = {
    ok: false,
    severity: input.severity,
    actionGroup: { status: 'skipped', detail: 'LOOM_ALERT_ACTION_GROUP_ID unset (svc-alert-action-group gate)' },
    webhook: { status: 'skipped', detail: 'LOOM_ALERT_WEBHOOK_URL unset (optional on-call bridge — svc-alerting)' },
  };

  // ── Leg 1: the ONE shared action group (createNotifications, receiver-mirrored). ──
  const agId = (env.LOOM_ALERT_ACTION_GROUP_ID || '').trim();
  const parsed = parseActionGroupId(agId);
  const directWebhookUrl = (env.LOOM_ALERT_WEBHOOK_URL || '').trim() || undefined;
  if (agId && !parsed) {
    result.actionGroup = { status: 'error', detail: 'LOOM_ALERT_ACTION_GROUP_ID is not a valid action-group ARM id' };
  } else if (parsed) {
    try {
      const arm = armBase();
      const token = await getToken(armScope());
      const base = `${arm}/subscriptions/${parsed.sub}/resourceGroups/${parsed.rg}/providers/Microsoft.Insights/actionGroups/${parsed.name}`;
      const agRes = await fetchImpl(`${base}?api-version=${ACTION_GROUPS_API}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        cache: 'no-store',
      } as RequestInit);
      if (!agRes.ok) {
        throw new Error(`action group read ${agRes.status}: ${(await agRes.text()).slice(0, 200)}`);
      }
      const props = ((await agRes.json()) as any)?.properties || {};
      const receivers = receiversForSeverity(props, input.severity, directWebhookUrl);
      result.receivers = {
        emails: receivers.emailReceivers.length,
        armRoles: receivers.armRoleReceivers.length,
        webhooks: receivers.webhookReceivers.length,
        logicApps: receivers.logicAppReceivers.length,
      };
      const res = await fetchImpl(`${base}/createNotifications?api-version=${ACTION_GROUPS_API}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ alertType: 'logalertv2', ...receivers }),
        cache: 'no-store',
      } as RequestInit);
      if (!res.ok && res.status !== 202) {
        throw new Error(`createNotifications ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      result.actionGroup = { status: 'sent', httpStatus: res.status };
    } catch (e: any) {
      result.actionGroup = { status: 'error', detail: e?.message || String(e) };
    }
  }

  // ── Leg 2: direct on-call webhook (P1/P2 only — P3 is the email band). ──
  if (directWebhookUrl) {
    if (input.severity === 'P3') {
      result.webhook = { status: 'skipped', detail: 'P3 routes to the email band only (severity convention)' };
    } else {
      try {
        const res = await fetchImpl(directWebhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(webhookPayload(input)),
          cache: 'no-store',
        } as RequestInit);
        if (!res.ok && res.status !== 202) {
          throw new Error(`webhook POST ${res.status}`);
        }
        result.webhook = { status: 'sent', httpStatus: res.status };
      } catch (e: any) {
        result.webhook = { status: 'error', detail: e?.message || String(e) };
      }
    }
  }

  result.ok = result.actionGroup.status === 'sent' || result.webhook.status === 'sent';
  return result;
}

// ── Optional dedup GitHub-issue helper ──────────────────────────────────────
// Durable text channel for callers that hold a GitHub token (the S1 Function
// via LOOM_SECRET_EXPIRY_GITHUB_TOKEN; workflows use github-script natively —
// the V1 workflow's dedup step follows the SAME open-issue-else-comment
// convention). Token is an EXPLICIT argument — this module reads no GitHub
// env of its own. IL5: skip (no api.github.com in-enclave); write to the
// in-boundary store instead (see the on-call runbook).

export interface DedupIssueInput {
  token: string;
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels?: string[];
}

export async function upsertDedupIssue(
  input: DedupIssueInput,
  deps: Pick<AlertDispatchDeps, 'fetchImpl'> = {},
): Promise<{ action: 'created' | 'commented' | 'error'; number?: number; detail?: string }> {
  const fetchImpl = deps.fetchImpl ?? ((url: any, init?: any) => fetchWithTimeout(url, init));
  const GH = 'https://api.github.com';
  const headers = {
    authorization: `Bearer ${input.token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'csa-loom-alert-dispatch',
    'x-github-api-version': '2022-11-28',
  };
  try {
    const q = encodeURIComponent(`repo:${input.owner}/${input.repo} state:open in:title "${input.title}"`);
    const search = await fetchImpl(`${GH}/search/issues?q=${q}`, { headers } as RequestInit);
    if (!search.ok) throw new Error(`GitHub search ${search.status}`);
    const found: any = await search.json();
    const existing = (found?.items || []).find((i: any) => i?.title === input.title);
    if (existing) {
      const res = await fetchImpl(`${GH}/repos/${input.owner}/${input.repo}/issues/${existing.number}/comments`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ body: input.body }),
      } as RequestInit);
      if (!res.ok) throw new Error(`GitHub comment ${res.status}`);
      return { action: 'commented', number: existing.number };
    }
    const res = await fetchImpl(`${GH}/repos/${input.owner}/${input.repo}/issues`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ title: input.title, body: input.body, labels: input.labels || [] }),
    } as RequestInit);
    if (!res.ok) throw new Error(`GitHub issue create ${res.status}`);
    const j: any = await res.json();
    return { action: 'created', number: j?.number || 0 };
  } catch (e: any) {
    return { action: 'error', detail: e?.message || String(e) };
  }
}
