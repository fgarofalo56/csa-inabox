#!/usr/bin/env node
// scripts/csa-loom/dr/validate-adls-restore.mjs — DR2 (loom-next-level WS-DR)
//
// The NEW `adls-softdelete-restore` scenario of .github/workflows/dr-drill.yml.
//
// REDESIGN NOTE (binding — DR0 #2414, Learn-grounded): the original PRP spec
// named this scenario `adls-versioning-restore` (canary + prior-VERSION
// promotion). That premise was WRONG: blob versioning AND blob point-in-time
// restore (restorePolicy) are both UNSUPPORTED on HNS-enabled (ADLS Gen2)
// accounts, and the Loom lake is HNS by design (storage.bicep
// `isHnsEnabled: true`, guarded `hnsSupportsVersioning`). DR0 shipped the
// corrected posture: blob + container soft delete (`recycleRetentionDays`
// window) + change feed. This drill therefore validates the RESTORE PATH THAT
// ACTUALLY EXISTS on the shipped posture:
//
//   posture  — live ARM assertions: HNS on, blob soft delete on (window),
//              container soft delete on, change feed on, and versioning
//              correctly OFF (it would be an ARM-invalid combination).
//   restore  — canary DFS drill on the LIVE lake (namespaced filesystem
//              `drdrill-<id>`, torn down in the workflow's always() step):
//              upload canary (recorded sha256) → overwrite v2 → delete →
//              list-deleted-paths → undelete-path → download → byte-for-byte
//              hash match. Restore duration recorded as RTO evidence.
//   safety   — the drill filesystem is deleted and asserted to appear in the
//              soft-deleted container list (the container-level safety net).
//
// Auth: az CLI context; data-plane via `--auth-mode login` (the drill SP needs
// Storage Blob Data Contributor on the lake — see docs/runbooks/dr-drill.md §3).
// The workflow opens a single-IP firewall window first and re-locks in always().
//
// Env: DRILL_ID, DRILL_CLOUD, DR_REPORT_DIR,
//      STORAGE_ACCOUNT (required), STORAGE_RG (required), STORAGE_SUB (optional)
//
// Exit 0 only when every check passes. Always writes the report JSON.

import { az, azJson, drillEnv, makeReport, poll, sha256 } from './_drill-lib.mjs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { drillId, cloud } = drillEnv();
const report = makeReport({ scenario: 'adls-softdelete-restore', drillId, cloud });

const ACCOUNT = process.env.STORAGE_ACCOUNT;
const RG = process.env.STORAGE_RG;
const SUB_ARGS = process.env.STORAGE_SUB ? ['--subscription', process.env.STORAGE_SUB] : [];
if (!ACCOUNT || !RG) {
  console.error('STORAGE_ACCOUNT and STORAGE_RG are required');
  process.exit(2);
}

const FS_NAME = `drdrill-${drillId.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40)}`;
const FILE = 'canary.txt';
const dataArgs = ['--account-name', ACCOUNT, '--auth-mode', 'login', ...SUB_ARGS];
const tmp = mkdtempSync(path.join(tmpdir(), 'drdrill-'));

