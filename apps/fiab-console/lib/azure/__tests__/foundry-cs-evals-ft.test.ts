/**
 * Contract tests for the AI Foundry depth additions (audit-t19):
 *   - createEvalRun       → POST /evals/{id}/runs with a completions data_source
 *   - getEvalRunOutputItems → GET .../output_items, mapped to per-row results
 *   - cancelEvalRun       → POST .../runs/{id} { status: canceled }
 *   - uploadFile          → POST /files (multipart) with purpose
 *   - listFineTuningJobs  → GET /fine_tuning/jobs, mapped job shape
 *   - createFineTuningJob → POST /fine_tuning/jobs with hyperparameters
 *   - generateImage       → POST /images/generations
 *   - govModalityGate     → null on Commercial
 *
 * Stubs `fetch`; asserts exact data-plane path/shape per no-vaporware.md.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_FOUNDRY_RG = 'rg-foundry';
  process.env.LOOM_AOAI_ACCOUNT = 'acct1';
  process.env.LOOM_AOAI_RG = 'rg-foundry';
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

/** Resolve the env-default account, then dispatch on the data-plane path. */
function captureFetch(impl: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    // Account resolution (ARM GET on the account) returns an endpoint.
    if (/\/accounts\/acct1\?api-version=/.test(u)) {
      return new Response(JSON.stringify({ id: '/subscriptions/sub-1/resourceGroups/rg-foundry/providers/Microsoft.CognitiveServices/accounts/acct1', name: 'acct1', kind: 'AIServices', location: 'eastus2', properties: { endpoint: 'https://acct1.openai.azure.com/' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const r = impl(u, init);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('foundry-cs-client / evals run lifecycle', () => {
  it('createEvalRun POSTs a completions data_source with the file id', async () => {
    const calls = captureFetch((u) => /\/evals\/ev1\/runs\?/.test(u)
      ? { body: { id: 'run1', eval_id: 'ev1', status: 'queued', model: 'gpt-4o-mini' } } : { body: {} });
    const { createEvalRun } = await import('../foundry-cs-client');
    const { run } = await createEvalRun('ev1', { model: 'gpt-4o-mini', fileId: 'file-1', name: 'r' });
    const runCall = calls.find((c) => /\/evals\/ev1\/runs\?api-version=/.test(c.url))!;
    expect(runCall.init?.method).toBe('POST');
    const body = JSON.parse(String(runCall.init?.body));
    expect(body.data_source.type).toBe('completions');
    expect(body.data_source.model).toBe('gpt-4o-mini');
    expect(body.data_source.source).toMatchObject({ type: 'file_id', id: 'file-1' });
    expect(run).toMatchObject({ id: 'run1', status: 'queued' });
  });

  it('getEvalRunOutputItems maps per-row grader results', async () => {
    captureFetch((u) => /\/output_items\?/.test(u)
      ? { body: { data: [{ id: 'oi1', datasource_item_id: 0, status: 'pass', results: [{ name: 'exact-match', passed: true, score: 1 }], sample: { output_text: 'hi' } }] } } : { body: {} });
    const { getEvalRunOutputItems } = await import('../foundry-cs-client');
    const { items } = await getEvalRunOutputItems('ev1', 'run1');
    expect(items[0]).toMatchObject({ datasourceItemId: 0, status: 'pass', sampleOutput: 'hi' });
    expect(items[0].results?.[0]).toMatchObject({ name: 'exact-match', passed: true, score: 1 });
  });

  it('cancelEvalRun POSTs status=canceled', async () => {
    const calls = captureFetch((u) => /\/evals\/ev1\/runs\/run1\?/.test(u) ? { body: { id: 'run1', status: 'canceled' } } : { body: {} });
    const { cancelEvalRun } = await import('../foundry-cs-client');
    const { run } = await cancelEvalRun('ev1', 'run1');
    const c = calls.find((x) => /\/evals\/ev1\/runs\/run1\?api-version=/.test(x.url))!;
    expect(JSON.parse(String(c.init?.body))).toMatchObject({ status: 'canceled' });
    expect(run.status).toBe('canceled');
  });
});

describe('foundry-cs-client / files + fine-tuning', () => {
  it('uploadFile POSTs multipart to /files with purpose', async () => {
    const calls = captureFetch((u) => /\/v1\/files\?/.test(u) ? { body: { id: 'file-9', filename: 'd.jsonl', bytes: 12, purpose: 'evals', status: 'processed' } } : { body: {} });
    const { uploadFile } = await import('../foundry-cs-client');
    const { file } = await uploadFile('d.jsonl', Buffer.from('{"x":1}'), 'evals');
    const c = calls.find((x) => /\/openai\/v1\/files\?api-version=/.test(x.url))!;
    expect(c.init?.method).toBe('POST');
    expect(c.init?.body).toBeInstanceOf(FormData);
    expect(file).toMatchObject({ id: 'file-9', purpose: 'evals' });
  });

  it('listFineTuningJobs maps the job shape', async () => {
    captureFetch((u) => /\/fine_tuning\/jobs\?/.test(u)
      ? { body: { data: [{ id: 'ftjob-1', model: 'gpt-4o-mini', status: 'succeeded', trained_tokens: 1000, fine_tuned_model: 'gpt-4o-mini.ft', hyperparameters: { n_epochs: 3, batch_size: 1, learning_rate_multiplier: 0.5 } }] } } : { body: {} });
    const { listFineTuningJobs } = await import('../foundry-cs-client');
    const { jobs } = await listFineTuningJobs();
    expect(jobs[0]).toMatchObject({ id: 'ftjob-1', model: 'gpt-4o-mini', status: 'succeeded', trainedTokens: 1000, fineTunedModel: 'gpt-4o-mini.ft' });
    expect(jobs[0].hyperparameters).toMatchObject({ nEpochs: 3, batchSize: 1, learningRateMultiplier: 0.5 });
  });

  it('createFineTuningJob POSTs model + training_file + hyperparameters', async () => {
    const calls = captureFetch((u) => /\/fine_tuning\/jobs\?/.test(u) ? { body: { id: 'ftjob-2', model: 'gpt-4o-mini', status: 'queued' } } : { body: {} });
    const { createFineTuningJob } = await import('../foundry-cs-client');
    const { job } = await createFineTuningJob({ model: 'gpt-4o-mini', trainingFile: 'file-1', hyperparameters: { nEpochs: 'auto' } });
    const c = calls.find((x) => x.init?.method === 'POST' && /\/fine_tuning\/jobs\?api-version=/.test(x.url))!;
    const body = JSON.parse(String(c.init?.body));
    expect(body).toMatchObject({ model: 'gpt-4o-mini', training_file: 'file-1' });
    expect(body.hyperparameters).toMatchObject({ n_epochs: 'auto' });
    expect(job).toMatchObject({ id: 'ftjob-2', status: 'queued' });
  });
});

describe('foundry-cs-client / playground data-plane', () => {
  it('generateImage POSTs to images/generations and maps url/b64', async () => {
    const calls = captureFetch((u) => /\/images\/generations\?/.test(u) ? { body: { data: [{ url: 'https://img/1.png', revised_prompt: 'rp' }] } } : { body: {} });
    const { generateImage } = await import('../foundry-cs-client');
    const { images } = await generateImage('dalle3', 'a cat', { size: '1024x1024', n: 1 });
    const c = calls.find((x) => /\/deployments\/dalle3\/images\/generations\?api-version=/.test(x.url))!;
    expect(c.init?.method).toBe('POST');
    expect(images[0]).toMatchObject({ url: 'https://img/1.png', revisedPrompt: 'rp' });
  });

  it('govModalityGate returns null on Commercial', async () => {
    const { govModalityGate } = await import('../foundry-cs-client');
    expect(govModalityGate('image')).toBeNull();
    expect(govModalityGate('realtime')).toBeNull();
  });
});
