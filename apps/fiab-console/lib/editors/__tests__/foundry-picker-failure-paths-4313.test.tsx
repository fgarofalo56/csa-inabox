/**
 * #4313 review round — the two AUTO-BIND pickers on their NON-HAPPY paths.
 *
 * The boy-scout pass that turned two free `<Input>`s into pickers made both of
 * them assert more than the code had established, and made both a dead end:
 *
 *  1. The AI Search vectorizer's Azure OpenAI endpoint became a `<Dropdown>`
 *     `disabled={!aoaiEndpoints.length}` with placeholder "No accounts found".
 *     `/api/foundry/accounts` answers 401 / 502 / 503 with `{ ok:false }`, and
 *     `useApi` flattens every one of those to `{ data:null }` — so the list is
 *     `[]` on EVERY failure path, not only on an empty subscription. "No
 *     accounts found" over a FAILED call is a deploy-integrity R7 violation
 *     (it states absence the code never established), and a disabled control
 *     with no action beside it is the dead end auto-bind-by-default and
 *     ux-baseline G2 forbid — `save()` refuses an empty `resourceUri`, so the
 *     vectorizer could not be completed at all.
 *
 *  2. DatasetEditor's URI became read-only with the ADLS browser as its ONLY
 *     writer. That browser emits `abfss://` exclusively, so the
 *     `azureml://datastores/<ds>/paths/<p>` family the removed placeholder
 *     advertised became unregisterable — and because the browser gates
 *     entirely when /api/lakehouse/containers is unreachable, in a gated
 *     deployment NO data asset could be registered by any route.
 *
 * These specs are the regression fence. They drive the REAL components against
 * REAL route shapes (the fetch mock returns exactly what the routes return),
 * and assert behaviour — is it enterable, does the honest text appear, does the
 * PUT carry the value — never a DOM string on its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { VectorSearchDesigner, DatasetEditor } from '../foundry-sub-editors';
import { makeItem, installFetchMock } from './test-helpers';

/** An index carrying one algorithm, one profile, and one UNCONFIGURED vectorizer. */
const IDX = {
  name: 'loom-rag',
  fields: [],
  vectorSearch: {
    algorithms: [{ name: 'hnsw-1', kind: 'hnsw', hnswParameters: { m: 4, efConstruction: 400, efSearch: 500, metric: 'cosine' } }],
    profiles: [{ name: 'profile-1', algorithm: 'hnsw-1' }],
    vectorizers: [{
      name: 'aoai-vectorizer-1',
      kind: 'azureOpenAI',
      azureOpenAIParameters: { resourceUri: '', deploymentId: 'text-embedding-3-large', modelName: 'text-embedding-3-large' },
    }],
  },
};

const INDEX_BASE = '/api/search/indexes/loom-rag';
const ENDPOINT = 'https://aoai-loom.openai.azure.com';

describe('AI Search vectorizer endpoint — /api/foundry/accounts FAILED (#4313)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('states the listing failed instead of asserting there are no accounts', async () => {
    // Exactly the 502 shape app/api/foundry/accounts/route.ts returns for an ARM error.
    installFetchMock({
      '/api/foundry/accounts': () => ({ ok: false, error: 'ARM returned 500 listing CognitiveServices accounts' }),
    });
    render(<VectorSearchDesigner idx={IDX} indexBase={INDEX_BASE} onSaved={() => {}} />);

    expect(await screen.findByText(/Could not list Azure OpenAI accounts/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/ARM returned 500 listing CognitiveServices accounts/)).toBeInTheDocument();
    // R7: absence must NOT be claimed from a failure.
    expect(screen.queryByText(/No accounts found/)).toBeNull();
    // G2 / auto-bind: the failure carries an action, never a bare bar.
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
  });

  it('leaves the endpoint enterable so the vectorizer can still be saved', async () => {
    const { calls } = installFetchMock({
      '/api/foundry/accounts': () => ({ ok: false, error: 'ARM returned 500 listing CognitiveServices accounts' }),
      [INDEX_BASE]: () => ({ ok: true }),
    });
    render(<VectorSearchDesigner idx={IDX} indexBase={INDEX_BASE} onSaved={() => {}} />);

    const endpoint = await screen.findByRole('combobox', { name: 'vectorizer-0-endpoint' }, { timeout: 5000 });
    // The regression: `disabled={!aoaiEndpoints.length}` on every failure path.
    await waitFor(() => expect(endpoint.getAttribute('aria-disabled')).not.toBe('true'));
    expect((endpoint as HTMLInputElement).disabled).toBe(false);
    // Freeform Combobox renders a real <input>; a Dropdown does not.
    expect(endpoint.tagName).toBe('INPUT');

    fireEvent.change(endpoint, { target: { value: ENDPOINT } });
    fireEvent.click(screen.getByRole('button', { name: /Save vector config/ }));

    // The PROOF the dead end is gone: save() no longer refuses, and the PUT
    // carries the endpoint the user supplied.
    await waitFor(() => {
      const put = calls.find((c) => c.url.includes(INDEX_BASE) && c.init?.method === 'PUT');
      expect(put, 'no PUT was issued — save() still refuses without a discovered endpoint').toBeTruthy();
      expect(String(put!.init!.body)).toContain(ENDPOINT);
    }, { timeout: 5000 });
  });

  it('offers a plain picker (no free text) once discovery SUCCEEDS', async () => {
    installFetchMock({
      '/api/foundry/accounts': () => ({ ok: true, accounts: [{ name: 'aoai-loom', endpoint: ENDPOINT, kind: 'AIServices' }] }),
    });
    render(<VectorSearchDesigner idx={IDX} indexBase={INDEX_BASE} onSaved={() => {}} />);

    // While the accounts call is still IN FLIGHT the control is the enterable
    // Combobox (an <input>) — never a disabled box. Once discovery lands it is
    // swapped for a Fluent Dropdown, which is a button-like combobox and never
    // an <input>: on the happy path the value is CHOSEN, which is what #3543
    // was for. Re-query inside the wait — the swap REPLACES the node, so a
    // reference captured before it would stay the detached <input> forever.
    await screen.findByRole('combobox', { name: 'vectorizer-0-endpoint' }, { timeout: 5000 });
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'vectorizer-0-endpoint' }).tagName).not.toBe('INPUT');
    }, { timeout: 5000 });
    const endpoint = screen.getByRole('combobox', { name: 'vectorizer-0-endpoint' });
    expect(screen.queryByText(/Could not list Azure OpenAI accounts/)).toBeNull();
    fireEvent.click(endpoint);
    expect(await screen.findByRole('option', { name: new RegExp('aoai-loom') })).toBeInTheDocument();
  });
});

