/**
 * Bicep wiring guard for F22 Embed codes / F23 Organizational visuals.
 *
 * The embed-codes + org-visuals backends are gated solely on
 * LOOM_ORG_VISUALS_URL (the org-visuals Blob container URL on the DLZ ADLS
 * account). This spec pins the deployment wiring so the env var, the
 * org-visuals Blob container, the Cosmos container, and the Console-UAMI RBAC
 * grants stay in sync with the client (no drift = no vaporware).
 *
 * Regression it guards (audit-T128): top-level main.bicep used to derive
 * `loomStorageAccount` UNCONDITIONALLY from `singleDlzRg.id`. In multi-sub
 * mode singleDlzRg is NOT deployed, so that yielded a phantom `saloomdefault…`
 * account name — LOOM_ORG_VISUALS_URL was emitted (so the pane skipped its
 * honest gate) but pointed at a storage account that does not exist, making
 * SAS minting 500 at runtime. The account MUST be gated on single-sub so
 * multi-sub honest-gates instead.
 *
 * Topology refactor (audit-t156, task #225): the single-sub gate is now
 * expressed via the resolved `useSingleDlz` var
 * (`deployLandingZones && effectiveTopology == 'single-sub'`) rather than the
 * literal `deploymentMode == 'single-sub'`. Both forms are semantically
 * single-sub-only and keep the phantom-account fix intact, so this guard
 * accepts either spelling.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');

function read(...parts: string[]): string {
  return readFileSync(resolve(REPO_ROOT, ...parts), 'utf-8');
}

const BICEP = ['platform', 'fiab', 'bicep'];

describe('embed-codes / org-visuals bicep wiring', () => {
  const topMain = read(...BICEP, 'main.bicep');
  const adminMain = read(...BICEP, 'modules', 'admin-plane', 'main.bicep');
  const storage = read(...BICEP, 'modules', 'landing-zone', 'storage.bicep');
  const cosmos = read(...BICEP, 'modules', 'landing-zone', 'cosmos.bicep');
  const rbac = read(...BICEP, 'modules', 'landing-zone', 'org-visuals-rbac.bicep');

  it('top-level main.bicep never invents a storage account name (no phantom account in multi-sub)', () => {
    // THE INVARIANT, unchanged since audit-T128: in multi-sub, `loomStorageAccount`
    // must never be a name this template COMPUTED. A guessed `saloomdefault…`
    // emitted LOOM_ORG_VISUALS_URL (so the pane skipped its honest gate) pointing
    // at an account that does not exist, and SAS minting 500'd at runtime.
    //
    // WHAT CHANGED (2026-08-10): the account may now also come from an explicit
    // `adopt` plan — a name DISCOVERED from the estate, not derived from
    // singleDlzRg. That is the opposite of a phantom: it is the real lake, and
    // binding to it is what unblocked svc-adls, medallion Silver/Gold,
    // sample-data, RTI-export, CSV-imports and the S3 gateway on a multi-sub
    // estate that owned every one of those resources already.
    //
    // So the invariant is asserted by its three legal outcomes rather than by one
    // literal expression: adopted-real, single-sub-convention, or ''.

    // (a) The original regression: an UNCONDITIONAL derive from singleDlzRg.
    expect(topMain).not.toMatch(
      /loomStorageAccount:\s*take\('saloomdefault\$\{uniqueString\(singleDlzRg\.id\)\}/,
    );

    // (b) Adopt-first: an explicitly adopted `storage-adls` name wins.
    expect(topMain).toMatch(
      /loomStorageAccount:\s*!empty\(adoptName\(adopt, 'storage-adls'\)\)/,
    );

    // (c) The convention branch is STILL gated on single-sub and STILL falls back
    //     to '' — this is the half that keeps multi-sub honest-gating when there
    //     is nothing to adopt. Accept the resolved `useSingleDlz` var (current)
    //     or the original `deploymentMode == 'single-sub'` literal.
    expect(topMain).toMatch(
      /\(\s*(?:useSingleDlz|deploymentMode == 'single-sub')\s*\?\s*take\('saloomdefault\$\{uniqueString\(singleDlzRg\.id\)\}', 24\)\s*:\s*''\s*\)/,
    );
  });

  it('grants are gated on the lake being in THIS subscription, not merely configured', () => {
    // A cross-subscription lake can be BOUND (the env vars are plain strings) but
    // cannot be GRANTED — a subscription-scoped deployment cannot create a role
    // assignment in another subscription. Before this split, one flag did both,
    // so the only way to stop the grants firing was to leave the account name
    // EMPTY, which is precisely why multi-sub estates could not bind their lake.
    expect(topMain).toMatch(/loomStorageAccountSameSub:/);
    // Same-sub is derived from the adopt entry's `sub`, and an adopted lake with
    // no explicit sub is treated as local.
    expect(topMain).toMatch(/adoptSub\(adopt, 'storage-adls'\)/);
    // Every RBAC/workload consumer keys off the combined var, never `!empty()`.
    expect(adminMain).toMatch(
      /var loomStorageGrantable = !empty\(loomStorageAccount\) && loomStorageAccountSameSub/,
    );
  });

  it('admin-plane emits LOOM_ORG_VISUALS_URL only when loomStorageAccount is set (honest gate otherwise)', () => {
    // Env var is inside the `!empty(loomStorageAccount) ? [...]` block, so an
    // empty account (multi-sub) omits it → pane shows the honest config gate.
    expect(adminMain).toMatch(
      /LOOM_ORG_VISUALS_URL'.*\$\{loomStorageAccount\}\.blob\.\$\{environment\(\)\.suffixes\.storage\}\/org-visuals/,
    );
    expect(adminMain).toMatch(/!empty\(loomStorageAccount\) \? \[/);
  });

  it('admin-plane grants the org-visuals RBAC only when loomStorageAccount is set', () => {
    // The guard requires both !skipRoleGrants and a non-empty loomStorageAccount.
    // It now also AND-gates on the org-visuals backend toggle
    // (`(loomBackends.?orgVisuals ?? 'enabled') != 'disabled'`) — accept the
    // optional trailing backend condition so the guard stays pinned without
    // over-fitting to the exact toggle spelling.
    expect(adminMain).toMatch(
      /module orgVisualsRbac '\.\.\/landing-zone\/org-visuals-rbac\.bicep' = if \(!skipRoleGrants && !empty\(loomStorageAccount\)/,
    );
  });

  it('landing-zone creates the org-visuals Blob container by default', () => {
    expect(storage).toMatch(/'org-visuals'/);
  });

  it('landing-zone creates the embed-codes Cosmos container partitioned by tenantId', () => {
    expect(cosmos).toMatch(/'embed-codes'/);
    expect(cosmos).toMatch(/\/tenantId/);
  });

  it('org-visuals RBAC grants Blob Data Contributor (container) + Blob Delegator (account, for user-delegation SAS)', () => {
    // Storage Blob Data Contributor — built-in role GUID (cloud-agnostic).
    expect(rbac).toMatch(/ba92f5b4-2d11-453d-a403-e96b0029c9fe/);
    // Storage Blob Delegator — required for Get User Delegation Key (account scope).
    expect(rbac).toMatch(/db58b8e5-c6ad-4a2a-8342-4190687cbf4a/);
  });
});
