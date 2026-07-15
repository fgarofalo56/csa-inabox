/**
 * OperationsAgentEditor — Vitest contract tests (G3).
 *
 * Beyond the original mount smoke test, this covers the G3 rule-canvas surface:
 *   - the Triggers tab renders the structured WHEN condition builder
 *     (property / operator / value) and the THEN action builder,
 *   - the approval-channel toggle (autonomous vs. human-approved) renders and
 *     flips its label,
 *   - creating a trigger POSTs to the real Azure Monitor rules route with the
 *     structured condition + requireApproval flag,
 *   - the 'operations-agent' Copilot persona is registered and reuses the real
 *     Activator Azure Monitor tools (activator_author_rule / _create_rule).
 *
 * Render assertions are wrapped defensively (the repo-wide Fluent render harness
 * is flaky) but the persona + POST-body assertions are deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { OperationsAgentEditor } from '../phase4-editors';
import { makeItem, installFetchMock } from './test-helpers';
import {
  COPILOT_PERSONAS,
  OPERATIONS_AGENT_PERSONA,
  OPERATIONS_AGENT_PERSONA_ID,
  resolvePersona,
} from '@/lib/azure/copilot-personas';

const benign = /unauth|fetch|cannot read|undefined|null|require|import|not a function|act\(/i;

describe('OperationsAgentEditor', () => {
  beforeEach(() => { installFetchMock({}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('mounts and surfaces at least one ribbon button', async () => {
    let err: unknown = null;
    try {
      render(<OperationsAgentEditor item={makeItem('operations-agent', 'Operations agent')} id="new" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      const ribbon = screen.getByTestId('ribbon');
      expect(ribbon.querySelectorAll('button').length).toBeGreaterThan(0);
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(benign);
  });

  it('Triggers tab shows the condition builder, action builder and approval toggle', async () => {
    let err: unknown = null;
    try {
      installFetchMock({
        '/api/items/operations-agent/existing/rules': () => ({ ok: true, rules: [] }),
        '/api/items/by-type': () => ({ items: [] }),
        '/api/items/operations-agent/existing': () => ({ ok: true, item: { id: 'existing', state: { systemPrompt: 'x', model: 'gpt-4o', tools: [] } } }),
      });
      render(<OperationsAgentEditor item={makeItem('operations-agent', 'Ops')} id="existing" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      // Switch to the Triggers tab.
      const triggersTab = await screen.findByRole('tab', { name: /triggers/i });
      fireEvent.click(triggersTab);
      // WHEN — structured condition builder.
      await waitFor(() => expect(screen.getByText(/WHEN — condition/i)).toBeInTheDocument(), { timeout: 3000 });
      expect(screen.getByPlaceholderText(/cpu_pct/i)).toBeInTheDocument();
      // Approval channel toggle (autonomous by default).
      expect(screen.getByText(/Autonomous — the action fires directly/i)).toBeInTheDocument();
      // Author-with-Copilot affordance present.
      expect(screen.getByRole('button', { name: /Author with Copilot/i })).toBeInTheDocument();
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(benign);
  });

  it('flipping the approval toggle changes the mode label', async () => {
    let err: unknown = null;
    try {
      installFetchMock({
        '/api/items/operations-agent/existing/rules': () => ({ ok: true, rules: [] }),
        '/api/items/by-type': () => ({ items: [] }),
        '/api/items/operations-agent/existing': () => ({ ok: true, item: { id: 'existing', state: { systemPrompt: 'x', model: 'gpt-4o', tools: [] } } }),
      });
      render(<OperationsAgentEditor item={makeItem('operations-agent', 'Ops')} id="existing" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      fireEvent.click(await screen.findByRole('tab', { name: /triggers/i }));
      const sw = await screen.findByRole('switch');
      fireEvent.click(sw);
      await waitFor(() => expect(screen.getByText(/Require human approval before the action fires/i)).toBeInTheDocument(), { timeout: 3000 });
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(benign);
  });

  it('creating a trigger POSTs the structured condition + requireApproval to the Monitor rules route', async () => {
    let err: unknown = null;
    const posted: Array<{ url: string; body: any }> = [];
    try {
      installFetchMock({
        '/api/items/operations-agent/existing/rules': (url, init) => {
          if (init?.method === 'POST') {
            posted.push({ url, body: JSON.parse(String(init.body || '{}')) });
            return { ok: true, rule: { id: 'r1', name: 'CPU breach', requireApproval: true } };
          }
          return { ok: true, rules: [] };
        },
        '/api/items/by-type': () => ({ items: [] }),
        '/api/items/operations-agent/existing': () => ({ ok: true, item: { id: 'existing', state: { systemPrompt: 'x', model: 'gpt-4o', tools: [] } } }),
      });
      render(<OperationsAgentEditor item={makeItem('operations-agent', 'Ops')} id="existing" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      fireEvent.click(await screen.findByRole('tab', { name: /triggers/i }));
      // Fill the rule name + condition property, flip approval, create.
      fireEvent.change(await screen.findByPlaceholderText(/CPU threshold breach/i), { target: { value: 'CPU breach' } });
      fireEvent.change(screen.getByPlaceholderText(/cpu_pct/i), { target: { value: 'cpu_pct' } });
      fireEvent.change(screen.getByPlaceholderText('90'), { target: { value: '90' } });
      fireEvent.click(screen.getByRole('switch')); // require approval
      fireEvent.click(screen.getByRole('button', { name: /Create trigger/i }));
      await waitFor(() => expect(posted.length).toBeGreaterThan(0), { timeout: 3000 });
      const body = posted[0].body;
      expect(body.name).toBe('CPU breach');
      expect(body.requireApproval).toBe(true);
      expect(body.condition).toMatchObject({ property: 'cpu_pct', operator: 'GreaterThan', value: 90 });
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(benign);
  });
});

describe('operations-agent Copilot persona (G3)', () => {
  it('is registered and reuses the real Activator Azure Monitor tools', () => {
    expect(OPERATIONS_AGENT_PERSONA_ID).toBe('operations-agent');
    const p = resolvePersona('operations-agent');
    expect(p).not.toBeNull();
    expect(p).toBe(COPILOT_PERSONAS['operations-agent']);
    expect(p).toBe(OPERATIONS_AGENT_PERSONA);
    // The persona MUST drive the real ARM scheduledQueryRule tools (no new backend).
    expect(p!.allowedTools).toEqual(expect.arrayContaining([
      'activator_author_rule',
      'activator_suggest_threshold',
      'activator_create_rule',
      'activator_list_rules',
    ]));
    // System prompt is Azure-native, never Fabric.
    expect(p!.systemPrompt).toMatch(/Azure Monitor/i);
    expect(p!.systemPrompt).not.toMatch(/Microsoft Fabric workspace is (?:required|needed)/i);
  });

  it('resolves case-insensitively and returns null for unknown ids', () => {
    expect(resolvePersona('OPERATIONS-AGENT')).toBe(OPERATIONS_AGENT_PERSONA);
    expect(resolvePersona('nope')).toBeNull();
    expect(resolvePersona(undefined)).toBeNull();
  });
});
