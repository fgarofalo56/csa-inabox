/**
 * EvaluationEditor "New evaluation" pickers — #3543.
 *
 * The form asked the operator to hand-type TWO values Loom already knows:
 * an `azureml://datastores/…/paths/…` dataset id and a model-deployment name
 * (`gpt-4o-mini`). That is `loom_no_freeform_config` plus
 * auto-bind-by-default.md §5 — the platform enumerates both, so it must not
 * ask for either.
 *
 * The dataset half is ratcheted by `scripts/ci/check-no-freeform.mjs` (its
 * site at :744 carried `shape:ml-uri`, and the file's baseline entry is now
 * DELETED because zero sites remain). The deployment half is INVISIBLE to that
 * guard — `gpt-4o-mini` has no infrastructure shape — so this spec is the only
 * thing standing between it and a silent regression back to an `<Input>`.
 *
 * What is asserted, deliberately, is the CONTROL KIND plus the REAL fetched
 * values: a control that is a combobox but populated from a hard-coded array
 * would satisfy the first half alone and would be vaporware.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { EvaluationEditor } from '../foundry-sub-editors';
import { makeItem, installFetchMock } from './test-helpers';

const DEPLOYMENTS = [
  { name: 'loom-gpt4o-mini', modelName: 'gpt-4o-mini' },
  { name: 'loom-embed-3-large', modelName: 'text-embedding-3-large' },
];

const ASSETS = [
  { name: 'bronze-events', dataType: 'uri_folder', dataUri: 'abfss://bronze@saloomdev.dfs.core.windows.net/events' },
  { name: 'eval-golden', dataType: 'uri_file', dataUri: 'abfss://gold@saloomdev.dfs.core.windows.net/eval/golden.jsonl' },
];

function installEvaluationMocks() {
  return installFetchMock({
    '/api/foundry/model-deployments': () => ({ ok: true, account: { name: 'aoai-loom' }, deployments: DEPLOYMENTS }),
    '/api/items/dataset': () => ({ ok: true, assets: ASSETS, scope: 'hub' }),
    '/api/items/evaluation': () => ({ ok: true, evaluations: [] }),
    '/api/items/ai-foundry-project': () => ({ ok: true, projects: [] }),
  });
}

describe('EvaluationEditor — New evaluation pickers (#3543)', () => {
  beforeEach(() => { installEvaluationMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('offers the model deployment as a combobox, never a free text box', async () => {
    render(<EvaluationEditor item={makeItem('evaluation', 'Foundry evaluation')} id="new" />);
    const combo = await screen.findByRole('combobox', { name: 'Model deployment' }, { timeout: 5000 });
    expect(combo).toBeInTheDocument();
    // The regression this guards: a plain <Input> renders role=textbox.
    expect(screen.queryByRole('textbox', { name: 'Model deployment' })).toBeNull();
  });

  it('populates the deployment list from the real ARM deployments call', async () => {
    installEvaluationMocks();
    render(<EvaluationEditor item={makeItem('evaluation', 'Foundry evaluation')} id="new" />);
    const combo = await screen.findByRole('combobox', { name: 'Model deployment' }, { timeout: 5000 });
    // Enabled only once the fetch landed — `disabled={!deploymentOptions.length}`.
    await waitFor(() => expect(combo.getAttribute('aria-disabled')).not.toBe('true'));
    fireEvent.click(combo);
    for (const d of DEPLOYMENTS) {
      expect(await screen.findByRole('option', { name: new RegExp(d.name) })).toBeInTheDocument();
    }
  });

  it('offers the dataset as a combobox listing the registered data assets', async () => {
    render(<EvaluationEditor item={makeItem('evaluation', 'Foundry evaluation')} id="new" />);
    const combo = await screen.findByRole('combobox', { name: 'Dataset' }, { timeout: 5000 });
    expect(screen.queryByRole('textbox', { name: 'Dataset' })).toBeNull();
    fireEvent.click(combo);
    for (const a of ASSETS) {
      expect(await screen.findByRole('option', { name: new RegExp(a.name) })).toBeInTheDocument();
    }
  });

  it('keeps a Browse… affordance for a path that is not a registered asset', async () => {
    render(<EvaluationEditor item={makeItem('evaluation', 'Foundry evaluation')} id="new" />);
    expect(await screen.findByRole('button', { name: /Browse/ }, { timeout: 5000 })).toBeInTheDocument();
  });
});
