/**
 * secret-expiry-monitor — the S1 monitor pass (one-shot, ACA-job hosted).
 *
 * On each scheduled execution (SECRET_EXPIRY_CRON, default daily 06:00 UTC) it:
 *   1. reads the Console MSAL app registration's passwordCredentials[] via
 *      Microsoft Graph (/applications(appId='…') — Application.Read.All),
 *   2. reads attributes (exp / updated) for every tracked Key Vault secret
 *      (LOOM_SECRET_EXPIRY_KV_SECRETS — incl. loom-msal-client-secret and
 *      synthetic-login-secret),
 *   3. computes days-to-expiry + the 60/30/7-day band per credential and
 *      detects MSAL KV DRIFT (app credential newer than the vault copy — the
 *      2026-07-19 sign-in-outage mode),
 *   4. on band ESCALATION fires the shared loom-default-alerts action group
 *      (LOOM_ALERT_ACTION_GROUP_ID, O1 convention) and opens/updates a dedup
 *      GitHub issue per credential (optional, token-gated).
 *
 * State (last-alerted band per credential) persists as a blob on the Loom
 * storage account (LOOM_OPS_STATE_ACCOUNT / LOOM_OPS_STATE_CONTAINER, the
 * bicep-created `ops-state` container) so a daily cron alerts once per
 * escalation, not once per day. Every dependency is a REAL call under the
 * console UAMI; missing config → an honest early-exit log (no-vaporware).
 *
 * B-FN migration (2026-07-27): this body is the former timer-Function handler,
 * unchanged apart from (a) the logger interface and (b) the state-blob account
 * env (the Y1 host storage `AzureWebJobsStorage__accountName` no longer exists —
 * the job runs as the console UAMI against the Loom storage account, which
 * already holds the UAMI's Storage Blob Data Contributor grant).
 */
import {
  missingConfig,
  parseTrackedSecrets,
  parseWarnDays,
  mergeInventory,
  alertingItems,
  nextState,
  buildAlertMessage,
  severityForBand,
  issueTitle,
  type AlertState,
  type GraphPasswordCredential,
  type KvSecretInfo,
} from './expiry-core';
import {
  readAppCredentials,
  readKvSecretAttributes,
  fireActionGroup,
  readStateBlob,
  writeStateBlob,
  upsertGithubIssue,
} from './azure-clients';
import type { RunLogger } from './run-logger';

const STATE_BLOB = 'secret-expiry-state.json';

export interface MonitorSummary {
  /** false = the honest early-exit gate fired (nothing to inventory). */
  ran: boolean;
  /** Credentials + tracked secrets inventoried this pass. */
  inventory: number;
  /** Credentials whose band ESCALATED this pass (an alert was attempted). */
  escalated: number;
  /** Worst band seen, e.g. `warn30:22d`. */
  worst: string;
  /** Set when `ran` is false — the config keys that must be supplied. */
  gate?: string;
}

/**
 * Run one monitor pass. Never throws for an expected/honest gate — a missing
 * Graph consent or an unset action group is logged and the pass continues, so
 * a Failed job execution always means a REAL regression.
 */
