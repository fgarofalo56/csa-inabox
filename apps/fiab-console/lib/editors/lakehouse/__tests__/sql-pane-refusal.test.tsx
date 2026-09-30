/**
 * Lakehouse → SQL tab: how a failed query is shown.
 *
 * A query the tab chose not to run (`query_construct_not_accepted`,
 * `query_location_outside_root`) or could not confirm
 * (`lakehouse_storage_unbound`) is a WARNING that carries the route's
 * `remediation`; any other failure stays an error.
 *
 * Each test names the change that turns it red:
 *   - refusal shows the remediation: the pane dropping `remediation` again.
 *   - refusal is a warning titled "Query not run": the refusal codes shown as
 *     "Query failed" in an error bar.
 *   - other failures stay "Query failed" with no "What to do" line: every
 *     failure turned into a warning, or a remediation line rendered empty.
 *   - the refusal body wraps anywhere: `overflowWrap: 'anywhere'` dropped.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithProviders } from '../../__tests__/test-helpers';
import { LakehouseEditorContext } from '../lakehouse-editor-context';
import type { LakehouseEditorCtx } from '../lakehouse-editor-context';

vi.mock('@/lib/components/editor/monaco-textarea', () => ({
  MonacoTextarea: () => <textarea aria-label="OPENROWSET T-SQL editor" readOnly />,
}));
// Record each MessageBar's intent, and its body's overflowWrap, on wrappers, so the test reads the
// props the pane passed.
vi.mock('@fluentui/react-components', async () => {
  const actual = await vi.importActual<any>('@fluentui/react-components');
  return {
    ...actual,
    MessageBar: (p: any) => <div data-intent={p.intent}><actual.MessageBar {...p} /></div>,
    MessageBarBody: (p: any) => <div data-overflow-wrap={p.style?.overflowWrap}><actual.MessageBarBody {...p} /></div>,
  };
});
vi.mock('../../components/open-in-pbi-desktop-button', () => ({ OpenInPbiDesktopButton: () => null }));
vi.mock('../../components/open-in-loom-report-builder-button', () => ({ OpenInLoomReportBuilderButton: () => null }));
vi.mock('../../components/editor-results-split', () => ({
  EditorResultsSplit: ({ query, results }: { query: React.ReactNode; results: React.ReactNode }) => (
    <div>{query}<div data-testid="results">{results}</div></div>
  ),
  SplitFillBox: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { SqlPane } from '../panes/sql-pane';

const REMEDIATION = 'If Open is a column or table name, write it in brackets, as [Open]. Remediation-7731.';

function mount(sqlResult: unknown) {
  const ctx = {
    id: 'lh-1',
    item: { displayName: 'Sales' },
    sqlText: 'SELECT Open FROM t',
    setSqlText: () => {},
    sqlResult,
    sqlLoading: false,
    runSql: () => {},
  } as unknown as LakehouseEditorCtx;
  return renderWithProviders(
    <LakehouseEditorContext.Provider value={ctx}>
      <SqlPane />
    </LakehouseEditorContext.Provider>,
  );
}

afterEach(() => { cleanup(); });

describe('SqlPane — a refused query shows what to do', () => {
  for (const code of ['query_construct_not_accepted', 'query_location_outside_root', 'lakehouse_storage_unbound']) {
    it(`${code}: a warning titled "Query not run" with the route's remediation`, () => {
      mount({ ok: false, code, error: 'The lakehouse SQL tab runs read-only SELECT queries. Open is not accepted.', remediation: REMEDIATION });
      const results = screen.getByTestId('results');
      expect(results.textContent).toContain('Query not run');
      expect(results.textContent).not.toContain('Query failed');
      expect(results.textContent).toContain('What to do:');
      expect(results.textContent).toContain('Remediation-7731');
      expect(results.textContent).toContain('Open is not accepted.');
      expect(results.querySelector('[data-intent]')?.getAttribute('data-intent')).toBe('warning');
      // A refused name can be one long unbroken token. Breaks if the body stops wrapping anywhere; how it
      // wraps at a narrow width is for a browser check, not jsdom.
      expect(results.querySelector('[data-overflow-wrap]')?.getAttribute('data-overflow-wrap')).toBe('anywhere');
    });
  }

  it('any other failure stays "Query failed", an error, with no remediation line', () => {
    mount({ ok: false, code: 'synapse_access_denied', error: 'access denied to the Synapse Serverless SQL endpoint' });
    const results = screen.getByTestId('results');
    expect(results.textContent).toContain('Query failed');
    expect(results.textContent).not.toContain('Query not run');
    expect(results.textContent).not.toContain('What to do:');
    expect(results.querySelector('[data-intent]')?.getAttribute('data-intent')).toBe('error');
  });
});
