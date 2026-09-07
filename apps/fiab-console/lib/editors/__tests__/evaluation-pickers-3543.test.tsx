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
 *
 * ── SCOPE CORRECTION (#4313 round 7) ────────────────────────────────────────
 * These specs cover the HAPPY path only, and the header above used to imply
 * more than that. Since round 7 the deployment control is a plain `<Dropdown>`
 * ONLY when discovery answered `ok:true` with rows; while the listing is in
 * flight, has FAILED, or genuinely returned zero it is a freeform `<Combobox>`
 * escape hatch, because `disabled={!deploymentOptions.length}` asserted absence
 * over calls that never answered and removed an affordance `main` had. That is
 * deliberate and is covered by `foundry-picker-failure-paths-4313.test.tsx`.
 * So: "never a free text box" below means "never a free text box once discovery
 * has succeeded" — not "never, in any state".
 *
 * The same change makes the control SWAP NODES mid-render, so every query here
 * is re-issued after the swap; a reference captured from the first
 * `findByRole` stays detached forever and reads as "element could not be found
 * in the document" (it did, on this file's first run against round 7).
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

  /** Wait past the escape-hatch → Dropdown swap and return the SETTLED node. */
  async function settledDeploymentCombo(): Promise<HTMLElement> {
    await screen.findByRole('combobox', { name: 'Model deployment' }, { timeout: 5000 });
    await waitFor(() => {
      // A Fluent Dropdown's combobox is never an <input>; the freeform Combobox
      // escape hatch always is. So this is the swap having landed.
      expect(screen.getByRole('combobox', { name: 'Model deployment' }).tagName).not.toBe('INPUT');
    }, { timeout: 5000 });
    return screen.getByRole('combobox', { name: 'Model deployment' });
  }

  it('offers the model deployment as a combobox, never a free text box', async () => {
    render(<EvaluationEditor item={makeItem('evaluation', 'Foundry evaluation')} id="new" />);
    const combo = await settledDeploymentCombo();
    expect(combo).toBeInTheDocument();
    // The regression this guards: a plain <Input> renders role=textbox.
    expect(screen.queryByRole('textbox', { name: 'Model deployment' })).toBeNull();
  });

  it('populates the deployment list from the real ARM deployments call', async () => {
    installEvaluationMocks();
    render(<EvaluationEditor item={makeItem('evaluation', 'Foundry evaluation')} id="new" />);
    const combo = await settledDeploymentCombo();
    // Enabled — and reached only because discovery ANSWERED, which is what the
    // swap encodes; a failed listing would still be the enterable Combobox.
    expect(combo.getAttribute('aria-disabled')).not.toBe('true');
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
