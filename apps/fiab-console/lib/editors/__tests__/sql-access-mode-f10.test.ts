/**
 * F10 — SQL endpoint data-access mode (delegated vs user's identity).
 *
 * Static wiring test (per .claude/rules/no-vaporware.md): asserts the F10 code
 * path is real and connected end-to-end — the access-mode PATCH route exists
 * and calls Cosmos + role checks, the SQL client exposes a per-user query path,
 * both query routes branch on the resolved mode, and the auth surfaces request
 * + capture the delegated SQL token. A stub (e.g. `return {}`) would not match.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CONSOLE = resolve(__dirname, '..', '..', '..');
const read = (rel: string): string => {
  const p = resolve(CONSOLE, rel);
  return existsSync(p) ? readFileSync(p, 'utf-8') : '';
};

describe('F10 SQL data-access mode — real wiring', () => {
  it('access-mode PATCH route exists, validates the enum, checks role, writes Cosmos', () => {
    const src = read('app/api/items/[type]/[id]/access-mode/route.ts');
    expect(src, 'access-mode route.ts must exist').toBeTruthy();
    expect(src).toMatch(/export async function PATCH/);
    expect(src).toMatch(/canEditWorkspaceConfig/);
    expect(src).toMatch(/resolveWorkspaceRole/);
    expect(src).toMatch(/itemsContainer/);
    expect(src).toMatch(/\.replace<WorkspaceItem>/);
    // Only the two SQL endpoint item types are accepted.
    expect(src).toMatch(/isSqlAccessModeItemType/);
  });

  it('shared resolver defaults to the always-works service identity', () => {
    const src = read('lib/azure/sql-access-mode.ts');
    expect(src).toMatch(/export async function resolveAccessMode/);
    expect(src).toMatch(/normalizeAccessMode/);
    // Default path must be 'service' — never gates on user provisioning.
    expect(src).toMatch(/return 'service'/);
  });

  it('synapse-sql-client exposes a per-user (delegated-token) query path', () => {
    const src = read('lib/azure/synapse-sql-client.ts');
    expect(src).toMatch(/export async function executeQueryAsUser/);
    // Per-user TDS pool keyed by oid, opened with the caller's token (isolation).
    expect(src).toMatch(/userPools/);
    expect(src).toMatch(/azure-active-directory-access-token/);
    expect(src).toMatch(/:user:\$\{userOid\}/);
  });

  it('SQL user-token store mirrors the ARM store (encrypted, best-effort)', () => {
    const src = read('lib/azure/sql-user-token-store.ts');
    expect(src).toMatch(/export async function saveUserSqlToken/);
    expect(src).toMatch(/export async function getUserSqlToken/);
    expect(src).toMatch(/encryptAtRest/);
    expect(src).toMatch(/decryptAtRest/);
    expect(src).toMatch(/sqlusertoken:/);
  });

  it('both query routes resolve the mode and branch to the user path with an honest gate', () => {
    for (const slug of ['synapse-dedicated-sql-pool', 'synapse-serverless-sql-pool']) {
      const src = read(`app/api/items/${slug}/[id]/query/route.ts`);
      expect(src, `${slug} query route must exist`).toBeTruthy();
      expect(src).toMatch(/resolveAccessMode/);
      expect(src).toMatch(/getUserSqlToken/);
      expect(src).toMatch(/executeQueryAsUser/);
      // Honest gate when the user has no cached SQL token (no silent fallback).
      expect(src).toMatch(/NO_USER_SQL_TOKEN/);
    }
  });

  it('auth requests + captures the delegated Azure SQL token (cloud-portable)', () => {
    const signin = read('app/auth/sign-in/route.ts');
    expect(signin).toMatch(/user_impersonation/);
    expect(signin).toMatch(/LOOM_SYNAPSE_SQL_TOKEN_SCOPE/);
    const cb = read('app/auth/callback/route.ts');
    expect(cb).toMatch(/captureUserSqlToken/);
    expect(cb).toMatch(/saveUserSqlToken/);
  });

  it('the UI section calls the real PATCH route and confirms the user switch', () => {
    const src = read('lib/panes/sql-access-mode-section.tsx');
    expect(src).toMatch(/\/access-mode/);
    expect(src).toMatch(/method: 'PATCH'/);
    // One-time confirmation dialog when switching to user's identity.
    expect(src).toMatch(/Dialog/);
    expect(src).toMatch(/pending === 'user'/);
  });

  it('the SQL editors mount the data-access-mode section', () => {
    const src = read('lib/editors/synapse-sql-editors.tsx');
    expect(src).toMatch(/SqlAccessModeSection/);
    expect(src).toMatch(/itemType="synapse-dedicated-sql-pool"/);
    expect(src).toMatch(/itemType="synapse-serverless-sql-pool"/);
  });
});
