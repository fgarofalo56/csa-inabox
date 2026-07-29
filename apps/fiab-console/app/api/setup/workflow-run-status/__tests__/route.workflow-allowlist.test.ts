/**
 * GET /api/setup/workflow-run-status — the `workflow` query param lands in the
 * PATH of a GitHub REST URL that carries LOOM_GITHUB_ACTIONS_TOKEN (a PAT that
 * can dispatch Loom deployment workflows). Un-validated it normalised into a
 * DIFFERENT GitHub endpoint, so any authenticated Loom user could aim the
 * deployment PAT at arbitrary GitHub API paths (issue #2652, CodeQL alert 368).
 *
 * Hermetic: session mocked, `fetch` captured so the assertions are on the ACTUAL
 * outbound URL.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({ claims: { oid: 'o1', tid: 't1', groups: [] }, exp: Date.now() / 1000 + 3600 }),
}));

import { GET } from '../route';

const reqFor = (qs: string) =>
  ({ nextUrl: new URL(`https://console.example/api/setup/workflow-run-status${qs}`) }) as any;

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LOOM_GITHUB_ACTIONS_TOKEN = 'ghp_DEPLOY_PAT';
  fetchSpy = vi.fn(async () => new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LOOM_GITHUB_ACTIONS_TOKEN;
});

describe('workflow param may only name a Loom deployment workflow', () => {
  it('polls the real run URL for an allow-listed workflow', async () => {
    const res = await GET(reqFor('?workflow=deploy-fiab-commercial.yml'));
    expect(res.status).toBe(200);
    expect(String(fetchSpy.mock.calls[0][0])).toContain(
      '/actions/workflows/deploy-fiab-commercial.yml/runs',
    );
  });

  it.each([
    ['traversal to another GitHub endpoint', '../../../../../user/repos'],
    ['encoded traversal', '..%2F..%2F..%2F..%2Fuser'],
    ['query smuggling that truncates the path', 'x?per_page=1'],
    ['fragment truncation', 'x%23'],
    ['an absolute URL', 'https://attacker.example/x'],
    ['a plausible but unknown workflow file', 'release-please.yml'],
    ['empty', ''],
  ])('rejects %s without any outbound request', async (_label, workflow) => {
    const res = await GET(reqFor(`?workflow=${encodeURIComponent(workflow)}`));
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the deployment PAT never reaches a non-allow-listed path', async () => {
    await GET(reqFor('?workflow=..%2F..%2F..%2F..%2Fuser'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
