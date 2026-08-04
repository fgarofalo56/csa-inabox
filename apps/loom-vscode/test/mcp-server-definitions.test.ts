/**
 * Unit tests for the MCP server-definition builder (Phase 4). Pure logic, no
 * VS Code host. These assert the two security invariants the task calls out:
 *   1. the write/admin servers are ABSENT unless explicitly opted in (blast
 *      radius default), and
 *   2. a PAT never reaches a server pointed at a DIFFERENT deployment.
 * Each carries a mutation-proof (a comment stating what revert turns it RED).
 */
import { describe, it, expect } from 'vitest';
import {
  MCP_SERVERS,
  DEFAULT_ENABLED_SERVERS,
  ALL_SERVER_IDS,
  buildServerDefinitions,
  resolveServerEnv,
  coerceEnabledServers,
  descriptorLabel,
  type McpDeployment,
} from '../src/mcp/server-definitions';

const depA: McpDeployment = { id: 'a', name: 'Commercial', apiUrl: 'https://a.example.com', cloud: 'commercial' };
const depB: McpDeployment = { id: 'b', name: 'Gov', apiUrl: 'https://b.example.us', cloud: 'gov' };

describe('blast-radius default', () => {
  it('DEFAULT_ENABLED_SERVERS is exactly the two read-only servers', () => {
    expect([...DEFAULT_ENABLED_SERVERS].sort()).toEqual(['loom-catalog', 'loom-query']);
  });

  it('the write/admin servers are marked writes:true, safeDefault:false', () => {
    for (const id of ['loom-author', 'loom-ops', 'loom-admin']) {
      const s = MCP_SERVERS.find((x) => x.id === id)!;
      expect(s.writes).toBe(true);
      expect(s.safeDefault).toBe(false);
    }
  });

  it('MUTATION-PROOF: the default enabled set yields ONLY catalog+query — no author/ops/admin', () => {
    const defs = buildServerDefinitions([depA], { enabled: DEFAULT_ENABLED_SERVERS });
    const ids = defs.map((d) => d.server.id).sort();
    // If buildServerDefinitions ignored `enabled` (e.g. returned all MCP_SERVERS),
    // this would include loom-author/ops/admin and FAIL.
    expect(ids).toEqual(['loom-catalog', 'loom-query']);
    expect(ids).not.toContain('loom-author');
    expect(ids).not.toContain('loom-ops');
    expect(ids).not.toContain('loom-admin');
  });

  it('a write server appears only after an EXPLICIT opt-in', () => {
    const off = buildServerDefinitions([depA], { enabled: ['loom-catalog'] });
    expect(off.some((d) => d.server.id === 'loom-author')).toBe(false);
    const on = buildServerDefinitions([depA], { enabled: ['loom-catalog', 'loom-author'] });
    expect(on.some((d) => d.server.id === 'loom-author')).toBe(true);
  });

  it('emits one descriptor per (deployment × enabled server)', () => {
    const defs = buildServerDefinitions([depA, depB], { enabled: ['loom-catalog', 'loom-query'] });
    expect(defs).toHaveLength(4);
    expect(defs.filter((d) => d.deploymentId === 'a')).toHaveLength(2);
    expect(defs.filter((d) => d.deploymentId === 'b')).toHaveLength(2);
  });
});

describe('resolveServerEnv — no PAT crosses deployments', () => {
  const catalog = MCP_SERVERS.find((s) => s.id === 'loom-catalog')!;
  const descA = { deploymentId: 'a', deploymentName: 'Commercial', apiUrl: depA.apiUrl, cloud: 'commercial', server: catalog, label: descriptorLabel(catalog, depA) };
  const descB = { deploymentId: 'b', deploymentName: 'Gov', apiUrl: depB.apiUrl, cloud: 'gov', server: catalog, label: descriptorLabel(catalog, depB) };

  it('MUTATION-PROOF: each descriptor gets ONLY its own deployment token', () => {
    const tokens = { a: 'loom_pat_aaa_secretA', b: 'loom_pat_bbb_secretB' };
    const envA = resolveServerEnv(descA, tokens);
    const envB = resolveServerEnv(descB, tokens);
    // If the keying were reverted to `Object.values(tokens)[0]`, envB would carry
    // token A — a PAT reaching the wrong (Gov!) deployment. This asserts it does not.
    expect(envA.LOOM_TOKEN).toBe('loom_pat_aaa_secretA');
    expect(envB.LOOM_TOKEN).toBe('loom_pat_bbb_secretB');
    expect(envB.LOOM_TOKEN).not.toBe(tokens.a);
    expect(envA.LOOM_API_URL).toBe('https://a.example.com');
    expect(envB.LOOM_API_URL).toBe('https://b.example.us');
  });

  it('omits LOOM_TOKEN entirely when no token exists for that deployment', () => {
    const env = resolveServerEnv(descB, { a: 'loom_pat_aaa_x' });
    expect(env.LOOM_TOKEN).toBeUndefined();
    expect(env.LOOM_API_URL).toBe('https://b.example.us');
  });

  it('sets LOOM_TOKEN_SCOPE to the server minScope and admin env only for the admin server', () => {
    const admin = MCP_SERVERS.find((s) => s.id === 'loom-admin')!;
    const author = MCP_SERVERS.find((s) => s.id === 'loom-author')!;
    const adminDesc = { deploymentId: 'a', deploymentName: 'x', apiUrl: depA.apiUrl, cloud: 'commercial', server: admin, label: 'x' };
    const authorDesc = { deploymentId: 'a', deploymentName: 'x', apiUrl: depA.apiUrl, cloud: 'commercial', server: author, label: 'y' };
    expect(resolveServerEnv(adminDesc, {}).LOOM_TOKEN_SCOPE).toBe('admin');
    expect(resolveServerEnv(adminDesc, {}).LOOM_MCP_ADMIN_ENABLED).toBe('1');
    expect(resolveServerEnv(authorDesc, {}).LOOM_TOKEN_SCOPE).toBe('read-write');
    expect(resolveServerEnv(authorDesc, {}).LOOM_MCP_ADMIN_ENABLED).toBeUndefined();
    expect(resolveServerEnv(descA, {}).LOOM_MCP_ADMIN_ENABLED).toBeUndefined();
  });
});

describe('coerceEnabledServers', () => {
  it('non-array → the safe default set', () => {
    expect(coerceEnabledServers(undefined)).toEqual([...DEFAULT_ENABLED_SERVERS]);
    expect(coerceEnabledServers('nope')).toEqual([...DEFAULT_ENABLED_SERVERS]);
  });
  it('keeps valid ids, drops unknowns + dupes', () => {
    expect(coerceEnabledServers(['loom-query', 'loom-query', 'nope', 'loom-admin'])).toEqual([
      'loom-query',
      'loom-admin',
    ]);
  });
  it('every id it can emit is a real server id', () => {
    expect(coerceEnabledServers([...ALL_SERVER_IDS]).sort()).toEqual([...ALL_SERVER_IDS].sort());
  });
});
