/**
 * Unit tests for the build-pipeline dispatch path (the fix for the Updates
 * page's ALWAYS-refusing Update button on private-ACR deployments: release
 * semver tags never land in the ACR — images are built per git SHA — so the
 * updater must be able to trigger the real image build+roll workflow).
 *
 * Everything is exercised with an injected fetch: the exact GitHub dispatch
 * payload is asserted (ref = the release tag, string-typed inputs), the
 * tag-ref → main fallback, the honest 403 (token lacks actions:write), and the
 * no-token gate. No network.
 */
import { describe, it, expect } from 'vitest';
import {
  readPipelineConfig,
  resolveDeployRegion,
  dispatchBuildRoll,
  getPipelineRunStatus,
  DEFAULT_BUILD_WORKFLOW,
  type PipelineConfig,
} from '../pipeline-dispatch';

function cfg(over: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    available: true,
    token: 'ghp_test',
    tokenEnv: 'LOOM_UPDATE_GITHUB_TOKEN',
    missingEnv: [],
    workflow: DEFAULT_BUILD_WORKFLOW,
    owner: 'fgarofalo56',
    repo: 'csa-inabox',
    monitorUrl: `https://github.com/fgarofalo56/csa-inabox/actions/workflows/${DEFAULT_BUILD_WORKFLOW}`,
    ...over,
  };
}

type Call = { url: string; init?: RequestInit };

function fetchStub(handler: (url: string, init?: RequestInit) => { status: number; json?: unknown; text?: string }) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const r = handler(url, init);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.json ?? {},
      text: async () => r.text ?? '',
    } as unknown as Response;
  };
  return { fn, calls };
}

describe('readPipelineConfig', () => {
  it('prefers the dedicated LOOM_UPDATE_GITHUB_TOKEN over the setup + feedback tokens', () => {
    const c = readPipelineConfig({
      LOOM_UPDATE_GITHUB_TOKEN: 'dedicated',
      LOOM_GITHUB_ACTIONS_TOKEN: 'setup',
      LOOM_FEEDBACK_GITHUB_TOKEN: 'feedback',
    });
    expect(c.available).toBe(true);
    expect(c.token).toBe('dedicated');
    expect(c.tokenEnv).toBe('LOOM_UPDATE_GITHUB_TOKEN');
  });

  it('falls back to LOOM_GITHUB_ACTIONS_TOKEN, then LOOM_FEEDBACK_GITHUB_TOKEN', () => {
    expect(readPipelineConfig({ LOOM_GITHUB_ACTIONS_TOKEN: 'setup' }).tokenEnv)
      .toBe('LOOM_GITHUB_ACTIONS_TOKEN');
    expect(readPipelineConfig({ LOOM_FEEDBACK_GITHUB_TOKEN: 'fb' }).tokenEnv)
      .toBe('LOOM_FEEDBACK_GITHUB_TOKEN');
  });

  it('is unavailable with the exact env fix-it when no token is set', () => {
    const c = readPipelineConfig({});
    expect(c.available).toBe(false);
    expect(c.missingEnv.join(' ')).toContain('LOOM_UPDATE_GITHUB_TOKEN');
    expect(c.workflow).toBe(DEFAULT_BUILD_WORKFLOW);
  });

  it('honors the workflow + repo overrides', () => {
    const c = readPipelineConfig({
      LOOM_UPDATE_GITHUB_TOKEN: 't',
      LOOM_UPDATE_BUILD_WORKFLOW: 'gov-console-roll.yml',
      LOOM_GITHUB_REPO_OWNER: 'someorg',
      LOOM_GITHUB_REPO_NAME: 'somefork',
    });
    expect(c.workflow).toBe('gov-console-roll.yml');
    expect(c.monitorUrl).toBe('https://github.com/someorg/somefork/actions/workflows/gov-console-roll.yml');
  });
});

describe('resolveDeployRegion', () => {
  it('prefers LOOM_LOCATION', () => {
    expect(resolveDeployRegion({ LOOM_LOCATION: 'centralus', LOOM_ACA_RG: 'rg-csa-loom-admin-eastus2' }))
      .toBe('centralus');
  });

  it('derives the region from the admin RG name when LOOM_LOCATION is unset', () => {
    expect(resolveDeployRegion({ LOOM_ACA_RG: 'rg-csa-loom-admin-centralus' })).toBe('centralus');
    expect(resolveDeployRegion({ LOOM_ADMIN_RG: 'rg-csa-loom-admin-usgovvirginia' })).toBe('usgovvirginia');
  });

  it('returns undefined when nothing resolves (workflow default applies)', () => {
    expect(resolveDeployRegion({})).toBeUndefined();
    expect(resolveDeployRegion({ LOOM_ACA_RG: 'rg-something-else' })).toBeUndefined();
  });
});