describe('DatasetEditor URI picker — both address families (#4313)', () => {
  const DATASTORES = [
    { name: 'workspaceblobstore', datastoreType: 'AzureBlob', isDefault: true, accountName: 'saloomdev', containerName: 'azureml' },
  ];

  beforeEach(() => {
    installFetchMock({
      // The gated deployment: /api/lakehouse/containers answers with a gate, so
      // the ADLS tab cannot list anything.
      '/api/lakehouse/containers': () => ({ ok: true, containers: [], gate: { reason: 'no DLZ storage', remediation: 'Set LOOM_BRONZE_URL' } }),
      '/api/foundry/datastores': () => ({ ok: true, datastores: DATASTORES }),
      '/api/storage/saloomdev/containers/azureml/paths': () => ({
        ok: true, account: 'saloomdev', container: 'azureml', prefix: '', host: 'saloomdev.dfs.core.windows.net',
        paths: [{ name: 'UI/2026-09-01/golden.jsonl', isDirectory: false, size: 2048 }],
      }),
      '/api/items/dataset': () => ({ ok: true, assets: [], scope: 'hub' }),
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('registers an azureml:// datastore path even when the ADLS browser is gated', async () => {
    render(<DatasetEditor item={makeItem('dataset', 'Data asset')} id="new" />);

    fireEvent.click(await screen.findByRole('button', { name: /Browse/ }, { timeout: 5000 }));
    // The dialog is two SOURCE TABS writing one field — this is the tab the
    // ADLS-only version deleted.
    fireEvent.click(await screen.findByRole('tab', { name: /Datastore path/ }, { timeout: 5000 }));

    // Real datastores, from the real route.
    fireEvent.click(await screen.findByText('workspaceblobstore', {}, { timeout: 5000 }));
    // Real paths, browsed through the generic storage lister — not typed.
    fireEvent.click(await screen.findByRole('button', { name: /^Select$/ }, { timeout: 5000 }));

    const uri = await screen.findByLabelText('Data asset URI');
    expect((uri as HTMLInputElement).value)
      .toBe('azureml://datastores/workspaceblobstore/paths/UI/2026-09-01/golden.jsonl');
    // The field itself stays read-only — the picker is still the only writer.
    expect((uri as HTMLInputElement).readOnly).toBe(true);
    // And the asset is now creatable, which is what "gated deployment can
    // register nothing" measured as broken.
    expect(screen.getByRole('button', { name: /Create asset/ })).toBeInTheDocument();
  });

  it('says the ADLS tab is gated without making the whole dialog a dead end', async () => {
    render(<DatasetEditor item={makeItem('dataset', 'Data asset')} id="new" />);
    fireEvent.click(await screen.findByRole('button', { name: /Browse/ }, { timeout: 5000 }));
    expect(await screen.findByText(/Set LOOM_BRONZE_URL/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Datastore path/ })).toBeInTheDocument();
  });
});
