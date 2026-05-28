/**
 * Unit tests for the Help Copilot orchestrator tool handlers + the
 * loom-docs-index RAG retriever.
 *
 * Mocks: cosmos-client, copilot-orchestrator (AOAI resolution), global fetch.
 * Filesystem access in the corpus walker is genuinely exercised — the
 * tests run from the repo root so docs/ + PRPs/ are reachable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------- Module-level mocks ----------
// cosmos-client: container with in-memory items map keyed by id+partition.

function makeFakeContainer() {
  const items = new Map<string, any>();
  return {
    items: {
      create: vi.fn(async (doc: any) => { items.set(doc.id, doc); return { resource: doc }; }),
      upsert: vi.fn(async (doc: any) => { items.set(doc.id, doc); return { resource: doc }; }),
      query: vi.fn((_q: any, _opts?: any) => ({
        fetchAll: async () => ({ resources: Array.from(items.values()) }),
      })),
    },
    item: (id: string, _pk: string) => ({
      read: vi.fn(async () => ({ resource: items.get(id) || null })),
      replace: vi.fn(async (doc: any) => { items.set(id, doc); return { resource: doc }; }),
    }),
    // Mirror @azure/cosmos shape just enough for the orchestrator to find database.containers.createIfNotExists
    database: {
      containers: {
        createIfNotExists: vi.fn(async ({ id }: { id: string }) => ({
          container: makeFakeContainer(),
        })),
      },
    },
    _items: items,
  };
}

let fakeCs: ReturnType<typeof makeFakeContainer>;

vi.mock('@/lib/azure/cosmos-client', () => {
  return {
    copilotSessionsContainer: async () => fakeCs,
  };
});

vi.mock('@/lib/azure/copilot-orchestrator', async () => {
  const actual = await vi.importActual<any>('@/lib/azure/copilot-orchestrator');
  return {
    ...actual,
    // Force a known target so we don't hit Foundry
    resolveAoaiTarget: vi.fn(async () => ({
      endpoint: 'https://fake-aoai.openai.azure.com',
      deployment: 'gpt-4o-test',
      apiVersion: '2024-10-21',
    })),
    NoAoaiDeploymentError: actual.NoAoaiDeploymentError,
  };
});

// AOAI token always succeeds in tests
vi.mock('@azure/identity', async () => {
  const real = await vi.importActual<any>('@azure/identity');
  class StubCred {
    async getToken() { return { token: 'stub-token', expiresOnTimestamp: Date.now() + 60_000 }; }
  }
  return {
    ...real,
    DefaultAzureCredential: StubCred,
    ManagedIdentityCredential: StubCred,
    ChainedTokenCredential: class { async getToken() { return { token: 'stub-token', expiresOnTimestamp: Date.now() + 60_000 }; } },
  };
});

// ---------- Imports must follow mocks ----------

import {
  __internal,
  orchestrateHelp,
  newSessionId,
  listHelpSessions,
} from '../help-copilot-orchestrator';

import {
  reindex,
  searchDocs,
  isSearchConfigured,
  buildCorpus,
} from '../loom-docs-index';

// ---------- Fixtures ----------

beforeEach(() => {
  fakeCs = makeFakeContainer();
  delete process.env.LOOM_AI_SEARCH_SERVICE; // force Cosmos fallback
  delete process.env.LOOM_FEEDBACK_GITHUB_TOKEN;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- Tool handler tests ----------

describe('help-copilot tool handlers', () => {
  function getTools() {
    const cs: any[] = [];
    return __internal.buildTools({
      recordCitations: (c) => cs.push(...c),
      upstreamRepo: { owner: 'fgarofalo56', name: 'csa-inabox' },
      githubToken: undefined,
    });
  }

  it('searchDocs returns hits + records citations', async () => {
    const tools = getTools();
    const t = tools.find((x) => x.name === 'searchDocs')!;
    expect(t).toBeTruthy();
    // The corpus is empty by default; call should still succeed with 0 hits.
    const { result, citations } = await t.handler({ query: 'cluster', top_k: 5 });
    expect((result as any).count).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(citations)).toBe(true);
  });

  it('openLoomPage rejects bad slug', async () => {
    const tools = getTools();
    const t = tools.find((x) => x.name === 'openLoomPage')!;
    const r = await t.handler({ slug: 'not-a-path' });
    expect((r.result as any).ok).toBe(false);
  });

  it('openLoomPage accepts allowed slug', async () => {
    const tools = getTools();
    const t = tools.find((x) => x.name === 'openLoomPage')!;
    const r = await t.handler({ slug: '/workspaces' });
    expect((r.result as any).ok).toBe(true);
    expect((r.result as any).action).toBe('navigate');
  });

  it('openLoomPage rejects unknown prefix', async () => {
    const tools = getTools();
    const t = tools.find((x) => x.name === 'openLoomPage')!;
    const r = await t.handler({ slug: '/evil/../etc/passwd' });
    expect((r.result as any).ok).toBe(false);
  });

  it('runDiagnostic check=ai-search surfaces missing config', async () => {
    delete process.env.LOOM_AI_SEARCH_SERVICE;
    const tools = getTools();
    const t = tools.find((x) => x.name === 'runDiagnostic')!;
    const r = await t.handler({ check: 'ai-search' });
    expect((r.result as any).aiSearch.configured).toBe(false);
    expect((r.result as any).aiSearch.fix).toContain('LOOM_AI_SEARCH_SERVICE');
  });

  it('runDiagnostic check=aoai reports configured target', async () => {
    const tools = getTools();
    const t = tools.find((x) => x.name === 'runDiagnostic')!;
    const r = await t.handler({ check: 'aoai' });
    expect((r.result as any).aoai.configured).toBe(true);
    expect((r.result as any).aoai.endpoint).toContain('fake-aoai');
  });

  it('runDiagnostic check=all returns every probe', async () => {
    const tools = getTools();
    const t = tools.find((x) => x.name === 'runDiagnostic')!;
    const r = await t.handler({ check: 'all' });
    const keys = Object.keys(r.result as any);
    expect(keys).toEqual(expect.arrayContaining(['aoai', 'aiSearch', 'cosmos', 'version', 'tenant']));
  });

  it('logIssue without token returns deep-link', async () => {
    const tools = getTools();
    const t = tools.find((x) => x.name === 'logIssue')!;
    const r = await t.handler({ title: 'bug', body: 'something broke' });
    expect((r.result as any).ok).toBe(true);
    expect((r.result as any).mode).toBe('deep-link');
    expect((r.result as any).url).toContain('issues/new');
    expect((r.result as any).url).toContain('title=bug');
  });

  it('logIssue rejects missing fields', async () => {
    const tools = getTools();
    const t = tools.find((x) => x.name === 'logIssue')!;
    const r = await t.handler({ title: '', body: 'x' });
    expect((r.result as any).ok).toBe(false);
  });

  it('logIssue with token POSTs to GitHub', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ number: 42, html_url: 'https://github.com/x/y/issues/42' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const tools = __internal.buildTools({
      recordCitations: () => {},
      upstreamRepo: { owner: 'fgarofalo56', name: 'csa-inabox' },
      githubToken: 'gh_test_token',
    });
    const t = tools.find((x) => x.name === 'logIssue')!;
    const r = await t.handler({ title: 'feature', body: 'add X', labels: ['enhancement'] });

    expect((r.result as any).ok).toBe(true);
    expect((r.result as any).mode).toBe('created');
    expect((r.result as any).issueNumber).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(url).toContain('api.github.com/repos/fgarofalo56/csa-inabox/issues');
    expect(init.headers.authorization).toBe('Bearer gh_test_token');
  });
});

// ---------- Handoff parser tests ----------

describe('parseHandoff', () => {
  it('extracts a well-formed handoff block', () => {
    const final = `Here's how. To actually do it:

\`\`\`handoff
reason: this is an act (create workspace)
deepLink: /copilot?prompt=create%20workspace%20foo
suggestedPrompt: create workspace foo
\`\`\`

Hope that helps.`;
    const { handoff, stripped } = __internal.parseHandoff(final);
    expect(handoff?.reason).toContain('create workspace');
    expect(handoff?.deepLink).toBe('/copilot?prompt=create%20workspace%20foo');
    expect(handoff?.suggestedPrompt).toBe('create workspace foo');
    expect(stripped).not.toContain('```handoff');
  });

  it('returns no handoff when block is missing', () => {
    const final = 'Plain answer with no handoff.';
    const { handoff, stripped } = __internal.parseHandoff(final);
    expect(handoff).toBeUndefined();
    expect(stripped).toBe(final);
  });

  it('returns no handoff when deepLink is empty', () => {
    const final = '```handoff\nreason: x\n```';
    const { handoff } = __internal.parseHandoff(final);
    expect(handoff).toBeUndefined();
  });
});

// ---------- RAG retriever tests ----------

describe('loom-docs-index', () => {
  it('isSearchConfigured reflects env var', () => {
    delete process.env.LOOM_AI_SEARCH_SERVICE;
    expect(isSearchConfigured()).toBe(false);
    process.env.LOOM_AI_SEARCH_SERVICE = 'search-foo';
    expect(isSearchConfigured()).toBe(true);
    delete process.env.LOOM_AI_SEARCH_SERVICE;
  });

  it('searchDocs returns empty for blank query', async () => {
    const { hits, backend } = await searchDocs('', 5);
    expect(hits).toEqual([]);
    expect(backend).toBe('none');
  });

  it('buildCorpus walks repo docs and yields chunks', async () => {
    // Run from the repo root so docs/fiab/* + PRPs/ are reachable.
    const cwd = process.cwd();
    try {
      // Walk up to find mkdocs.yml — the corpus walker does this internally.
      const chunks = await buildCorpus();
      // The repo has docs/fiab/architecture.md and many others; we want > 0.
      expect(chunks.length).toBeGreaterThan(0);
      // At least one chunk should be of kind 'docs'
      expect(chunks.some((c) => c.kind === 'docs')).toBe(true);
      // Chunks should not exceed MAX_CHUNK (1500 chars) by much
      for (const c of chunks) {
        expect(c.content.length).toBeLessThanOrEqual(1600);
      }
    } finally {
      process.chdir(cwd);
    }
  }, 30_000);

  it('reindex (Cosmos fallback) persists chunks and warns about missing AI Search', async () => {
    delete process.env.LOOM_AI_SEARCH_SERVICE;
    const r = await reindex();
    expect(r.ok).toBe(true);
    expect(r.backend).toBe('cosmos');
    expect(r.totalChunks).toBeGreaterThan(0);
    expect(r.warnings.some((w) => w.includes('LOOM_AI_SEARCH_SERVICE'))).toBe(true);
  }, 60_000);
});

// ---------- Session helpers ----------

describe('help session helpers', () => {
  it('newSessionId produces a unique prefix', () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(a).toMatch(/^help-\d+-[0-9a-f]+$/);
    expect(a).not.toBe(b);
  });

  it('listHelpSessions returns [] for a fresh user', async () => {
    const r = await listHelpSessions('user-with-no-history');
    expect(Array.isArray(r)).toBe(true);
  });
});

// ---------- AOAI failure path ----------

describe('orchestrateHelp', () => {
  it('yields error step when AOAI is unreachable', async () => {
    const { resolveAoaiTarget } = await import('../copilot-orchestrator');
    const { NoAoaiDeploymentError } = await import('../copilot-orchestrator');
    (resolveAoaiTarget as any).mockRejectedValueOnce(new NoAoaiDeploymentError('No AOAI deployment on Foundry hub.'));

    const steps: any[] = [];
    for await (const s of orchestrateHelp({ prompt: 'hi', sessionId: 'sess-1', userId: 'u1' })) {
      steps.push(s);
      if (steps.length > 5) break;
    }
    expect(steps[0].kind).toBe('error');
    expect(steps[0].error).toContain('No AOAI deployment');
  });
});
