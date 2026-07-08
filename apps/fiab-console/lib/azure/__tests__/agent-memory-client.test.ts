/**
 * AIF-14 — durable agent memory + per-agent thread persistence.
 *
 * Verifies thread save/list/get/delete + retention cap and memory
 * extract/retrieve/preamble against a fake Cosmos container and a mocked AOAI
 * summarizer — zero real Azure calls, no Fabric dependency.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The memory client summarizes completed runs via the unified AOAI client.
const aoaiChatJsonMock = vi.fn();
vi.mock('../aoai-chat-client', () => ({
  aoaiChatJson: (...args: any[]) => aoaiChatJsonMock(...args),
}));

// Fake Cosmos container emulating the specific queries the client issues
// (docType filter + ORDER BY createdAt DESC + OFFSET/LIMIT).
const docs = new Map<string, any>();

function fakeContainer() {
  return {
    items: {
      upsert: async (doc: any) => { docs.set(doc.id, doc); return { resource: doc }; },
      create: async (doc: any) => { docs.set(doc.id, doc); return { resource: doc }; },
      query: (spec: any) => ({
        fetchAll: async () => {
          const p = Object.fromEntries((spec.parameters || []).map((x: any) => [x.name, x.value]));
          const wantMemory = /docType = 'memory'/.test(spec.query);
          const docType = wantMemory ? 'memory' : 'thread';
          let rows = Array.from(docs.values())
            .filter((d) => d.agentId === p['@a'] && d.userOid === p['@u'] && d.docType === docType)
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // DESC
          const offset = spec.query.includes('OFFSET @cap') ? (p['@cap'] ?? 0) : 0;
          const limit = p['@n'] ?? 1000;
          rows = rows.slice(offset, offset + limit);
          const idOnly = /SELECT c\.id/.test(spec.query);
          return { resources: idOnly ? rows.map((r) => ({ id: r.id })) : rows };
        },
      }),
    },
    item: (id: string, _pk: string) => ({
      read: async () => ({ resource: docs.get(id) }),
      delete: async () => { docs.delete(id); return {}; },
    }),
  };
}

vi.mock('../cosmos-client', () => ({
  agentMemoryContainer: async () => fakeContainer(),
}));

import {
  saveThread, listThreads, getThread, deleteThread,
  extractAndStoreMemory, retrieveMemories, memoryPreamble,
} from '../agent-memory-client';

const AGENT = 'finance-assistant';
const USER = '11111111-1111-1111-1111-111111111111';

beforeEach(() => { docs.clear(); aoaiChatJsonMock.mockReset(); });
afterEach(() => { delete process.env.LOOM_AGENT_THREAD_CAP; });

describe('thread persistence', () => {
  it('saves and lists a thread newest-first', async () => {
    await saveThread({ agentId: AGENT, userOid: USER, threadId: 't1', status: 'completed', question: 'Q1', answer: 'A1' });
    await saveThread({ agentId: AGENT, userOid: USER, threadId: 't2', status: 'completed', question: 'Q2', answer: 'A2' });
    const list = await listThreads(AGENT, USER);
    expect(list.map((t) => t.threadId)).toEqual(['t2', 't1']);
    expect(list[0].docType).toBe('thread');
  });

  it('scopes threads to the owning user', async () => {
    await saveThread({ agentId: AGENT, userOid: USER, threadId: 't1', status: 'completed', question: 'Q', answer: 'A' });
    await saveThread({ agentId: AGENT, userOid: 'other-user', threadId: 't2', status: 'completed', question: 'Q', answer: 'A' });
    expect((await listThreads(AGENT, USER)).map((t) => t.threadId)).toEqual(['t1']);
  });

  it('gets one thread and rejects a cross-user read', async () => {
    await saveThread({ agentId: AGENT, userOid: USER, threadId: 't1', status: 'completed', question: 'Q', answer: 'A', steps: [{ id: 's1' }] });
    expect((await getThread(AGENT, USER, 't1'))?.answer).toBe('A');
    expect(await getThread(AGENT, 'someone-else', 't1')).toBeNull();
  });

  it('deletes a thread', async () => {
    await saveThread({ agentId: AGENT, userOid: USER, threadId: 't1', status: 'completed', question: 'Q', answer: 'A' });
    expect(await deleteThread(AGENT, USER, 't1')).toBe(true);
    expect(await listThreads(AGENT, USER)).toHaveLength(0);
    expect(await deleteThread(AGENT, USER, 't1')).toBe(false);
  });

  it('enforces the retention cap (oldest evicted)', async () => {
    process.env.LOOM_AGENT_THREAD_CAP = '2';
    // Distinct createdAt via slight delays so ordering is deterministic.
    for (const id of ['a', 'b', 'c']) {
      await saveThread({ agentId: AGENT, userOid: USER, threadId: id, status: 'completed', question: id, answer: id });
      await new Promise((r) => setTimeout(r, 5));
    }
    const list = await listThreads(AGENT, USER);
    expect(list.map((t) => t.threadId)).toEqual(['c', 'b']); // 'a' evicted
  });
});

describe('durable memory', () => {
  it('extracts + stores facts and retrieves them', async () => {
    aoaiChatJsonMock.mockResolvedValue({ facts: ['User prefers USD', 'User is the CFO'] });
    const stored = await extractAndStoreMemory({ agentId: AGENT, userOid: USER, question: 'Report in dollars', answer: 'Sure.' });
    expect(stored).toHaveLength(2);
    const mems = await retrieveMemories(AGENT, USER);
    expect(mems.map((m) => m.fact).sort()).toEqual(['User is the CFO', 'User prefers USD']);
  });

  it('stores nothing when the summarizer finds no durable facts', async () => {
    aoaiChatJsonMock.mockResolvedValue({ facts: [] });
    expect(await extractAndStoreMemory({ agentId: AGENT, userOid: USER, question: 'hi', answer: 'hello' })).toHaveLength(0);
    expect(await retrieveMemories(AGENT, USER)).toHaveLength(0);
  });

  it('never throws when the summarizer fails (best-effort)', async () => {
    aoaiChatJsonMock.mockRejectedValue(new Error('AOAI down'));
    expect(await extractAndStoreMemory({ agentId: AGENT, userOid: USER, question: 'q', answer: 'a' })).toHaveLength(0);
  });

  it('renders a memory preamble (and empty string for none)', () => {
    expect(memoryPreamble([])).toBe('');
    const block = memoryPreamble([
      { id: 'm1', agentId: AGENT, docType: 'memory', userOid: USER, fact: 'User prefers USD', createdAt: 'x' },
    ]);
    expect(block).toContain('- User prefers USD');
    expect(block).toMatch(/Durable memory/i);
  });
});