describe('dispatchBuildRoll', () => {
  it('POSTs the real workflow_dispatch at the RELEASE TAG ref with string inputs', async () => {
    const { fn, calls } = fetchStub(() => ({ status: 204 }));
    const res = await dispatchBuildRoll(cfg(), {
      imageVersion: '0.68.0',
      releaseTag: 'csa-inabox-v0.68.0',
      region: 'centralus',
      subscriptionId: 'sub-123',
    }, fn);
    expect(res.ok).toBe(true);
    expect(res.ref).toBe('csa-inabox-v0.68.0');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://api.github.com/repos/fgarofalo56/csa-inabox/actions/workflows/${DEFAULT_BUILD_WORKFLOW}/dispatches`,
    );
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.ref).toBe('csa-inabox-v0.68.0');
    // The GitHub REST API rejects non-string input values — assert strings.
    expect(body.inputs).toEqual({
      tag: '0.68.0',
      skip_build: 'false',
      enable_apps_after: 'true',
      region: 'centralus',
      subscription: 'sub-123',
    });
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ghp_test');
  });

  it('falls back to ref=main when the tag ref cannot be dispatched (422)', async () => {
    const { fn, calls } = fetchStub((_url, init) => {
      const ref = JSON.parse(String(init?.body)).ref;
      return ref === 'main' ? { status: 204 } : { status: 422, text: 'No ref found' };
    });
    const res = await dispatchBuildRoll(cfg(), { imageVersion: '0.68.0', releaseTag: 'csa-inabox-v0.68.0' }, fn);
    expect(res.ok).toBe(true);
    expect(res.ref).toBe('main');
    expect(calls).toHaveLength(2);
  });

  it('surfaces a 403 verbatim with the token-scope hint — never fakes a dispatch', async () => {
    const { fn, calls } = fetchStub(() => ({ status: 403, text: 'Resource not accessible' }));
    const res = await dispatchBuildRoll(cfg({ tokenEnv: 'LOOM_FEEDBACK_GITHUB_TOKEN' }), {
      imageVersion: '0.68.0', releaseTag: 'csa-inabox-v0.68.0',
    }, fn);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(res.error).toMatch(/actions:write/);
    expect(res.error).toMatch(/LOOM_FEEDBACK_GITHUB_TOKEN/);
    // Auth failures are terminal — no pointless main-ref retry.
    expect(calls).toHaveLength(1);
  });

  it('refuses honestly when no token is configured', async () => {
    const { fn, calls } = fetchStub(() => ({ status: 204 }));
    const res = await dispatchBuildRoll(
      cfg({ available: false, token: undefined, missingEnv: ['LOOM_UPDATE_GITHUB_TOKEN (or LOOM_GITHUB_ACTIONS_TOKEN)'] }),
      { imageVersion: '0.68.0', releaseTag: 'csa-inabox-v0.68.0' },
      fn,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/LOOM_UPDATE_GITHUB_TOKEN/);
    expect(calls).toHaveLength(0); // nothing was attempted
  });

  it('omits region/subscription inputs when unknown so the workflow defaults apply', async () => {
    const { fn, calls } = fetchStub(() => ({ status: 204 }));
    await dispatchBuildRoll(cfg(), { imageVersion: '0.68.0', releaseTag: 'csa-inabox-v0.68.0' }, fn);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(Object.keys(body.inputs).sort()).toEqual(['enable_apps_after', 'skip_build', 'tag']);
  });
});

describe('getPipelineRunStatus', () => {
  const run = (id: number, createdAt: string, status: string, conclusion: string | null = null) => ({
    id, created_at: createdAt, status, conclusion, html_url: `https://github.com/run/${id}`,
  });

  it('returns the newest run created at/after the dispatch timestamp', async () => {
    const { fn } = fetchStub(() => ({
      status: 200,
      json: {
        workflow_runs: [
          run(2, '2026-07-15T10:00:30Z', 'in_progress'),
          run(1, '2026-07-15T08:00:00Z', 'completed', 'success'), // stale prior run
        ],
      },
    }));
    const st = await getPipelineRunStatus(cfg(), '2026-07-15T10:00:00Z', fn);
    expect(st.ok).toBe(true);
    expect(st.runId).toBe(2);
    expect(st.status).toBe('in_progress');
  });

  it('reports pending (not a stale success) while the dispatched run has not materialized', async () => {
    const { fn } = fetchStub(() => ({
      status: 200,
      json: { workflow_runs: [run(1, '2026-07-15T08:00:00Z', 'completed', 'success')] },
    }));
    const st = await getPipelineRunStatus(cfg(), '2026-07-15T10:00:00Z', fn);
    expect(st.ok).toBe(true);
    expect(st.status).toBe('pending');
    expect(st.runId).toBeUndefined();
  });

  it('surfaces a GitHub API error honestly', async () => {
    const { fn } = fetchStub(() => ({ status: 401 }));
    const st = await getPipelineRunStatus(cfg(), undefined, fn);
    expect(st.ok).toBe(false);
    expect(st.error).toMatch(/401/);
  });
});
