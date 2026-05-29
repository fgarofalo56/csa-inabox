/**
 * Contract tests for the prompt-flow BFF routes (per no-vaporware.md):
 *   GET  /api/items/prompt-flow            → list (session + project gate)
 *   POST /api/items/prompt-flow            → create  (name/def required)
 *   PUT  /api/items/prompt-flow/[id]       → save flow.dag.yaml
 *   POST /api/items/prompt-flow/[id]/run   → submit run, forwards inputs
 *
 * Asserts: 401 unauthenticated, 400 on missing params, real client call with
 * forwarded payload, and 503 + notDeployed=true on NotDeployedError.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/foundry-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/foundry-client');
  return {
    ...actual,
    listPromptFlows: vi.fn(),
    createPromptFlow: vi.fn(),
    updatePromptFlow: vi.fn(),
    submitFlowRun: vi.fn(),
  };
});

import { GET as listGET, POST as listPOST } from '../prompt-flow/route';
import { PUT as detailPUT } from '../prompt-flow/[id]/route';
import { POST as runPOST } from '../prompt-flow/[id]/run/route';
import { getSession } from '@/lib/auth/session';
import {
  listPromptFlows, createPromptFlow, updatePromptFlow, submitFlowRun, NotDeployedError,
} from '@/lib/azure/foundry-client';

function nreq(url: string, body?: any) {
  return {
    nextUrl: new URL(url, 'http://localhost'),
    json: async () => body ?? {},
  } as any;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => { vi.clearAllMocks(); });

describe('GET /api/items/prompt-flow', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await listGET(nreq('/api/items/prompt-flow?project=p1'));
    expect(res.status).toBe(401);
  });

  it('400 when project missing', async () => {
    (getSession as any).mockReturnValue({ user: 'x' });
    const res = await listGET(nreq('/api/items/prompt-flow'));
    expect(res.status).toBe(400);
  });

  it('lists flows for the project', async () => {
    (getSession as any).mockReturnValue({ user: 'x' });
    (listPromptFlows as any).mockResolvedValue([{ flowId: 'f1', flowName: 'web' }]);
    const res = await listGET(nreq('/api/items/prompt-flow?project=proj1'));
    const j = await res.json();
    expect(listPromptFlows).toHaveBeenCalledWith('proj1');
    expect(j).toMatchObject({ ok: true, flows: [{ flowId: 'f1' }], project: 'proj1' });
  });
});

describe('POST /api/items/prompt-flow (create)', () => {
  it('400 when flowName / flowDefinition missing', async () => {
    (getSession as any).mockReturnValue({ user: 'x' });
    const res = await listPOST(nreq('/api/items/prompt-flow', { project: 'proj1' }));
    expect(res.status).toBe(400);
  });

  it('creates the flow with forwarded definition', async () => {
    (getSession as any).mockReturnValue({ user: 'x' });
    (createPromptFlow as any).mockResolvedValue({ flowId: 'new1', flowName: 'my-flow' });
    const res = await listPOST(nreq('/api/items/prompt-flow', {
      project: 'proj1', flowName: 'my-flow', flowDefinition: 'inputs: {}\n',
    }));
    const j = await res.json();
    expect(createPromptFlow).toHaveBeenCalledWith('proj1', expect.objectContaining({
      flowName: 'my-flow', flowDefinition: 'inputs: {}\n',
    }));
    expect(j).toMatchObject({ ok: true, flow: { flowId: 'new1' } });
  });
});

describe('PUT /api/items/prompt-flow/[id] (save)', () => {
  it('400 when flowDefinition missing', async () => {
    (getSession as any).mockReturnValue({ user: 'x' });
    const res = await detailPUT(nreq('/api/items/prompt-flow/f1?project=proj1', {}), params('f1'));
    expect(res.status).toBe(400);
  });

  it('PUTs the flow.dag.yaml to the client', async () => {
    (getSession as any).mockReturnValue({ user: 'x' });
    (updatePromptFlow as any).mockResolvedValue({ flowId: 'f1' });
    const res = await detailPUT(
      nreq('/api/items/prompt-flow/f1?project=proj1', { flowDefinition: 'inputs:\n  q:\n    type: string\n' }),
      params('f1'),
    );
    const j = await res.json();
    expect(updatePromptFlow).toHaveBeenCalledWith('proj1', 'f1', 'inputs:\n  q:\n    type: string\n');
    expect(j).toMatchObject({ ok: true });
  });
});

describe('POST /api/items/prompt-flow/[id]/run', () => {
  it('forwards inputs and returns the run result', async () => {
    (getSession as any).mockReturnValue({ user: 'x' });
    (submitFlowRun as any).mockResolvedValue({ flowRunId: 'r1', output: { answer: 'Paris' } });
    const res = await runPOST(
      nreq('/api/items/prompt-flow/f1/run', { project: 'proj1', inputs: { question: 'capital?' } }),
      params('f1'),
    );
    const j = await res.json();
    expect(submitFlowRun).toHaveBeenCalledWith('proj1', 'f1', { question: 'capital?' });
    expect(j).toMatchObject({ ok: true, result: { flowRunId: 'r1' } });
  });

  it('surfaces NotDeployedError as 503 + notDeployed=true', async () => {
    (getSession as any).mockReturnValue({ user: 'x' });
    (submitFlowRun as any).mockRejectedValue(new NotDeployedError('Compute session', 'Start a compute session in Foundry.'));
    const res = await runPOST(
      nreq('/api/items/prompt-flow/f1/run', { project: 'proj1', inputs: {} }),
      params('f1'),
    );
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j).toMatchObject({ ok: false, notDeployed: true });
    expect(j.hint).toMatch(/compute session/i);
  });

  it('400 when project missing', async () => {
    (getSession as any).mockReturnValue({ user: 'x' });
    const res = await runPOST(nreq('/api/items/prompt-flow/f1/run', { inputs: {} }), params('f1'));
    expect(res.status).toBe(400);
  });
});
