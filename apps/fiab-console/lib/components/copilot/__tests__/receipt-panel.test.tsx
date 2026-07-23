/**
 * N10 — ReceiptPanel render test.
 *
 * Renders the per-answer Receipt panel from a REAL assembled receipt (the same
 * assembler the orchestrator persists with) and asserts it surfaces the verdict
 * badge (always visible), and — once expanded — the exact SQL executed, the real
 * row count, the routed model tier, and the persisted receipt id. Also asserts
 * the Verified badge lights when N9's verification signal is present.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { ReceiptPanel } from '../receipt-panel';
import { assembleAnswerReceipt, type ReceiptTraceLike } from '@/lib/copilot/answer-receipt';

afterEach(cleanup);

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

const SQL = 'SELECT COUNT(*) FROM Orders WHERE Shipped >= DATEADD(day,-7,GETDATE())';

function realReceipt(over: Partial<ReceiptTraceLike> = {}, opts = {}) {
  const trace: ReceiptTraceLike = {
    prompt: 'how many orders shipped last week?',
    steps: [
      { kind: 'tool_call', name: 'warehouse_run_query', args: { sql: SQL }, callId: 'c1' },
      { kind: 'tool_result', name: 'warehouse_run_query', callId: 'c1', durationMs: 42, result: { rows: [{ n: 128 }], rowCount: 128 } },
    ],
    model: 'gpt-4.1',
    modelTier: 'standard',
    taskClass: 'general',
    usage: { promptTokens: 900, completionTokens: 120, totalTokens: 1020 },
    costUsd: 0.012,
    turnLatencyMs: 2200,
    phaseTimings: [{ phase: 'llm', ms: 1800 }],
    citations: [{ id: 'doc1', path: 'orders/schema.md', kind: 'schema', heading: 'Orders table' }],
    ...over,
  };
  return assembleAnswerReceipt(trace, { receiptId: 'rcpt-xyz-1', createdAt: '2026-07-23T00:00:00.000Z', ...opts });
}

describe('ReceiptPanel', () => {
  it('shows the Unverified badge collapsed, then the real SQL, row count, tier and id when expanded', () => {
    wrap(<ReceiptPanel receipt={realReceipt()} />);

    // Verdict badge is visible without expanding.
    expect(screen.getByText(/Unverified/)).toBeInTheDocument();
    // Body is collapsed — the SQL is not yet rendered.
    expect(screen.queryByText(SQL)).not.toBeInTheDocument();

    // Expand.
    fireEvent.click(screen.getByRole('button'));

    // The EXACT SQL text is shown verbatim.
    expect(screen.getByText(SQL)).toBeInTheDocument();
    // The real row count.
    expect(screen.getByText(/128 rows/)).toBeInTheDocument();
    // The routed tier.
    expect(screen.getByText(/standard tier/)).toBeInTheDocument();
    // The persisted governance-audit reference.
    expect(screen.getByText(/rcpt-xyz-1/)).toBeInTheDocument();
    // The tool that ran the query.
    expect(screen.getByText('warehouse_run_query')).toBeInTheDocument();
  });

  it('lights the Verified badge when N9\'s verification signal is present', () => {
    const receipt = realReceipt({}, { verification: { verdict: 'verified', method: 'verified-answers' } });
    wrap(<ReceiptPanel receipt={receipt} defaultExpanded />);
    expect(screen.getByText(/Verified/)).toBeInTheDocument();
  });

  it('shows the refusal reason and a Refused badge on a refused turn', () => {
    const receipt = assembleAnswerReceipt(
      {
        prompt: 'do something disallowed',
        steps: [{ kind: 'error', error: 'Blocked by content safety: hate/high', code: 'content_safety_output' }],
      },
      { createdAt: '2026-07-23T00:00:00.000Z' },
    );
    wrap(<ReceiptPanel receipt={receipt} defaultExpanded />);
    expect(screen.getByText(/Refused/)).toBeInTheDocument();
    expect(screen.getByText(/Blocked by content safety/)).toBeInTheDocument();
  });
});