export async function runSecretExpiryMonitor(log: RunLogger): Promise<MonitorSummary> {
  const env = process.env;
  const gates = missingConfig(env);
  if (gates.fatal.length) {
    const gate = gates.fatal.join(', ');
    log.warn(`[secret-expiry] honest-gate: nothing to inventory — set ${gate}. No-op tick.`);
    return { ran: false, inventory: 0, escalated: 0, worst: 'n/a', gate };
  }

  const warnDays = parseWarnDays(env.LOOM_SECRET_EXPIRY_WARN_DAYS);
  const trackedSecrets = parseTrackedSecrets(
    env.LOOM_SECRET_EXPIRY_KV_SECRETS || 'loom-msal-client-secret,synthetic-login-secret',
  );
  const graphBase = env.LOOM_GRAPH_BASE || 'https://graph.microsoft.com';
  const armEndpoint = env.LOOM_ARM_ENDPOINT || 'https://management.azure.com';
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // 1. Graph — the MSAL app's password credentials (the 2-year clock).
  let appCreds: GraphPasswordCredential[] = [];
  let appDisplayName = '';
  if (env.LOOM_MSAL_CLIENT_ID) {
    try {
      const read = await readAppCredentials(graphBase, env.LOOM_MSAL_CLIENT_ID);
      appCreds = read.passwordCredentials;
      appDisplayName = read.displayName;
    } catch (e: any) {
      // 403 = the one-time Application.Read.All admin consent has not been run.
      log.error(`[secret-expiry] Graph app read failed (grant Application.Read.All per docs/fiab/runbooks/secret-rotation.md): ${e?.message || e}`);
    }
  } else {
    log.warn(`[secret-expiry] honest-gate: ${gates.graph.join(', ')} unset — skipping the app-registration inventory.`);
  }

  // 2. Key Vault — tracked secret attributes.
  let kvSecrets: KvSecretInfo[] = [];
  if (env.LOOM_KEY_VAULT_URI && trackedSecrets.length) {
    try {
      kvSecrets = await readKvSecretAttributes(env.LOOM_KEY_VAULT_URI, trackedSecrets);
    } catch (e: any) {
      log.error(`[secret-expiry] Key Vault read failed: ${e?.message || e}`);
    }
  } else if (!env.LOOM_KEY_VAULT_URI) {
    log.warn(`[secret-expiry] honest-gate: ${gates.keyVault.join(', ')} unset — skipping the vault inventory.`);
  }

  // 3. Merge + band.
  const items = mergeInventory({
    appId: env.LOOM_MSAL_CLIENT_ID,
    appDisplayName,
    appCreds,
    kvSecrets,
    nowMs,
    warnDays,
    msalKvSecretName: 'loom-msal-client-secret',
  });
  const worst = items[0];
  const worstLabel = worst ? `${worst.band}${worst.daysToExpiry !== null ? `:${worst.daysToExpiry}d` : ''}` : 'n/a';
  log.log(
    `[secret-expiry] inventory=${items.length} (app-creds=${appCreds.length} kv=${kvSecrets.length}) worst=${worstLabel}`,
  );

  // 4. Escalation dedup state (blob on the Loom storage account's ops-state
  //    container — the Y1 host storage account is gone with the Function).
  const stateAccount = env.LOOM_OPS_STATE_ACCOUNT || '';
  const storageSuffix = env.LOOM_STORAGE_SUFFIX || 'core.windows.net';
  const stateContainer = env.LOOM_OPS_STATE_CONTAINER || 'ops-state';
  let state: AlertState = {};
  if (stateAccount) {
    try { state = (await readStateBlob(stateAccount, storageSuffix, stateContainer, STATE_BLOB)) as AlertState; }
    catch (e: any) { log.warn(`[secret-expiry] state read failed (alerting without dedup this tick): ${e?.message || e}`); }
  } else {
    log.warn('[secret-expiry] LOOM_OPS_STATE_ACCOUNT unset — escalation dedup disabled for this tick (every non-ok band re-alerts).');
  }

  const firing = alertingItems(items, state);
  if (!firing.length) {
    log.log('[secret-expiry] no band escalations — no alert this tick.');
  } else {
    const { subject, body } = buildAlertMessage(firing, warnDays);
    // O1 severity routing: worst escalated band decides the P-band (firing is
    // sorted worst-first by mergeInventory order) — expired/critical page (P1),
    // warn30 urgent (P2), warn60 email-band (P3). docs/fiab/runbooks/on-call.md.
    const severity = severityForBand(firing[0].band);
    log.warn(`[secret-expiry] ESCALATION (${severity}): ${subject}`);

    // 4a. Shared action group (O1 convention — LOOM_ALERT_ACTION_GROUP_ID).
    if (env.LOOM_ALERT_ACTION_GROUP_ID) {
      try {
        const out = await fireActionGroup(armEndpoint, env.LOOM_ALERT_ACTION_GROUP_ID, subject, severity);
        log.log(`[secret-expiry] action group fired (${severity}, status ${out.status}).`);
      } catch (e: any) {
        log.error(`[secret-expiry] action group dispatch failed: ${e?.message || e}`);
      }
    } else {
      log.warn(`[secret-expiry] honest-gate: ${gates.alerting.join(', ')} unset — alert logged only.`);
    }

    // 4b. Dedup GitHub issue per escalated credential (optional, token-gated).
    const ghToken = env.LOOM_SECRET_EXPIRY_GITHUB_TOKEN || '';
    const ghOwner = env.LOOM_GITHUB_REPO_OWNER || 'fgarofalo56';
    const ghRepo = env.LOOM_GITHUB_REPO_NAME || 'csa-inabox';
    if (ghToken) {
      for (const item of firing) {
        try {
          const out = await upsertGithubIssue(ghToken, ghOwner, ghRepo, issueTitle(item), body);
          log.log(`[secret-expiry] GitHub issue ${out.action} (#${out.number}) for ${item.id}.`);
        } catch (e: any) {
          log.error(`[secret-expiry] GitHub issue upsert failed for ${item.id}: ${e?.message || e}`);
        }
      }
    } else {
      log.log('[secret-expiry] LOOM_SECRET_EXPIRY_GITHUB_TOKEN unset — GitHub dedup issue skipped (optional).');
    }
  }

  // 5. Persist the new band state (records every non-ok band; de-escalation
  //    clears the entry so a future regression re-alerts).
  if (stateAccount) {
    try { await writeStateBlob(stateAccount, storageSuffix, stateContainer, STATE_BLOB, nextState(items, nowIso)); }
    catch (e: any) { log.warn(`[secret-expiry] state write failed: ${e?.message || e}`); }
  }

  return { ran: true, inventory: items.length, escalated: firing.length, worst: worstLabel };
}
