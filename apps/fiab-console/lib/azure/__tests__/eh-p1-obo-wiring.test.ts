/**
 * EH-P1-OBO (#1800) — static wiring test (per .claude/rules/no-vaporware.md),
 * following the sql-access-mode-f10 spec's pattern: asserts the per-user
 * data-plane path is real and connected end-to-end — the report + KQL query
 * routes branch on the resolved access mode through user-pool-registry, the
 * executors expose real per-user execution (never a mock), the ADLS user
 * client calls the real SDK with a delegated credential, and every
 * missing-consent path is an honest structured gate. A stub would not match.
 *
 * Behavioral coverage lives in user-pool-registry.test.ts and the two
 * token-store specs; this file pins the ROUTE wiring.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CONSOLE = resolve(__dirname, '..', '..', '..');
const read = (rel: string): string => {
  const p = resolve(CONSOLE, rel);
  return existsSync(p) ? readFileSync(p, 'utf-8') : '';
};

describe('EH-P1-OBO per-user data-plane path — real wiring', () => {
  it('user-pool-registry maps every kind to its store and gates honestly', () => {
    const src = read('lib/azure/user-pool-registry.ts');
    expect(src, 'user-pool-registry.ts must exist').toBeTruthy();
    expect(src).toMatch(/export async function getUserDataPlaneToken/);
    expect(src).toMatch(/export async function resolveUserRead/);
    // One resolver per pool — sql / storage / kusto / arm / powerbi.
    expect(src).toMatch(/sql-user-token-store/);
    expect(src).toMatch(/storage-user-token-store/);
    expect(src).toMatch(/kusto-user-token-store/);
    expect(src).toMatch(/user-token-store/);
    expect(src).toMatch(/pbi-user-token-store/);
    // Real MSAL silent refresh (no fabricated tokens) + honest gate codes.
    expect(src).toMatch(/acquireTokenSilent/);
    expect(src).toMatch(/NO_USER_STORAGE_TOKEN/);
    expect(src).toMatch(/NO_USER_KUSTO_TOKEN/);
    expect(src).toMatch(/NO_USER_SQL_TOKEN/);
  });

  it('the new token stores mirror the sibling stores (encrypted, best-effort)', () => {
    for (const [file, prefix] of [
      ['lib/azure/storage-user-token-store.ts', 'storageusertoken:'],
      ['lib/azure/kusto-user-token-store.ts', 'kustousertoken:'],
    ] as const) {
      const src = read(file);
      expect(src, `${file} must exist`).toBeTruthy();
      expect(src).toMatch(/encryptAtRest/);
      expect(src).toMatch(/decryptAtRest/);
      expect(src).toMatch(/SAFETY_MARGIN_MS/);
      expect(src).toContain(prefix);
    }
  });

  it('report /query branches on state.accessMode via the registry (honest gate, no downgrade)', () => {
    const src = read('app/api/items/report/[id]/query/route.ts');
    expect(src).toMatch(/normalizeAccessMode/);
    expect(src).toMatch(/resolveUserRead/);
    // Gate paths: missing token (registry body) + unsupported backend.
    expect(src).toMatch(/resolution\.mode === 'gate'/);
    expect(src).toMatch(/USER_MODE_UNSUPPORTED_BACKEND/);
    // The user context reaches the real executor.
    expect(src).toMatch(/executeLoomNativeQueryPath\(item, resolved, body\.visual, filters, compileOpts, userExec\)/);
  });

  it('loom-native executor runs the user path via executeQueryAsUser, bypassing shared cache/accel', () => {
    const src = read('lib/report/executors/loom-native.ts');
    expect(src).toMatch(/UserExecutionContext/);
    expect(src).toMatch(/executeQueryAsUser\(/);
    // The user path must NOT flow through the shared-identity orchestrator.
    const userBlock = src.slice(src.indexOf('if (user) {'), src.indexOf('QUERY ACCELERATION'));
    expect(userBlock).toContain('executeQueryAsUser');
    expect(userBlock).not.toContain('runAcceleratedQuery');
  });

  it('kql-database /query branches on state.accessMode and threads the user token to ADX', () => {
    const src = read('app/api/items/kql-database/[id]/query/route.ts');
    expect(src).toMatch(/normalizeAccessMode/);
    expect(src).toMatch(/resolveUserRead\('user', 'kusto'/);
    expect(src).toMatch(/clusterUri\(\)/);
    expect(src).toMatch(/executeQuery\(database, kql, \{ userToken \}\)/);
    expect(src).toMatch(/executeMgmtCommand\(database, kql, \{ userToken \}\)/);
  });

  it('kusto-client accepts a per-user delegated token on the real REST call', () => {
    const src = read('lib/azure/kusto-client.ts');
    expect(src).toMatch(/userToken\?: string/);
    expect(src).toMatch(/userToken \|\| \(await getToken\(base\)\)/);
  });

  it('adls-user-client reads via the real SDK as the user with a typed honest gate', () => {
    const src = read('lib/azure/adls-user-client.ts');
    expect(src).toMatch(/class AdlsUserTokenError/);
    expect(src).toMatch(/DataLakeServiceClient/);
    expect(src).toMatch(/export async function listPathsAsUser/);
    expect(src).toMatch(/export async function downloadFileAsUser/);
    expect(src).toMatch(/getUserDataPlaneToken\('storage'/);
  });

  it('lakehouse /paths honors the global OBO mode with the documented fallback policy', () => {
    const src = read('app/api/lakehouse/paths/route.ts');
    expect(src).toMatch(/oboMode\(\) === 'on'/);
    expect(src).toMatch(/listPathsAsUser/);
    expect(src).toMatch(/AdlsUserTokenError/);
    expect(src).toMatch(/identity/);
  });

  it('access-mode PATCH accepts the widened item-type set (report + kql-database)', () => {
    const modes = read('lib/azure/sql-access-mode.ts');
    expect(modes).toMatch(/USER_ACCESS_MODE_ITEM_TYPES/);
    expect(modes).toMatch(/'report'/);
    expect(modes).toMatch(/'kql-database'/);
    const route = read('app/api/items/[type]/[id]/access-mode/route.ts');
    expect(route).toMatch(/isUserAccessModeItemType/);
  });
});
