/**
 * #2723 — unit tests for the azure-sql authority-binding helper. Pure functions,
 * so no mocks: they pin the exact deny/derive policy the /query + /copilot routes
 * rely on. Each block names the mutation that turns it red.
 */
import { describe, it, expect } from 'vitest';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { boundSqlConnection, sqlHostsMatch, resolveOwnedSqlTarget } from '../_bound-connection';

const item = (state: Record<string, unknown>): WorkspaceItem =>
  ({ id: 'i', workspaceId: 'w', itemType: 'azure-sql-database', displayName: 'x', state,
     createdBy: 'u', createdAt: 't', updatedAt: 't' } as WorkspaceItem);

describe('boundSqlConnection', () => {
  it('reads state.connection.server/database (trimmed)', () => {
    expect(boundSqlConnection(item({ connection: { server: ' srv ', database: ' db ' } }))).toEqual({ server: 'srv', database: 'db' });
  });
  it('returns empties for an unbound item', () => {
    expect(boundSqlConnection(item({}))).toEqual({ server: '', database: '' });
  });
});

describe('sqlHostsMatch', () => {
  it('matches bare-name to FQDN on the first DNS label, case-insensitively', () => {
    expect(sqlHostsMatch('SRV.database.windows.net', 'srv')).toBe(true);
    expect(sqlHostsMatch('srv', 'srv')).toBe(true);
  });
  it('does NOT match a different server', () => {
    // MUTATION: make sqlHostsMatch always return true → this goes red.
    expect(sqlHostsMatch('attacker', 'srv')).toBe(false);
  });
  it('treats an empty submitted host as "no conflict"', () => {
    expect(sqlHostsMatch('', 'srv')).toBe(true);
  });
});

describe('resolveOwnedSqlTarget', () => {
  const bound = item({ connection: { server: 'srv', database: 'db' } });

  it('derives the bound server/database and ignores a matching body', () => {
    expect(resolveOwnedSqlTarget(bound, { server: 'srv', database: 'db' })).toEqual({ ok: true, server: 'srv', database: 'db' });
    // no body at all → still the bound pair
    expect(resolveOwnedSqlTarget(bound)).toEqual({ ok: true, server: 'srv', database: 'db' });
  });

  it('rejects a mismatched server (403 server_mismatch)', () => {
    const r = resolveOwnedSqlTarget(bound, { server: 'evil', database: 'db' });
    expect(r).toMatchObject({ ok: false, status: 403, code: 'server_mismatch' });
  });

  it('rejects a mismatched database (403 database_mismatch)', () => {
    const r = resolveOwnedSqlTarget(bound, { server: 'srv', database: 'evil' });
    expect(r).toMatchObject({ ok: false, status: 403, code: 'database_mismatch' });
  });

  it('refuses an unbound item (409 no_bound_connection)', () => {
    const r = resolveOwnedSqlTarget(item({}), { server: 'anything', database: 'anything' });
    expect(r).toMatchObject({ ok: false, status: 409, code: 'no_bound_connection' });
  });
});
