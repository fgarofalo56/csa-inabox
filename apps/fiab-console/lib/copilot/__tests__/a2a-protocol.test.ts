/**
 * a2a-protocol unit tests (WS-5.2) — the pure A2A JSON-RPC dispatcher + builders.
 *
 * Uses an in-memory task store + a stub `execute` + a captured audit sink, so the
 * inbound-delegation path (message/send → real execute → persisted Task → audit),
 * tasks/get, tasks/cancel, the legacy tasks/send alias, and every error code are
 * proven with NO network / Cosmos.
 */
import { describe, it, expect } from 'vitest';
import {
  handleA2aRpc, buildAgentCard, isValidAgentCard, A2A_ERROR,
  type A2aServerContext, type A2aTask, type A2aAuditEvent, type A2aMessage,
} from '../a2a-protocol';

function makeCtx(overrides: Partial<A2aServerContext> = {}) {
  const store = new Map<string, A2aTask>();
  const audits: A2aAuditEvent[] = [];
  const executeCalls: Array<{ skillId?: string; text: string; data: Record<string, unknown> }> = [];
  const ctx: A2aServerContext = {
    agentCard: buildAgentCard({ name: 'Test', description: 'd', url: 'https://x/api/a2a', skills: [{ id: 's', name: 'S', description: 'd', tags: ['t'] }] }),
    execute: async (input) => {
      executeCalls.push({ skillId: input.skillId, text: input.text, data: input.data });
      return { parts: [{ kind: 'text', text: `answered: ${input.text}` }], state: 'completed' };
    },
    saveTask: async (task) => { store.set(task.id, task); },
    loadTask: async (id) => store.get(id) ?? null,
    onAudit: (ev) => { audits.push(ev); },
    now: () => '2026-07-20T00:00:00Z',
    ...overrides,
  };
  return { ctx, store, audits, executeCalls };
}

function userMsg(text: string, extra: Partial<A2aMessage> = {}): A2aMessage {
  return { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text }], ...extra };
}

describe('buildAgentCard / isValidAgentCard', () => {
  it('produces a valid A2A agent card', () => {
    const card = buildAgentCard({ name: 'Loom', description: 'desc', url: 'https://x/api/a2a', skills: [{ id: 'q', name: 'Q', description: 'd', tags: ['a'] }] });
    expect(isValidAgentCard(card)).toBe(true);
    expect(card.protocolVersion).toBeTruthy();
    expect(card.securitySchemes?.loomBearer?.type).toBe('http');
    expect(card.capabilities.streaming).toBe(false);
  });
  it('rejects an invalid card (missing skills / fields)', () => {
    expect(isValidAgentCard({ name: 'x' })).toBe(false);
    expect(isValidAgentCard(null)).toBe(false);
  });
});

