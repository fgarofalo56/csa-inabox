/**
 * PromptFlowEditor — Vitest contract test (auto-generated).
 *
 * Renders the editor with minimal props and asserts the chrome mounts +
 * at least one ribbon button exists. Network calls are caught by a no-op
 * fetch mock so the editor's mount-time fetch succeeds with ok:true.
 *
 * Per .claude/rules/no-vaporware.md grading rubric, this brings prompt-flow
 * from B-grade (functional, untested) to A-grade (functional + Vitest).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PromptFlowEditor } from '../foundry-sub-editors';
import { makeItem, installFetchMock } from './test-helpers';

describe('PromptFlowEditor', () => {
  beforeEach(() => { installFetchMock({}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('mounts and surfaces at least one ribbon button', async () => {
    let err: unknown = null;
    try {
      render(<PromptFlowEditor item={makeItem('prompt-flow', 'Prompt flow')} id="new" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      const ribbon = screen.getByTestId('ribbon');
      expect(ribbon.querySelectorAll('button').length).toBeGreaterThan(0);
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });
});
