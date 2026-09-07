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
 *  3. The SAME defect, unfixed, in the two pickers #3543 actually introduced —
 *     EvaluationEditor's "Dataset" and "Model deployment". `/api/items/dataset`
 *     and `/api/foundry/model-deployments` answer 401 / 502 / 503 with
 *     `{ ok:false }` too, so "No data assets" / "No model deployments in this
 *     account" rendered over a FAILED call (R7), the dataset half swallowed
 *     `assets.error` entirely, and `disabled={!deploymentOptions.length}` made
 *     the deployment field unsuppliable on every failure path where `main` had
 *     a free `<Input>`.
 *
 * These specs are the regression fence. They drive the REAL components against
 * REAL route shapes (the fetch mock returns exactly what the routes return),
 * and assert behaviour — is it enterable, does the honest text appear, does the
 * PUT carry the value — never a DOM string on its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { VectorSearchDesigner, DatasetEditor, EvaluationEditor } from '../foundry-sub-editors';
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
    // WAIT FOR THE DATA, NOT A TIMEOUT. Clicking the datastore starts a SECOND
    // round-trip (the storage path listing); the `Select` button only exists
    // once its rows render. Jumping straight to `findByRole('button', /^Select$/)`
    // was racing that under full-suite load — observed 1 red in 2 local runs of
    // the four suites together, green alone and green in CI, i.e. exactly the
    // load-dependent shape test-helpers' `selectOptionValue` header describes.
    // Awaiting the row removes the timing constant instead of enlarging it.
    await screen.findByText('golden.jsonl', {}, { timeout: 15000 });
    // Real paths, browsed through the generic storage lister — not typed.
    fireEvent.click(await screen.findByRole('button', { name: /^Select$/ }, { timeout: 15000 }));

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

/**
 * The two pickers #3543 introduced, on their failure paths. Same class as the
 * vectorizer above; the fixes must be the same shape or the class is only
 * half-closed.
 */
