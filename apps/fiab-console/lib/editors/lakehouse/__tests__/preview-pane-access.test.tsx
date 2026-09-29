/**
 * Lakehouse → Preview tab: whether the live transform preview is offered.
 *
 * The pane hands DeltaPreviewGrid a `previewSource` (which enables the AI
 * tab's "Run this transform on a sample") and a `previewUnavailableReason`
 * (the text on the disabled action). The grid is stubbed here so the test
 * reads exactly the two props the pane decided.
 *
 *   - canWrite=false from /api/lakehouse/access -> no source, read-only reason.
 *   - canWrite=true -> a source naming this item, no reason.
 *   - unsaved item -> no source, "save first" reason, and no access probe.
 *   - a failed probe -> the source is still offered (unknown is not read-only).
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { waitFor, cleanup } from '@testing-library/react';
import { renderWithProviders, installFetchMock } from '../../__tests__/test-helpers';
import { LakehouseEditorContext } from '../lakehouse-editor-context';
import type { LakehouseEditorCtx } from '../lakehouse-editor-context';

const seen = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));

vi.mock('../../components/delta-preview-grid', () => ({
  DeltaPreviewGrid: (p: Record<string, unknown>) => {
    seen.props.push(p);
    return <div data-testid="grid" />;
  },
}));
vi.mock('@/lib/components/shared/local-analysis-panel', () => ({
  LocalAnalysisPanel: () => null,
}));

import { PreviewPane } from '../panes/preview-pane';

function ctx(overrides: Partial<LakehouseEditorCtx> = {}): LakehouseEditorCtx {
  return {
    id: 'lh-1',
    isNewItem: false,
    activeContainer: 'landing',
    activePath: { name: 'lakehouses/S--lh-1/Files/a.csv', isDirectory: false, size: 10 },
    preview: { ok: true, columns: ['a'], rows: [[1]], rowCount: 1 },
    previewLoading: false,
    previewMode: 'table',
    setPreviewMode: () => {},
    setTab: () => {},
    columnStats: undefined,
    statsLoading: false,
    statsError: null,
    settings: { defaultSparkPool: '' },
    ...overrides,
  } as unknown as LakehouseEditorCtx;
}

function mount(overrides: Partial<LakehouseEditorCtx> = {}) {
  return renderWithProviders(
    <LakehouseEditorContext.Provider value={ctx(overrides)}>
      <PreviewPane />
    </LakehouseEditorContext.Provider>,
  );
}

const last = () => seen.props[seen.props.length - 1];

/**
 * While the probe is in flight canWrite is null, which already OFFERS the
 * source -- so an assertion that the source is offered must be read after the
 * probe's answer has rendered, or it passes on the loading render alone.
 */
async function probeSettled(calls: Array<{ url: string }>) {
  await waitFor(() => expect(calls.some((c) => c.url.includes('/api/lakehouse/access?lakehouseId=lh-1'))).toBe(true));
  await new Promise((r) => setTimeout(r, 150));
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); seen.props.length = 0; });

describe('PreviewPane — live transform preview availability', () => {
  it('withholds the source and names the read-only reason when canWrite is false', async () => {
    installFetchMock({ '/api/lakehouse/access': () => ({ ok: true, lakehouseId: 'lh-1', canWrite: false }) });
    mount();
    // Breaks if the pane ignores canWrite (source stays set) or passes no reason.
    await waitFor(() => expect(last().previewUnavailableReason).toMatch(/read-only/));
    expect(last().previewSource).toBeNull();
  });

  it('offers a source naming this item when canWrite is true', async () => {
    const { calls } = installFetchMock({ '/api/lakehouse/access': () => ({ ok: true, lakehouseId: 'lh-1', canWrite: true }) });
    mount();
    await probeSettled(calls);
    // Breaks if the gate treats true as read-only, or drops the item id.
    expect(last().previewSource).toEqual({
      lakehouseId: 'lh-1', container: 'landing', path: 'lakehouses/S--lh-1/Files/a.csv', pool: undefined,
    });
    expect(last().previewUnavailableReason).toBeNull();
  });

  it('asks to save an unsaved lakehouse first and does not probe access', async () => {
    const { calls } = installFetchMock({ '/api/lakehouse/access': () => ({ ok: true, canWrite: true }) });
    mount({ isNewItem: true });
    await waitFor(() => expect(seen.props.length).toBeGreaterThan(0));
    // Breaks if the unsaved-item text regresses to the generic "select a file".
    expect(last().previewUnavailableReason).toMatch(/Save the lakehouse first/);
    expect(last().previewSource).toBeNull();
    expect(calls.filter((c) => c.url.includes('/api/lakehouse/access'))).toHaveLength(0);
  });

  it('still offers the source when the access probe fails', async () => {
    const { calls } = installFetchMock({ '/api/lakehouse/access': () => ({ ok: false, error: 'unavailable' }) });
    mount();
    await probeSettled(calls);
    // Breaks if an unknown answer is treated as read-only (source withheld).
    expect(last().previewSource).toMatchObject({ lakehouseId: 'lh-1' });
    expect(last().previewUnavailableReason).toBeNull();
  });
});