const main = async () => {
  // ---- posture (live ARM) — the DR0-shipped restore posture ----------------
  await report.check('posture: account is HNS (ADLS Gen2)', async () => {
    const acct = azJson(['storage', 'account', 'show', '-n', ACCOUNT, '-g', RG, ...SUB_ARGS]);
    if (acct.isHnsEnabled !== true) throw new Error('isHnsEnabled != true — wrong account?');
    return `sku=${acct.sku?.name}`;
  });

  let props;
  await report.check('posture: blob soft delete ON (the HNS restore primitive)', async () => {
    props = azJson(['storage', 'account', 'blob-service-properties', 'show', '--account-name', ACCOUNT, '-g', RG, ...SUB_ARGS]);
    const d = props.deleteRetentionPolicy;
    if (!d?.enabled || !(d.days >= 1)) throw new Error(`deleteRetentionPolicy=${JSON.stringify(d)}`);
    return `${d.days}-day window`;
  });
  await report.check('posture: container soft delete ON', async () => {
    const c = props.containerDeleteRetentionPolicy;
    if (!c?.enabled || !(c.days >= 1)) throw new Error(`containerDeleteRetentionPolicy=${JSON.stringify(c)}`);
    return `${c.days}-day window`;
  });
  await report.check('posture: change feed ON', async () => {
    if (!props.changeFeed?.enabled) throw new Error(`changeFeed=${JSON.stringify(props.changeFeed)}`);
    return 'enabled';
  });
  await report.check('posture: versioning correctly OFF on HNS (DR0 correction)', async () => {
    // Versioning is UNSUPPORTED on HNS accounts — it being on would mean the
    // account drifted off the Learn-valid posture (or is not the HNS lake).
    if (props.isVersioningEnabled === true) {
      throw new Error('isVersioningEnabled=true on an HNS account — posture drift, investigate');
    }
    return 'isVersioningEnabled falsy — soft delete is the restore path, as designed';
  });
  report.rpo('softDeleteWindowDays', props.deleteRetentionPolicy?.days ?? null);

  // ---- canary soft-delete restore drill ------------------------------------
  const v1 = `dr-drill ${drillId} v1 ${Date.now()} ${Math.random()}\n`;
  const v2 = `dr-drill ${drillId} v2 ${Date.now()} ${Math.random()}\n`;
  const v2Hash = sha256(Buffer.from(v2));
  const localV1 = path.join(tmp, 'canary-v1.txt');
  const localV2 = path.join(tmp, 'canary-v2.txt');
  writeFileSync(localV1, v1);
  writeFileSync(localV2, v2);

  await report.check('drill: create canary filesystem + upload canary (v1 then v2 overwrite)', async () => {
    az(['storage', 'fs', 'create', '-n', FS_NAME, ...dataArgs]);
    az(['storage', 'fs', 'file', 'upload', '-f', FS_NAME, '-s', localV1, '-p', FILE, ...dataArgs]);
    az(['storage', 'fs', 'file', 'upload', '-f', FS_NAME, '-s', localV2, '-p', FILE, '--overwrite', ...dataArgs]);
    return `${FS_NAME}/${FILE} sha256=${v2Hash.slice(0, 16)}…`;
  });

  let deletionId;
  await report.check('drill: delete canary → appears in list-deleted-paths', async () => {
    az(['storage', 'fs', 'file', 'delete', '-f', FS_NAME, '-p', FILE, '--yes', ...dataArgs]);
    const entry = await poll(`deleted path ${FILE} listed`, async () => {
      const deleted = azJson(['storage', 'fs', 'list-deleted-path', '-f', FS_NAME, ...dataArgs]) || [];
      return deleted.find((d) => d.name === FILE);
    }, { timeoutMs: 120_000, intervalMs: 10_000 });
    deletionId = entry.deletionId;
    return `deletionId=${deletionId}`;
  });

  const restoreT0 = Date.now();
  await report.check('drill: undelete-path restores the canary byte-for-byte', async () => {
    az(['storage', 'fs', 'undelete-path', '-f', FS_NAME, '--deleted-path-name', FILE, '--deletion-id', deletionId, ...dataArgs]);
    const restored = path.join(tmp, 'restored.txt');
    await poll('restored file downloadable', async () => {
      try {
        az(['storage', 'fs', 'file', 'download', '-f', FS_NAME, '-p', FILE, '-d', restored, '--overwrite', ...dataArgs]);
        return true;
      } catch { return false; }
    }, { timeoutMs: 90_000, intervalMs: 10_000 });
    const gotHash = sha256(readFileSync(restored));
    if (gotHash !== v2Hash) throw new Error(`hash mismatch: restored=${gotHash} expected=${v2Hash}`);
    return `sha256 match after ${Date.now() - restoreT0}ms`;
  });
  report.rpo('undeleteRestoreMs', Date.now() - restoreT0);

  // ---- container-level safety net ------------------------------------------
  await report.check('safety: deleted filesystem appears in soft-deleted container list', async () => {
    az(['storage', 'fs', 'delete', '-n', FS_NAME, '--yes', ...dataArgs]);
    const entry = await poll(`soft-deleted container ${FS_NAME} listed`, async () => {
      const containers = azJson(['storage', 'container', 'list', '--include-deleted', ...dataArgs]) || [];
      return containers.find((c) => c.name === FS_NAME && c.deleted);
    }, { timeoutMs: 120_000, intervalMs: 10_000 });
    return `deleted=${entry.deleted}, remainingRetentionDays=${entry.properties?.remainingRetentionDays ?? 'n/a'}`;
  });
};

main()
  .catch((err) => {
    console.error(err);
    return report.check('validator crashed', async () => { throw err; });
  })
  .finally(() => {
    // Best-effort cleanup if the drill failed before the filesystem delete.
    try { az(['storage', 'fs', 'delete', '-n', FS_NAME, '--yes', ...dataArgs], { allowFail: true }); } catch { /* already gone */ }
    report.write();
    process.exit(report.ok ? 0 : 1);
  });
