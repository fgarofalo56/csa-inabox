import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fileParityGapIssue, listParityGapIssues, GITHUB_GATE_REASON } from '../parity-issue';
import { PARITY_AUTOPILOT_LABEL, type ShapedIssue } from '../parity-autopilot';

const shaped: ShapedIssue = {
  title: '[parity-autopilot] report: "Page nav" not visible on live surface',
  body: '<!-- parity-autopilot:report#2 -->\nbody text',
  labels: [PARITY_AUTOPILOT_LABEL],
  fingerprint: 'parity-autopilot:report#2',
};

const ORIG = { ...process.env };

describe('fileParityGapIssue', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.LOOM_FEEDBACK_REPO_OWNER = 'acme';
    process.env.LOOM_FEEDBACK_REPO_NAME = 'loom';
  });
  afterEach(() => {
    process.env = { ...ORIG };
  });

  it('honest-gates when LOOM_FEEDBACK_GITHUB_TOKEN is unset (no fetch, no throw)', async () => {
    delete process.env.LOOM_FEEDBACK_GITHUB_TOKEN;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await fileParityGapIssue(shaped);
    expect(r.gated).toBe(true);
    expect(r.reason).toBe(GITHUB_GATE_REASON);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dedupes against an already-open issue carrying the fingerprint (no create POST)', async () => {
    process.env.LOOM_FEEDBACK_GITHUB_TOKEN = 'tok';
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      calls.push(`${init?.method || 'GET'} ${String(url)}`);
      // The search returns a hit whose body contains the fingerprint.
      return new Response(
        JSON.stringify({ items: [{ number: 42, html_url: 'https://x/42', body: '<!-- parity-autopilot:report#2 -->' }] }),
        { status: 200 },
      );
    }));
    const r = await fileParityGapIssue(shaped);
    expect(r.deduped).toBe(true);
    expect(r.filed).toBe(false);
    expect(r.issueNumber).toBe(42);
    // Only the search call — never a POST /issues.
    expect(calls.some((c) => c.startsWith('POST') && c.includes('/issues'))).toBe(false);
  });

  it('files a new issue when none exists (real POST wiring, mocked transport)', async () => {
    process.env.LOOM_FEEDBACK_GITHUB_TOKEN = 'tok';
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      const u = String(url);
      if (u.includes('/search/issues')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (u.endsWith('/labels')) return new Response('{}', { status: 201 });
      if (u.endsWith('/issues')) {
        bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ number: 100, html_url: 'https://x/100' }), { status: 201 });
      }
      return new Response('{}', { status: 200 });
    }));
    const r = await fileParityGapIssue(shaped);
    expect(r.filed).toBe(true);
    expect(r.issueNumber).toBe(100);
    expect(r.issueUrl).toBe('https://x/100');
    // The POST carried the shaped title/body/labels verbatim.
    expect(bodies[0].title).toBe(shaped.title);
    expect(bodies[0].labels).toEqual([PARITY_AUTOPILOT_LABEL]);
  });

  it('reports a create failure honestly', async () => {
    process.env.LOOM_FEEDBACK_GITHUB_TOKEN = 'tok';
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/search/issues')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (u.endsWith('/labels')) return new Response('{}', { status: 201 });
      return new Response('nope', { status: 403 });
    }));
    const r = await fileParityGapIssue(shaped);
    expect(r.filed).toBeUndefined();
    expect(r.error).toContain('403');
  });
});

describe('listParityGapIssues', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { process.env = { ...ORIG }; });

  it('honest-gates without a token', async () => {
    delete process.env.LOOM_FEEDBACK_GITHUB_TOKEN;
    const r = await listParityGapIssues();
    expect(r.gated).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it('maps issues and drops PRs returned by the issues endpoint', async () => {
    process.env.LOOM_FEEDBACK_GITHUB_TOKEN = 'tok';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { number: 1, title: 'gap a', html_url: 'u1', created_at: '2026-07-20T00:00:00Z', updated_at: '2026-07-20T00:00:00Z', state: 'open' },
      { number: 2, title: 'a PR', html_url: 'u2', created_at: '2026-07-20T00:00:00Z', updated_at: '2026-07-20T00:00:00Z', state: 'open', pull_request: {} },
    ]), { status: 200 })));
    const r = await listParityGapIssues();
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].number).toBe(1);
  });
});
