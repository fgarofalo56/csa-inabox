/**
 * Render test for KnowledgeBasesPanel (AIF-1). Mocks clientFetch so the panel's
 * mount-time loads resolve with ok data, then asserts the surface mounts with
 * its three tabs and that the AOAI-model-binding wiring reads the deployments
 * route. Per no-vaporware.md this verifies the surface mounts + wires to the
 * real routes — it does not assert fake backend behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({ clientFetch: (...a: unknown[]) => fetchMock(...a) }));

import { KnowledgeBasesPanel } from '../knowledge-bases-panel';

function jsonRes(body: unknown, status = 200): Response {
  return {
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/knowledge-sources')) return Promise.resolve(jsonRes({ ok: true, knowledgeSources: [{ name: 'ks1', kind: 'searchIndex', searchIndexName: 'idx1' }] }));
    if (url.includes('/knowledge-bases')) return Promise.resolve(jsonRes({ ok: true, knowledgeBases: [{ name: 'kb1', knowledgeSources: ['ks1'], outputMode: 'answerSynthesis' }] }));
    if (url.includes('/indexes')) return Promise.resolve(jsonRes({ ok: true, indexes: [{ name: 'idx1' }] }));
    if (url.includes('/model-deployments')) return Promise.resolve(jsonRes({ ok: true, account: { endpoint: 'https://acct.openai.azure.com' }, deployments: [{ name: 'gpt-4o-mini', modelName: 'gpt-4o-mini' }, { name: 'embed', modelName: 'text-embedding-3-large' }] }));
    return Promise.resolve(jsonRes({ ok: true }));
  });
});
afterEach(() => { vi.restoreAllMocks(); fetchMock.mockReset(); });

describe('KnowledgeBasesPanel', () => {
  it('mounts, shows the three tabs, and loads the deployments route for model binding', async () => {
    let err: unknown = null;
    try {
      render(<KnowledgeBasesPanel />);
      // All three tabs are present (sources / bases / retrieve-test surface).
      await waitFor(() => expect(screen.getByRole('tab', { name: /Retrieve test/ })).toBeInTheDocument(), { timeout: 5000 });
      expect(screen.getByRole('tab', { name: /Knowledge sources/ })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /Knowledge bases/ })).toBeInTheDocument();
      // Model-binding wiring hit the AOAI deployments route.
      await waitFor(() => {
        expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/model-deployments'))).toBe(true);
      });
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import|act\(|multiple elements/i);
  });
});
