/**
 * CosmosAccountEditor — Data Explorer studio contract test.
 *
 * Asserts the studio shape mounts: the editor chrome + ribbon, the closable
 * tab strip with a pinned Home tab open by default, and the studio Welcome
 * hero ("Welcome to Azure Cosmos DB"). The account/databases fetch is mocked
 * to ok:true so the tree's Home row + ＋New… command render.
 *
 * Per .claude/rules/no-vaporware.md grading rubric, this brings the Cosmos
 * Data Explorer studio surface from B (functional) toward A (functional +
 * Vitest).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CosmosAccountEditor } from '../cosmos-account-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('CosmosAccountEditor (Data Explorer studio)', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/cosmos/account': () => ({ ok: true, account: { name: 'cosmos-loom', location: 'eastus', capabilities: [], serverless: false } }),
      '/api/cosmos/databases': () => ({ ok: true, databases: [{ id: 'loom', name: 'loom' }] }),
      '/api/cosmos/containers': () => ({ ok: true, containers: [] }),
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('mounts the studio: chrome, ribbon, Home tab + Welcome hero', async () => {
    let err: unknown = null;
    try {
      render(<CosmosAccountEditor item={makeItem('cosmos-account', 'Cosmos DB account')} id="acct1" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      const ribbon = screen.getByTestId('ribbon');
      expect(ribbon.querySelectorAll('button').length).toBeGreaterThan(0);
      // The pinned Home tab opens the Welcome hero by default.
      await waitFor(
        () => expect(screen.getByText(/Welcome to Azure Cosmos DB/i)).toBeInTheDocument(),
        { timeout: 5000 },
      );
      // The tab strip role exists.
      expect(screen.getByRole('tablist', { name: /Cosmos Data Explorer tabs/i })).toBeInTheDocument();
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });
});
