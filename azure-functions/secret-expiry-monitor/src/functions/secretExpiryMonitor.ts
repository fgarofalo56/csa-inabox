/**
 * secret-expiry-monitor — timer trigger (S1).
 *
 * On SECRET_EXPIRY_CRON (default daily 06:00 UTC) the Function:
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
 * State (last-alerted band per credential) persists in a blob on the
 * Function's own storage account so a daily cron alerts once per escalation,
 * not once per day. Every dependency is a REAL call under the managed
 * identity; missing config → an honest early-exit log (no-vaporware).
 */
import { app, InvocationContext, Timer } from '@azure/functions';
import {
  missingConfig,
  parseTrackedSecrets,
  parseWarnDays,
  mergeInventory,
  alertingItems,
  nextState,
  buildAlertMessage,
  issueTitle,
  type AlertState,
  type GraphPasswordCredential,
  type KvSecretInfo,
} from '../expiry-core';
import {
  readAppCredentials,
  readKvSecretAttributes,
  fireActionGroup,
  readStateBlob,
  writeStateBlob,
  upsertGithubIssue,
} from '../azure-clients';

const CRON = process.env.SECRET_EXPIRY_CRON || '0 0 6 * * *';
const STATE_BLOB = 'secret-expiry-state.json';

export async function secretExpiryMonitor(_timer: Timer, context: InvocationContext): Promise<void> {
  const env = process.env;
  const gates = missingConfig(env);
  if (gates.fatal.length) {
    context.warn(`[secret-expiry] honest-gate: nothing to inventory — set ${gates.fatal.join(', ')}. No-op tick.`);
    return;
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
      context.error(`[secret-expiry] Graph app read failed (grant Application.Read.All per docs/fiab/runbooks/secret-rotation.md): ${e?.message || e}`);
    }
  } else {
    context.warn(`[secret-expiry] honest-gate: ${gates.graph.join(', ')} unset — skipping the app-registration inventory.`);
  }

  // 2. Key Vault — tracked secret attributes.
  let kvSecrets: KvSecretInfo[] = [];
  if (env.LOOM_KEY_VAULT_URI && trackedSecrets.length) {
    try {
      kvSecrets = await readKvSecretAttributes(env.LOOM_KEY_VAULT_URI, trackedSecrets);
    } catch (e: any) {
      context.error(`[secret-expiry] Key Vault read failed: ${e?.message || e}`);
    }
  } else if (!env.LOOM_KEY_VAULT_URI) {
    context.warn(`[secret-expiry] honest-gate: ${gates.keyVault.join(', ')} unset — skipping the vault inventory.`);
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
  context.log(
    `[secret-expiry] inventory=${items.length} (app-creds=${appCreds.length} kv=${kvSecrets.length}) ` +
    `worst=${worst ? `${worst.band}${worst.daysToExpiry !== null ? `:${worst.daysToExpiry}d` : ''}` : 'n/a'}`,
  );

  // 4. Escalation dedup state (blob on the Function's own storage account).
  const stateAccount = env.AzureWebJobsStorage__accountName || '';
  const storageSuffix = env.LOOM_STORAGE_SUFFIX || 'core.windows.net';
  const stateContainer = env.SECRET_EXPIRY_STATE_CONTAINER || 'secret-expiry-state';
  let state: AlertState = {};
  if (stateAccount) {
    try { state = (await readStateBlob(stateAccount, storageSuffix, stateContainer, STATE_BLOB)) as AlertState; }
    catch (e: any) { context.warn(`[secret-expiry] state read failed (alerting without dedup this tick): ${e?.message || e}`); }
  }

  const firing = alertingItems(items, state);
  if (!firing.length) {
    context.log('[secret-expiry] no band escalations — no alert this tick.');
  } else {
    const { subject, body } = buildAlertMessage(firing, warnDays);
    context.warn(`[secret-expiry] ESCALATION: ${subject}`);

    // 4a. Shared action group (O1 convention — LOOM_ALERT_ACTION_GROUP_ID).
    if (env.LOOM_ALERT_ACTION_GROUP_ID) {
      try {
        const out = await fireActionGroup(armEndpoint, env.LOOM_ALERT_ACTION_GROUP_ID, subject);
        context.log(`[secret-expiry] action group fired (status ${out.status}).`);
      } catch (e: any) {
        context.error(`[secret-expiry] action group dispatch failed: ${e?.message || e}`);
      }
    } else {
      context.warn(`[secret-expiry] honest-gate: ${gates.alerting.join(', ')} unset — alert logged only.`);
    }

    // 4b. Dedup GitHub issue per escalated credential (optional, token-gated).
    const ghToken = env.LOOM_SECRET_EXPIRY_GITHUB_TOKEN || '';
    const ghOwner = env.LOOM_GITHUB_REPO_OWNER || 'fgarofalo56';
    const ghRepo = env.LOOM_GITHUB_REPO_NAME || 'csa-inabox';
    if (ghToken) {
      for (const item of firing) {
        try {
          const out = await upsertGithubIssue(ghToken, ghOwner, ghRepo, issueTitle(item), body);
          context.log(`[secret-expiry] GitHub issue ${out.action} (#${out.number}) for ${item.id}.`);
        } catch (e: any) {
          context.error(`[secret-expiry] GitHub issue upsert failed for ${item.id}: ${e?.message || e}`);
        }
      }
    } else {
      context.log('[secret-expiry] LOOM_SECRET_EXPIRY_GITHUB_TOKEN unset — GitHub dedup issue skipped (optional).');
    }
  }

  // 5. Persist the new band state (records every non-ok band; de-escalation
  //    clears the entry so a future regression re-alerts).
  if (stateAccount) {
    try { await writeStateBlob(stateAccount, storageSuffix, stateContainer, STATE_BLOB, nextState(items, nowIso)); }
    catch (e: any) { context.warn(`[secret-expiry] state write failed: ${e?.message || e}`); }
  }
}

app.timer('secretExpiryMonitor', {
  schedule: CRON,
  runOnStartup: false,
  handler: secretExpiryMonitor,
});