describe('EvaluationEditor pickers — the listing routes FAILED (#4313)', () => {
  const ASSET = { name: 'golden', dataUri: 'azureml://datastores/ws/paths/golden.jsonl', dataType: 'uri_file' };
  const DEPLOYMENTS = [{ name: 'gpt-4o-mini', modelName: 'gpt-4o-mini' }];
  const evalItem = () => makeItem('evaluation', 'Evaluation');

  afterEach(() => { vi.restoreAllMocks(); });

  it('states the deployment listing failed instead of asserting the account has none', async () => {
    // Exactly the 502 shape app/api/foundry/model-deployments/route.ts returns.
    const { calls } = installFetchMock({
      '/api/foundry/model-deployments': () => ({ ok: false, error: 'ARM returned 500 listing deployments' }),
      '/api/items/dataset': () => ({ ok: true, assets: [ASSET], scope: 'hub' }),
    });
    render(<EvaluationEditor item={evalItem()} id="new" />);

    expect(await screen.findByText(/Could not list model deployments/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/ARM returned 500 listing deployments/)).toBeInTheDocument();
    // R7: absence must NOT be claimed from a failure.
    expect(screen.queryByText(/No model deployments in this account/)).toBeNull();
    // G2 / auto-bind: the failure carries an action, never a bare bar — and the
    // action really re-issues the call it offers to retry.
    const before = calls.filter((c) => c.url.includes('/api/foundry/model-deployments')).length;
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => {
      expect(calls.filter((c) => c.url.includes('/api/foundry/model-deployments')).length)
        .toBeGreaterThan(before);
    }, { timeout: 5000 });
  });

  it('leaves the model deployment enterable so a model-scored evaluation is still creatable', async () => {
    installFetchMock({
      '/api/foundry/model-deployments': () => ({ ok: false, error: 'ARM returned 500 listing deployments' }),
      '/api/items/dataset': () => ({ ok: true, assets: [ASSET], scope: 'hub' }),
    });
    render(<EvaluationEditor item={evalItem()} id="new" />);

    const dep = await screen.findByRole('combobox', { name: 'Model deployment' }, { timeout: 5000 });
    expect(dep).toBeInTheDocument();
    // SETTLE FIRST. `useApi` starts at `{loading:false, data:null}`, so there is
    // a pre-fetch paint before the loading paint before the answered paint —
    // asserting on the first node found reads a TRANSIENT state and passes even
    // against the pre-fix predicates. The failure bar exists only once the call
    // has answered, so waiting on it pins the settled render.
    await screen.findByText(/Could not list model deployments/, {}, { timeout: 5000 });
    const settled = screen.getByRole('combobox', { name: 'Model deployment' });
    // The regression: `disabled={!deploymentOptions.length}` on every failure path.
    expect(settled.getAttribute('aria-disabled')).not.toBe('true');
    expect((settled as HTMLInputElement).disabled).toBe(false);
    // Freeform Combobox renders a real <input>; a Dropdown does not.
    expect(settled.tagName).toBe('INPUT');

    // The PROOF the dead end is gone: the field is CONTROLLED by
    // `form.modelDeployment`, so it only shows the typed value if setForm ran —
    // i.e. the evaluation can still carry a deployment while listing is broken.
    fireEvent.change(settled, { target: { value: 'gpt-4o-mini' } });
    await waitFor(() => expect((settled as HTMLInputElement).value).toBe('gpt-4o-mini'), { timeout: 5000 });
  });

  it('states the data-asset listing failed instead of swallowing the error', async () => {
    // Exactly the 403 shape app/api/items/dataset/route.ts returns for a
    // FoundryError — the arm whose `assets.error` was rendered NOWHERE.
    installFetchMock({
      '/api/items/dataset': () => ({ ok: false, error: 'AML returned 403 listing data assets' }),
      '/api/foundry/model-deployments': () => ({ ok: true, deployments: DEPLOYMENTS }),
    });
    render(<EvaluationEditor item={evalItem()} id="new" />);

    expect(await screen.findByText(/Could not list registered data assets/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/AML returned 403 listing data assets/)).toBeInTheDocument();
    expect(screen.queryByText(/No data assets/)).toBeNull();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
    // Not a dead end: the Browse… picker is still the writer of the URI.
    expect(screen.getByRole('button', { name: /Browse/ })).toBeInTheDocument();
  });

  it('offers a plain picker (no free text) once deployment discovery SUCCEEDS', async () => {
    installFetchMock({
      '/api/foundry/model-deployments': () => ({ ok: true, deployments: DEPLOYMENTS }),
      '/api/items/dataset': () => ({ ok: true, assets: [ASSET], scope: 'hub' }),
    });
    render(<EvaluationEditor item={evalItem()} id="new" />);

    // Re-query inside the wait — the swap REPLACES the node, so a reference
    // captured before it would stay the detached <input> forever.
    await screen.findByRole('combobox', { name: 'Model deployment' }, { timeout: 5000 });
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Model deployment' }).tagName).not.toBe('INPUT');
    }, { timeout: 5000 });
    expect(screen.queryByText(/Could not list model deployments/)).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: 'Model deployment' }));
    expect(await screen.findByRole('option', { name: /gpt-4o-mini/ })).toBeInTheDocument();
  });

  it('still says "no model deployments" when discovery SUCCEEDED and returned zero', async () => {
    // The positive control for the R7 split: the honest-absence bar must not
    // have been deleted along with the dishonest one.
    installFetchMock({
      '/api/foundry/model-deployments': () => ({ ok: true, deployments: [] }),
      '/api/items/dataset': () => ({ ok: true, assets: [ASSET], scope: 'hub' }),
    });
    render(<EvaluationEditor item={evalItem()} id="new" />);

    expect(await screen.findByText(/No model deployments in this account/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Deploy a model/ })).toBeInTheDocument();
    expect(screen.queryByText(/Could not list model deployments/)).toBeNull();
  });
});