describe('handleA2aRpc — message/send (inbound delegation)', () => {
  it('executes the delegated task, returns a terminal Task, and audits success', async () => {
    const { ctx, store, audits, executeCalls } = makeCtx();
    const res: any = await handleA2aRpc(
      { id: 1, method: 'message/send', params: { message: userMsg('hello'), metadata: { skillId: 'query-data-agent' } } },
      ctx,
    );
    expect(res.error).toBeUndefined();
    expect(res.result.kind).toBe('task');
    expect(res.result.status.state).toBe('completed');
    expect(res.result.artifacts[0].parts[0].text).toBe('answered: hello');
    // executed against the injected backend...
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0].skillId).toBe('query-data-agent');
    // ...persisted...
    expect(store.has(res.result.id)).toBe(true);
    // ...and audited.
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ method: 'message/send', outcome: 'success', skillId: 'query-data-agent' });
  });

  it('marks the task failed (+ audits failure) when execute throws', async () => {
    const { ctx, store, audits } = makeCtx({ execute: async () => { throw new Error('backend gate'); } });
    const res: any = await handleA2aRpc({ id: 2, method: 'message/send', params: { message: userMsg('x') } }, ctx);
    expect(res.result.status.state).toBe('failed');
    expect(res.result.status.message.parts[0].text).toContain('backend gate');
    expect(store.get(res.result.id)?.status.state).toBe('failed');
    expect(audits[0].outcome).toBe('failure');
  });

  it('accepts the legacy tasks/send alias', async () => {
    const { ctx } = makeCtx();
    const res: any = await handleA2aRpc({ id: 3, method: 'tasks/send', params: { message: userMsg('legacy') } }, ctx);
    expect(res.result.kind).toBe('task');
    expect(res.result.status.state).toBe('completed');
  });

  it('rejects a message with no text or data parts (-32602)', async () => {
    const { ctx } = makeCtx();
    const res: any = await handleA2aRpc({ id: 4, method: 'message/send', params: { message: { kind: 'message', messageId: 'm', role: 'user', parts: [] } } }, ctx);
    expect(res.error.code).toBe(A2A_ERROR.INVALID_PARAMS);
  });

  it('passes a DataPart through to execute as structured params', async () => {
    const { ctx, executeCalls } = makeCtx();
    await handleA2aRpc({ id: 5, method: 'message/send', params: { message: { kind: 'message', messageId: 'm', role: 'user', parts: [{ kind: 'data', data: { agentId: 'da-1' } }, { kind: 'text', text: 'q' }] } } }, ctx);
    expect(executeCalls[0].data).toMatchObject({ agentId: 'da-1' });
  });
});

describe('handleA2aRpc — tasks/get + tasks/cancel', () => {
  it('retrieves a persisted task', async () => {
    const { ctx } = makeCtx();
    const sent: any = await handleA2aRpc({ id: 1, method: 'message/send', params: { message: userMsg('hi') } }, ctx);
    const got: any = await handleA2aRpc({ id: 2, method: 'tasks/get', params: { id: sent.result.id } }, ctx);
    expect(got.result.id).toBe(sent.result.id);
    expect(got.result.status.state).toBe('completed');
  });

  it('returns -32001 for an unknown task', async () => {
    const { ctx } = makeCtx();
    const res: any = await handleA2aRpc({ id: 1, method: 'tasks/get', params: { id: 'nope' } }, ctx);
    expect(res.error.code).toBe(A2A_ERROR.TASK_NOT_FOUND);
  });

  it('returns -32002 when canceling an already-terminal task', async () => {
    const { ctx } = makeCtx();
    const sent: any = await handleA2aRpc({ id: 1, method: 'message/send', params: { message: userMsg('hi') } }, ctx);
    const res: any = await handleA2aRpc({ id: 2, method: 'tasks/cancel', params: { id: sent.result.id } }, ctx);
    expect(res.error.code).toBe(A2A_ERROR.TASK_NOT_CANCELABLE);
  });

  it('honors historyLength=0 on tasks/get', async () => {
    const { ctx } = makeCtx();
    const sent: any = await handleA2aRpc({ id: 1, method: 'message/send', params: { message: userMsg('hi') } }, ctx);
    const got: any = await handleA2aRpc({ id: 2, method: 'tasks/get', params: { id: sent.result.id, historyLength: 0 } }, ctx);
    expect(got.result.history).toHaveLength(0);
  });
});

describe('handleA2aRpc — errors', () => {
  it('returns -32601 for an unknown method', async () => {
    const { ctx } = makeCtx();
    const res: any = await handleA2aRpc({ id: 1, method: 'bogus/method', params: {} }, ctx);
    expect(res.error.code).toBe(A2A_ERROR.METHOD_NOT_FOUND);
  });
  it('returns -32004 for streaming (unsupported)', async () => {
    const { ctx } = makeCtx();
    const res: any = await handleA2aRpc({ id: 1, method: 'message/stream', params: { message: userMsg('x') } }, ctx);
    expect(res.error.code).toBe(A2A_ERROR.UNSUPPORTED_OPERATION);
  });
});
