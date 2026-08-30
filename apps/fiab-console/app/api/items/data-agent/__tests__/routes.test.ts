/**
 * Backend contract tests for the data-agent lifecycle BFF routes:
 *
 *   GET    /api/items/data-agent        list the tenant's data agents
 *   POST   /api/items/data-agent        create a new agent OR duplicate (from)
 *   DELETE /api/items/data-agent/[id]   delete + de-provision published backing
 *
 * Cosmos + the opt-in published backings (Foundry Agent Service / Copilot
 * Studio) are mocked at the client boundary; these pin the route contract:
 * auth gate, create/duplicate payload shaping (publish-only leaves stripped on
 * a clone), and best-effort de-provision on delete (a failing remote delete
 * never blocks the local delete — Azure-native default). See no-vaporware.md +
 * no-fabric-dependency.md.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

vi.mock('@/app/api/items/_lib/item-crud', () => ({
  createOwnedItem: vi.fn(),
  listOwnedItems: vi.fn(),
  loadOwnedItem: vi.fn(),
  updateOwnedItem: vi.fn(),
  deleteOwnedItem: vi.fn(),
  jerr: (error: string, status = 500) =>
    ({ status, json: async () => ({ ok: false, error }) }) as any,
}));

vi.mock('@/lib/azure/foundry-agent-client', () => ({
  deleteAgent: vi.fn(),
}));

// Keep the real pure helpers (coerceM365AuthMode / coerceM365IdentityMode /
// CopilotStudioError) so the m365-copilot route's coercion + gating logic is
// genuinely exercised; only the network-touching publish/env calls are stubbed.
vi.mock('@/lib/azure/copilot-studio-client', async (importActual) => {
  const actual = await importActual<any>();
  return {
    ...actual,
    deleteAgent: vi.fn(),
    listEnvironments: vi.fn(async () => []),
    resolvePublishEnvId: vi.fn(),
    publishToM365Copilot: vi.fn(),
  };
});

// Cosmos receipt-persistence is best-effort (wrapped in try/catch in the route);
// stub the container so no real Cosmos connection is attempted.
// `copilotSessionsContainer` is the conversations route's store — stubbed per
// test below rather than once here, because those tests turn on WHAT the
// container already holds at the caller-supplied id.
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({
    item: () => ({ replace: vi.fn(async () => ({})) }),
  })),
  copilotSessionsContainer: vi.fn(),
}));

import { getSession } from '@/lib/auth/session';
import {
  createOwnedItem, listOwnedItems, loadOwnedItem, deleteOwnedItem,
} from '@/app/api/items/_lib/item-crud';
import { deleteAgent as deleteFoundryAgent } from '@/lib/azure/foundry-agent-client';
import {
  deleteAgent as deleteCopilotStudioAgent,
  publishToM365Copilot,
  resolvePublishEnvId,
} from '@/lib/azure/copilot-studio-client';

import { copilotSessionsContainer } from '@/lib/azure/cosmos-client';

import { GET as LIST, POST as CREATE } from '../route';
import { DELETE as DEL } from '../[id]/route';
import { POST as M365_PUBLISH } from '../[id]/m365-copilot/route';
import {
  GET as CONV_GET,
  POST as CONV_POST,
  DELETE as CONV_DEL,
} from '../[id]/conversations/route';

const AUTH = { claims: { oid: 'tenant-1', upn: 'u@x' } };

function jsonReq(body: any) {
  return { json: async () => body } as any;
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => { vi.resetAllMocks(); });

// ---------------- GET (list) ----------------
describe('GET /api/items/data-agent', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await LIST();
    expect(res.status).toBe(401);
  });

  it('lists the tenant data agents with state preserved for status/source derivation', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (listOwnedItems as any).mockResolvedValue([
      { id: 'da1', workspaceId: 'ws1', displayName: 'Revenue', state: { sources: [{ id: 's', type: 'warehouse', name: 'w' }], publishedAt: '2026-01-01' }, updatedAt: '2026-02-01' },
    ]);
    const res = await LIST();
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.items).toHaveLength(1);
    expect(j.items[0].state.sources).toHaveLength(1);
    expect(j.items[0].state.publishedAt).toBe('2026-01-01');
  });
});

// ---------------- POST (create) ----------------
describe('POST /api/items/data-agent (create)', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await CREATE(jsonReq({ workspaceId: 'ws1', displayName: 'x' }));
    expect(res.status).toBe(401);
  });

  it('creates a fresh draft agent with empty typed sources', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (createOwnedItem as any).mockResolvedValue({ ok: true, item: { id: 'new1', displayName: 'x' } });
    const res = await CREATE(jsonReq({ workspaceId: 'ws1', displayName: 'New Agent' }));
    const j = await res.json();
    expect(res.status).toBe(201);
    expect(j.ok).toBe(true);
    expect(createOwnedItem).toHaveBeenCalledWith(
      AUTH, 'data-agent',
      expect.objectContaining({ workspaceId: 'ws1', displayName: 'New Agent', state: { sources: [], instructions: '' } }),
    );
  });

  it('passes the create-helper error through (e.g. workspace not found)', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (createOwnedItem as any).mockResolvedValue({ ok: false, status: 404, error: 'workspace not found' });
    const res = await CREATE(jsonReq({ workspaceId: 'bad', displayName: 'x' }));
    expect(res.status).toBe(404);
  });
});

// ---------------- POST (duplicate) ----------------
describe('POST /api/items/data-agent (duplicate)', () => {
  it('clones config but strips publish-only leaves (publishedAt / foundryAgentId / m365Copilot)', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (loadOwnedItem as any).mockResolvedValue({
      id: 'src1', workspaceId: 'wsA', displayName: 'Origin', description: 'd',
      state: {
        instructions: 'route to warehouse',
        sources: [{ id: 's1', type: 'warehouse', name: 'W' }],
        publishedAt: '2026-01-01',
        foundryAgentId: 'loom-data-src1',
        m365Copilot: { envId: 'e', agentId: 'a', publishedAt: '2026-01-02' },
      },
    });
    (createOwnedItem as any).mockResolvedValue({ ok: true, item: { id: 'dup1' } });
    const res = await CREATE(jsonReq({ from: 'src1' }));
    const j = await res.json();
    expect(res.status).toBe(201);
    expect(j.ok).toBe(true);
    expect(j.duplicatedFrom).toBe('src1');
    const passed = (createOwnedItem as any).mock.calls[0][2];
    expect(passed.workspaceId).toBe('wsA');
    expect(passed.displayName).toBe('Origin (copy)');
    expect(passed.state.instructions).toBe('route to warehouse');
    expect(passed.state.sources).toHaveLength(1);
    expect(passed.state.publishedAt).toBeUndefined();
    expect(passed.state.foundryAgentId).toBeUndefined();
    expect(passed.state.m365Copilot).toBeUndefined();
  });

  it('404 when the source agent is not owned', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (loadOwnedItem as any).mockResolvedValue(null);
    const res = await CREATE(jsonReq({ from: 'ghost' }));
    expect(res.status).toBe(404);
  });
});

// ---------------- DELETE (+ de-provision) ----------------
describe('DELETE /api/items/data-agent/[id]', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await DEL({} as any, ctx('da1'));
    expect(res.status).toBe(401);
  });

  it('de-provisions the published Foundry + M365 backing then deletes the item', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (loadOwnedItem as any).mockResolvedValue({
      id: 'da1', workspaceId: 'ws1', displayName: 'Pub',
      state: { foundryAgentId: 'loom-data-da1', m365Copilot: { envId: 'env1', agentId: 'agentX' } },
    });
    (deleteFoundryAgent as any).mockResolvedValue(undefined);
    (deleteCopilotStudioAgent as any).mockResolvedValue(undefined);
    (deleteOwnedItem as any).mockResolvedValue(true);

    const res = await DEL({} as any, ctx('da1'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(deleteFoundryAgent).toHaveBeenCalledWith('', 'loom-data-da1');
    expect(deleteCopilotStudioAgent).toHaveBeenCalledWith('env1', 'agentX');
    expect(deleteOwnedItem).toHaveBeenCalledWith('da1', 'data-agent', 'tenant-1');
    expect(j.deprovisioned.foundry).toBe('deleted');
    expect(j.deprovisioned.m365).toBe('deleted');
  });

  it('still deletes the item when remote de-provision fails (best-effort)', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (loadOwnedItem as any).mockResolvedValue({
      id: 'da1', workspaceId: 'ws1', displayName: 'Pub',
      state: { foundryAgentId: 'loom-data-da1' },
    });
    (deleteFoundryAgent as any).mockRejectedValue(new Error('not configured'));
    (deleteOwnedItem as any).mockResolvedValue(true);

    const res = await DEL({} as any, ctx('da1'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(deleteOwnedItem).toHaveBeenCalled();
    expect(j.deprovisioned.foundry).toMatch(/skipped/);
  });

  it('is a no-op success when the item is already gone', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (loadOwnedItem as any).mockResolvedValue(null);
    const res = await DEL({} as any, ctx('ghost'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(deleteOwnedItem).not.toHaveBeenCalled();
  });

  it('skips de-provision for a draft (no published backing) and just deletes', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (loadOwnedItem as any).mockResolvedValue({
      id: 'da1', workspaceId: 'ws1', displayName: 'Draft', state: { sources: [] },
    });
    (deleteOwnedItem as any).mockResolvedValue(true);
    const res = await DEL({} as any, ctx('da1'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(deleteFoundryAgent).not.toHaveBeenCalled();
    expect(deleteCopilotStudioAgent).not.toHaveBeenCalled();
    expect(deleteOwnedItem).toHaveBeenCalled();
  });
});

// ---------------- POST /[id]/m365-copilot (G6 agentic-publish depth) ----------------
describe('POST /api/items/data-agent/[id]/m365-copilot', () => {
  const PUBLISHABLE_ITEM = {
    id: 'da1', workspaceId: 'ws1', displayName: 'Revenue Agent',
    state: {
      instructions: 'Route revenue questions to the warehouse.',
      sources: [{ id: 's1', type: 'warehouse', name: 'Sales WH' }],
      model: 'gpt-4o-mini',
    },
  };
  const PUBLISH_RESULT = {
    envId: 'env-1', agentId: 'agent-1', agentName: 'Revenue Agent', agentState: 'Published',
    channelId: 'chan-1', channelEnabled: true, m365CopilotEnabled: true,
    descriptionForModel: 'Use for governed sales data', deliverAsIs: true,
    connectedAgent: true, authMode: 'entra', identityMode: 'user',
    adminCenterUrl: 'https://admin.microsoft.com/',
  };

  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await M365_PUBLISH(jsonReq({}), ctx('da1'));
    expect(res.status).toBe(401);
  });

  it('threads descriptionForModel / deliverAsIs / authMode / identityMode into the publish call and weaves the directives into the composed instructions', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (loadOwnedItem as any).mockResolvedValue(PUBLISHABLE_ITEM);
    (resolvePublishEnvId as any).mockReturnValue('env-1');
    (publishToM365Copilot as any).mockResolvedValue(PUBLISH_RESULT);

    const res = await M365_PUBLISH(
      jsonReq({
        envId: 'env-1',
        descriptionForModel: 'Use for governed sales data',
        deliverAsIs: true,
        connectedAgent: true,
        authMode: 'entra',
        identityMode: 'user',
      }),
      ctx('da1'),
    );
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);

    expect(publishToM365Copilot).toHaveBeenCalledTimes(1);
    const [passedEnvId, input] = (publishToM365Copilot as any).mock.calls[0];
    expect(passedEnvId).toBe('env-1');
    expect(input.descriptionForModel).toBe('Use for governed sales data');
    expect(input.deliverAsIs).toBe(true);
    expect(input.connectedAgent).toBe(true);
    expect(input.authMode).toBe('entra');
    expect(input.identityMode).toBe('user');
    // item #3: deliver-as-is directive is a real behavior change written into
    // the agent's msdyn_instructions, not just a stored flag.
    expect(input.instructions).toMatch(/deliver this agent's answer to the user exactly as produced/i);
    // item #2: model-facing description is woven into the same instructions.
    expect(input.instructions).toContain('Use for governed sales data');
    expect(input.instructions).toMatch(/when to route to this agent/i);
  });

  it("defaults identityMode to 'agent-author' and coerces an unknown authMode to 'none'", async () => {
    (getSession as any).mockReturnValue(AUTH);
    (loadOwnedItem as any).mockResolvedValue(PUBLISHABLE_ITEM);
    (resolvePublishEnvId as any).mockReturnValue('env-1');
    (publishToM365Copilot as any).mockResolvedValue({
      ...PUBLISH_RESULT, authMode: 'none', identityMode: 'agent-author', deliverAsIs: false,
    });

    const res = await M365_PUBLISH(
      jsonReq({ envId: 'env-1', authMode: 'bogus' }),
      ctx('da1'),
    );
    expect(res.status).toBe(200);
    const [, input] = (publishToM365Copilot as any).mock.calls[0];
    expect(input.authMode).toBe('none');
    expect(input.identityMode).toBe('agent-author');
    // deliver-as-is off → no directive baked into the instructions.
    expect(input.instructions).not.toMatch(/exactly as produced/i);
  });

  it('honest 501 gate (never calls publish) when no Power Platform env is configured', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (loadOwnedItem as any).mockResolvedValue(PUBLISHABLE_ITEM);
    (resolvePublishEnvId as any).mockReturnValue(null);

    const res = await M365_PUBLISH(jsonReq({}), ctx('da1'));
    const j = await res.json();
    expect(res.status).toBe(501);
    expect(j.ok).toBe(false);
    expect(j.hint).toMatch(/LOOM_COPILOT_STUDIO_ENVIRONMENT_ID/);
    expect(publishToM365Copilot).not.toHaveBeenCalled();
  });

  it('400 when the agent has no instructions to publish', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (loadOwnedItem as any).mockResolvedValue({
      ...PUBLISHABLE_ITEM, state: { instructions: '', sources: PUBLISHABLE_ITEM.state.sources },
    });
    const res = await M365_PUBLISH(jsonReq({ envId: 'env-1' }), ctx('da1'));
    expect(res.status).toBe(400);
    expect(publishToM365Copilot).not.toHaveBeenCalled();
  });
});

// ---------------- [id]/conversations (GET / POST / DELETE) ----------------
//
// #4009: this route had ZERO coverage. Three handlers were migrated to
// `withSession` and two ownership guards were flipped to a POSITIVE match
// (#3943) with nothing asserting any of it — so a regression that restored the
// permissive `resource.userOid && resource.userOid !== caller` short-circuit
// would have been caught by nothing.
//
// #4005 is the third arm: POST was an UNCHECKED upsert over a CALLER-SUPPLIED
// `conversationId`, so a caller who knew a victim's conversation id overwrote
// its messages AND rewrote `userOid` to themselves. The POST arms below are the
// pin for that fix; they FAIL against the pre-fix handler.
//
// The OWNERLESS arm is the property that distinguishes a positive match from a
// permissive one, and it is asserted on all three verbs.
describe('/api/items/data-agent/[id]/conversations', () => {
  const OWN = 'tenant-1';       // AUTH.claims.oid — the caller
  const OTHER = 'someone-else'; // a different user's oid
  const CONV = 'conv-1';

  /** A fake copilotSessions container whose point read returns `doc` (or throws). */
  function fakeStore(doc: any | null, readError?: any) {
    const read = vi.fn(async () => {
      if (readError) throw readError;
      return { resource: doc };
    });
    const del = vi.fn(async () => ({}));
    const upsert = vi.fn(async (d: any) => ({ resource: d }));
    const fetchAll = vi.fn(async () => ({ resources: [] }));
    const query = vi.fn(() => ({ fetchAll }));
    const container = {
      item: vi.fn(() => ({ read, delete: del })),
      items: { upsert, query },
    };
    (copilotSessionsContainer as any).mockResolvedValue(container);
    return { container, read, del, upsert, query, fetchAll };
  }

  function convReq(search = '', body?: any) {
    return {
      nextUrl: new URL(`http://x/api/items/data-agent/da1/conversations${search}`),
      json: async () => body ?? {},
    } as any;
  }

  const stored = (userOid: string | undefined) => ({
    id: CONV,
    sessionId: `da:da1:${CONV}`,
    kind: 'data-agent-conversation',
    ...(userOid === undefined ? {} : { userOid }),
    agentId: 'da1',
    title: 'Victim conversation',
    messages: [{ role: 'user', content: 'private' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  // ---- GET ----
  it('GET 401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await CONV_GET(convReq(`?conversationId=${CONV}`), ctx('da1'));
    expect(res.status).toBe(401);
  });

  it('GET returns the conversation when the caller owns it', async () => {
    (getSession as any).mockReturnValue(AUTH);
    fakeStore(stored(OWN));
    const res = await CONV_GET(convReq(`?conversationId=${CONV}`), ctx('da1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.conversation.id).toBe(CONV);
  });

  it('GET 403 when the conversation belongs to someone else', async () => {
    (getSession as any).mockReturnValue(AUTH);
    fakeStore(stored(OTHER));
    const res = await CONV_GET(convReq(`?conversationId=${CONV}`), ctx('da1'));
    expect(res.status).toBe(403);
  });

  it('GET 403 on an OWNERLESS document — the positive-match property (#3943)', async () => {
    (getSession as any).mockReturnValue(AUTH);
    fakeStore(stored(undefined));
    const res = await CONV_GET(convReq(`?conversationId=${CONV}`), ctx('da1'));
    expect(res.status).toBe(403);
  });

  it('GET 404 when no such conversation exists', async () => {
    (getSession as any).mockReturnValue(AUTH);
    fakeStore(null);
    const res = await CONV_GET(convReq(`?conversationId=${CONV}`), ctx('da1'));
    expect(res.status).toBe(404);
  });

  // ---- DELETE ----
  it('DELETE 401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await CONV_DEL(convReq(`?conversationId=${CONV}`), ctx('da1'));
    expect(res.status).toBe(401);
  });

  it('DELETE removes the conversation the caller owns', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const s = fakeStore(stored(OWN));
    const res = await CONV_DEL(convReq(`?conversationId=${CONV}`), ctx('da1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(s.del).toHaveBeenCalledTimes(1);
  });

  it("DELETE 403 and does NOT delete someone else's conversation", async () => {
    (getSession as any).mockReturnValue(AUTH);
    const s = fakeStore(stored(OTHER));
    const res = await CONV_DEL(convReq(`?conversationId=${CONV}`), ctx('da1'));
    expect(res.status).toBe(403);
    expect(s.del).not.toHaveBeenCalled();
  });

  it('DELETE 403 on an OWNERLESS document — the positive-match property (#3943)', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const s = fakeStore(stored(undefined));
    const res = await CONV_DEL(convReq(`?conversationId=${CONV}`), ctx('da1'));
    expect(res.status).toBe(403);
    expect(s.del).not.toHaveBeenCalled();
  });

  // ---- POST (the #4005 write path) ----
  it('POST 401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await CONV_POST(convReq('', { messages: [{ role: 'user', content: 'hi' }] }), ctx('da1'));
    expect(res.status).toBe(401);
  });

  it('POST creates when no document exists at the id', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const s = fakeStore(null);
    const res = await CONV_POST(
      convReq('', { conversationId: CONV, messages: [{ role: 'user', content: 'hi' }] }),
      ctx('da1'),
    );
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(s.upsert).toHaveBeenCalledTimes(1);
    expect(s.upsert.mock.calls[0][0].userOid).toBe(OWN);
  });

  it('POST creates when the point read 404s — absence, not a failure', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const s = fakeStore(null, Object.assign(new Error('NotFound'), { code: 404 }));
    const res = await CONV_POST(
      convReq('', { conversationId: CONV, messages: [{ role: 'user', content: 'hi' }] }),
      ctx('da1'),
    );
    expect(res.status).toBe(200);
    expect(s.upsert).toHaveBeenCalledTimes(1);
  });

  it("POST updates the caller's own conversation and preserves its createdAt", async () => {
    (getSession as any).mockReturnValue(AUTH);
    const s = fakeStore(stored(OWN));
    const res = await CONV_POST(
      convReq('', { conversationId: CONV, createdAt: '2099-01-01T00:00:00.000Z', messages: [{ role: 'user', content: 'more' }] }),
      ctx('da1'),
    );
    expect(res.status).toBe(200);
    expect(s.upsert).toHaveBeenCalledTimes(1);
    // The body must not be able to rewrite the creation time of an existing row.
    expect(s.upsert.mock.calls[0][0].createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it("POST 403 over ANOTHER user's conversation, and writes NOTHING (#4005)", async () => {
    (getSession as any).mockReturnValue(AUTH);
    const s = fakeStore(stored(OTHER));
    const res = await CONV_POST(
      convReq('', { conversationId: CONV, messages: [{ role: 'user', content: 'takeover' }] }),
      ctx('da1'),
    );
    expect(res.status).toBe(403);
    // The teeth: no overwrite of the victim's messages, and no ownership transfer.
    expect(s.upsert).not.toHaveBeenCalled();
  });

  it('POST 403 over an OWNERLESS document — an unowned row is not adoptable (#4005)', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const s = fakeStore(stored(undefined));
    const res = await CONV_POST(
      convReq('', { conversationId: CONV, messages: [{ role: 'user', content: 'adopt' }] }),
      ctx('da1'),
    );
    expect(res.status).toBe(403);
    expect(s.upsert).not.toHaveBeenCalled();
  });

  it('POST 502 and writes NOTHING when the ownership read fails for a non-404 reason (R7)', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const s = fakeStore(null, Object.assign(new Error('service unavailable'), { code: 503 }));
    const res = await CONV_POST(
      convReq('', { conversationId: CONV, messages: [{ role: 'user', content: 'hi' }] }),
      ctx('da1'),
    );
    const j = await res.json();
    expect(res.status).toBe(502);
    expect(j.ok).toBe(false);
    // An UNREADABLE document is not an UNOWNED one — falling through to the
    // upsert would turn a transient Cosmos error into the overwrite above.
    expect(s.upsert).not.toHaveBeenCalled();
  });

  it('POST 400 with no messages', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const s = fakeStore(null);
    const res = await CONV_POST(convReq('', { messages: [] }), ctx('da1'));
    expect(res.status).toBe(400);
    expect(s.upsert).not.toHaveBeenCalled();
  });
});
