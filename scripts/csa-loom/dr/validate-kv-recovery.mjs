#!/usr/bin/env node
// scripts/csa-loom/dr/validate-kv-recovery.mjs — DR3 (loom-next-level WS-DR)
//
// Deepens the existing `keyvault-restore` scenario of
// .github/workflows/dr-drill.yml from an echo-stub into a real recovery drill
// against the LIVE admin-plane vault (kv-loom-*, soft delete 90d + purge
// protection per keyvault.bicep). Two namespaced canaries, swept naming:
//
//   posture  — live ARM: enableSoftDelete, softDeleteRetentionInDays >= 7,
//              enablePurgeProtection all asserted.
//   recover  — canary-1 `drdrill-canary-<id>`: set (random value) → delete →
//              appears in list-deleted with a scheduledPurgeDate → recover →
//              readable again → value byte-for-byte equals the original.
//              Recovery duration recorded as RTO evidence (DR.md target <15m).
//   purge    — canary-2 `drdrill-purge-<id>`: set → delete → `az keyvault
//              secret purge` MUST be REJECTED (purge protection). The expected
//              error is captured in the report. Canary-2 stays soft-deleted
//              (harmless; auto-purges at the end of the retention window).
//
// Auth: az CLI context; the drill SP needs Key Vault Secrets Officer (RBAC
// vault) — see docs/runbooks/dr-drill.md §3. The workflow opens a single-IP
// firewall window first and re-locks in always().
//
// Env: DRILL_ID, DRILL_CLOUD, DR_REPORT_DIR, VAULT_NAME (required),
//      VAULT_SUB (optional)
//
// Exit 0 only when every check passes. Always writes the report JSON.

import { az, azJson, drillEnv, makeReport, poll } from './_drill-lib.mjs';
import { randomBytes } from 'node:crypto';

const { drillId, cloud } = drillEnv();
const report = makeReport({ scenario: 'keyvault-restore', drillId, cloud });

const VAULT = process.env.VAULT_NAME;
const SUB_ARGS = process.env.VAULT_SUB ? ['--subscription', process.env.VAULT_SUB] : [];
if (!VAULT) {
  console.error('VAULT_NAME is required');
  process.exit(2);
}

const safeId = drillId.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
const CANARY = `drdrill-canary-${safeId}`;
const PURGE_CANARY = `drdrill-purge-${safeId}`;

const main = async () => {
  // ---- posture -------------------------------------------------------------
  await report.check('posture: soft delete + purge protection ON', async () => {
    const kv = azJson(['keyvault', 'show', '-n', VAULT, ...SUB_ARGS]);
    const p = kv.properties;
    if (p.enableSoftDelete !== true) throw new Error('enableSoftDelete != true');
    if (!(p.softDeleteRetentionInDays >= 7)) throw new Error(`softDeleteRetentionInDays=${p.softDeleteRetentionInDays}`);
    if (p.enablePurgeProtection !== true) throw new Error('enablePurgeProtection != true');
    return `retention=${p.softDeleteRetentionInDays}d, purgeProtection=on`;
  });

  // ---- canary-1: delete → recover, value intact ----------------------------
  const secretValue = randomBytes(24).toString('base64url');
  await report.check('drill: set + delete canary secret', async () => {
    az(['keyvault', 'secret', 'set', '--vault-name', VAULT, '--name', CANARY, '--value', secretValue, ...SUB_ARGS]);
    az(['keyvault', 'secret', 'delete', '--vault-name', VAULT, '--name', CANARY, ...SUB_ARGS]);
    return CANARY;
  });

  await report.check('drill: canary listed as soft-deleted with scheduledPurgeDate', async () => {
    const deleted = await poll(`deleted secret ${CANARY}`, async () => {
      try {
        return azJson(['keyvault', 'secret', 'show-deleted', '--vault-name', VAULT, '--name', CANARY, ...SUB_ARGS], { allowFail: true });
      } catch { return null; }
    }, { timeoutMs: 180_000, intervalMs: 10_000 });
    if (!deleted.scheduledPurgeDate) throw new Error('no scheduledPurgeDate on deleted secret');
    return `scheduledPurgeDate=${deleted.scheduledPurgeDate}`;
  });

  const recoverT0 = Date.now();
  await report.check('drill: recover canary → value byte-for-byte intact', async () => {
    az(['keyvault', 'secret', 'recover', '--vault-name', VAULT, '--name', CANARY, ...SUB_ARGS]);
    const recovered = await poll(`recovered secret ${CANARY} readable`, async () => {
      try {
        return azJson(['keyvault', 'secret', 'show', '--vault-name', VAULT, '--name', CANARY, ...SUB_ARGS], { allowFail: true });
      } catch { return null; }
    }, { timeoutMs: 180_000, intervalMs: 10_000 });
    if (recovered.value !== secretValue) throw new Error('recovered value DIFFERS from original');
    return `value intact after ${Date.now() - recoverT0}ms`;
  });
  report.rpo('recoverMs', Date.now() - recoverT0);

  // ---- canary-2: purge must be BLOCKED -------------------------------------
  await report.check('drill: purge REJECTED by purge protection', async () => {
    az(['keyvault', 'secret', 'set', '--vault-name', VAULT, '--name', PURGE_CANARY, '--value', 'purge-canary', ...SUB_ARGS]);
    az(['keyvault', 'secret', 'delete', '--vault-name', VAULT, '--name', PURGE_CANARY, ...SUB_ARGS]);
    await poll(`deleted secret ${PURGE_CANARY}`, async () => {
      try {
        return azJson(['keyvault', 'secret', 'show-deleted', '--vault-name', VAULT, '--name', PURGE_CANARY, ...SUB_ARGS], { allowFail: true });
      } catch { return null; }
    }, { timeoutMs: 180_000, intervalMs: 10_000 });
    try {
      az(['keyvault', 'secret', 'purge', '--vault-name', VAULT, '--name', PURGE_CANARY, ...SUB_ARGS], { allowFail: true });
    } catch (err) {
      // Expected: purge protection rejects the operation.
      const msg = String(err.stderr || err.message);
      if (/purge.*(protect|disabled|not allowed)|ForbiddenByPolicy|Operation.*not permitted/i.test(msg)) {
        return `rejected as expected: ${msg.split('\n')[0].slice(0, 160)}`;
      }
      throw new Error(`purge failed but NOT with a purge-protection error: ${msg.slice(0, 200)}`);
    }
    throw new Error('PURGE SUCCEEDED — purge protection is NOT effective');
  });

  // Cleanup: canary-1 is live again — delete it so the vault stays swept
  // (it then soft-deletes and auto-purges at end of retention, like canary-2).
  await report.check('cleanup: canary re-deleted (soft-delete sweep)', async () => {
    az(['keyvault', 'secret', 'delete', '--vault-name', VAULT, '--name', CANARY, ...SUB_ARGS]);
    return `${CANARY} left in soft-delete (auto-purge at retention end)`;
  });
};

main()
  .catch((err) => {
    console.error(err);
    return report.check('validator crashed', async () => { throw err; });
  })
  .finally(() => {
    report.write();
    process.exit(report.ok ? 0 : 1);
  });
