/**
 * Git / ALM (Phase 5, W9/W10): the pure model + the LoomApi transport against a
 * MOCKED route. Proves the client speaks the real `/api/git-integration/*`
 * contract AND maps an honest 424 `{gated:true,missing}` to a typed GitGateError
 * (never a fabricated status).
 *
 * MUTATION-PROOF: the "424 → GitGateError" test goes RED if the gate detection
 * (`isGitGateBody` / `gitRequest`) is removed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LoomApi, GitGateError, LoomApiError } from '../src/api/loom-client';
import {
  changeIcon,
  summarizeChanges,
  describeGitGate,
  isGitGateBody,
  type GitStatusEntry,
} from '../src/git/git-model';

const api = () => new LoomApi('https://loom.example', { kind: 'pat', value: 'loom_pat_test' });
afterEach(() => vi.unstubAllGlobals());

interface FakeResp {
  status: number;
  body: unknown;
}

function installFetch(byPath: (path: string, method: string, body?: unknown) => FakeResp) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      const u = new URL(url);
      const r = byPath(u.pathname + u.search, method, body);
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

describe('git-model (pure)', () => {
  it('changeIcon maps each status to a diff codicon', () => {
    expect(changeIcon('added')).toBe('diff-added');
    expect(changeIcon('removed')).toBe('diff-removed');
    expect(changeIcon('modified')).toBe('diff-modified');
  });

  it('summarizeChanges counts by status', () => {
    const changed: GitStatusEntry[] = [
      { itemType: 'notebook', displayName: 'a', status: 'added' },
      { itemType: 'notebook', displayName: 'b', status: 'modified' },
      { itemType: 'report', displayName: 'c', status: 'removed' },
      { itemType: 'report', displayName: 'd', status: 'modified' },
    ];
    expect(summarizeChanges(changed)).toEqual({ added: 1, modified: 2, removed: 1, total: 4 });
  });

  it('describeGitGate names the exact remediation per reason', () => {
    expect(describeGitGate('no_repo_bound')).toMatch(/Connect an Azure DevOps or GitHub repo/i);
    expect(describeGitGate('no_pat')).toMatch(/access token/i);
    expect(describeGitGate('kv_forbidden')).toMatch(/Key Vault Secrets User/i);
    expect(describeGitGate('no_kv')).toMatch(/Key Vault/i);
  });

  it('isGitGateBody only accepts a gated body with a string missing', () => {
    expect(isGitGateBody({ gated: true, missing: 'no_repo_bound' })).toBe(true);
    expect(isGitGateBody({ ok: false, error: 'boom' })).toBe(false);
    expect(isGitGateBody({ gated: true })).toBe(false);
    expect(isGitGateBody(null)).toBe(false);
  });
});

describe('LoomApi git transport', () => {
  it('gitStatus GETs the workspace-scoped route and returns the body', async () => {
    const calls = installFetch(() => ({
      status: 200,
      body: {
        ok: true,
        workspaceId: 'ws1',
        repo: { provider: 'ado', repoPath: 'org/proj/repo', branch: 'main' },
        headSha: 'abc123',
        lastSyncedSha: null,
        changed: [{ itemId: 'i1', itemType: 'notebook', displayName: 'nb', status: 'modified' }],
      },
    }));
    const res = await api().gitStatus('ws1');
    expect(res.repo.branch).toBe('main');
    expect(res.changed).toHaveLength(1);
    expect(calls[0].url).toBe('https://loom.example/api/git-integration/status?workspaceId=ws1');
  });

  it('gitCommit POSTs {workspaceId,itemIds,message}', async () => {
    const calls = installFetch(() => ({ status: 200, body: { ok: true, commitSha: 'deadbeef', url: 'https://x/commit/deadbeef', at: 't', files: 2, committed: [] } }));
    const res = await api().gitCommit('ws1', ['i1', 'i2'], 'msg');
    expect(res.commitSha).toBe('deadbeef');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://loom.example/api/git-integration/commit');
    expect(calls[0].body).toEqual({ workspaceId: 'ws1', itemIds: ['i1', 'i2'], message: 'msg' });
  });

  it('gitPull omits itemIds when none given', async () => {
    const calls = installFetch(() => ({ status: 200, body: { ok: true, headSha: 'h', applied: 3, items: [] } }));
    await api().gitPull('ws1');
    expect(calls[0].body).toEqual({ workspaceId: 'ws1' });
  });

  it('gitResolve POSTs the resolution', async () => {
    const calls = installFetch(() => ({ status: 200, body: { ok: true, resolution: 'remote', applied: 1, headSha: 'h' } }));
    const res = await api().gitResolve('ws1', 'i1', 'remote');
    expect(res.resolution).toBe('remote');
    expect(calls[0].body).toEqual({ workspaceId: 'ws1', itemId: 'i1', resolution: 'remote' });
  });

  it('maps a 424 gate to GitGateError carrying `missing` (never a status)', async () => {
    installFetch(() => ({ status: 424, body: { ok: false, gated: true, missing: 'no_repo_bound', detail: 'connect a repo' } }));
    await expect(api().gitStatus('ws1')).rejects.toBeInstanceOf(GitGateError);
    try {
      await api().gitCommit('ws1', ['i1'], 'm');
    } catch (e) {
      expect(e).toBeInstanceOf(GitGateError);
      expect((e as GitGateError).missing).toBe('no_repo_bound');
      expect((e as GitGateError).detail).toBe('connect a repo');
    }
  });

  it('a 401 (not a gate) throws a plain LoomApiError, not GitGateError', async () => {
    installFetch(() => ({ status: 401, body: { ok: false, error: 'unauthenticated' } }));
    await expect(api().gitStatus('ws1')).rejects.toBeInstanceOf(LoomApiError);
    await expect(api().gitStatus('ws1')).rejects.not.toBeInstanceOf(GitGateError);
  });
});
