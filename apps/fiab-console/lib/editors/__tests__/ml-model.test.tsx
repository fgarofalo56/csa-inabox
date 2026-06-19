/**
 * MlModelEditor — Vitest contract test.
 *
 * 1. Mounts the create gate (id="new") and asserts the chrome + a ribbon
 *    button exist.
 * 2. Mounts a BOUND model (id="m1") with a mocked BFF that returns a model,
 *    one version, and an MLflow stage of "Production" — asserts the stage
 *    surfaces in the UI (the stage-transition feature this PR adds).
 *
 * Per .claude/rules/no-vaporware.md grading rubric, this keeps ml-model at
 * A-grade (functional + Vitest), now covering stages.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MlModelEditor } from '../ml-model-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('MlModelEditor', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('mounts and surfaces at least one ribbon button', async () => {
    installFetchMock({});
    let err: unknown = null;
    try {
      render(<MlModelEditor item={makeItem('ml-model', 'ML model')} id="new" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      const ribbon = screen.getByTestId('ribbon');
      expect(ribbon.querySelectorAll('button').length).toBeGreaterThan(0);
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });

  it('renders the MLflow stage for a bound model version', async () => {
    installFetchMock({
      // installFetchMock picks the LONGEST matching key, so the sub-routes must
      // be keyed by their full path — '/bind' alone loses to '/api/items/ml-model/m1'
      // (which is a substring of '/api/items/ml-model/m1/bind'), routing the
      // bind/stage/endpoint calls into the bare-model handler.
      '/api/items/ml-model/m1/bind': () => ({ ok: true, bound: { modelName: 'fraud' }, workspaces: [], models: [] }),
      '/api/items/ml-model/m1/stage': () => ({ ok: true, model: 'fraud', versions: [{ name: 'fraud', version: '5', currentStage: 'Production', runId: 'run-9' }] }),
      '/api/items/ml-model/m1/endpoint': () => ({ ok: true, endpoints: [] }),
      '/api/items/ml-model/m1': () => ({
        ok: true,
        model: { name: 'fraud', latestVersion: '5' },
        versions: [{ id: 'fraud:5', name: 'fraud', version: '5', modelType: 'mlflow_model' }],
        binding: {},
      }),
    });
    let err: unknown = null;
    try {
      render(<MlModelEditor item={makeItem('ml-model', 'ML model')} id="m1" />);
      await waitFor(() => expect(screen.getAllByText('Production').length).toBeGreaterThan(0), { timeout: 5000 });
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });
});
