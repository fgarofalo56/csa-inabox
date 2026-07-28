/**
 * semantic-model-r10-modules.test.tsx — direct coverage for the three sibling
 * modules the R10 decomposition lifted out of `semantic-model-editor.tsx`
 * (PR #2565): `aggregations-tab`, `direct-lake-tab`, `incremental-refresh-tab`.
 *
 * Those modules ship ~916 LOC of hook + presentational code. The editor-level
 * spec (`semantic-model.test.tsx`) proves the three tabs still render inside the
 * editor; this spec pins the BEHAVIOUR the move claimed to preserve verbatim:
 *
 *  - which endpoint each action calls, with which method and which body;
 *  - the `tab !== 'direct-lake'` early-return that gates the two Direct Lake
 *    effects (a one-character typo there silently kills the seed + load path);
 *  - the state/actions split that keeps a draft alive while the tab body is
 *    unmounted.
 *
 * Every request body below was read off the pre-refactor monolith at 20b3fe93,
 * so a "verbatim move" that quietly changed a field name fails here.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, renderHook, act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installFetchMock } from './test-helpers';
import {
  useSemanticModelAggregations,
  SemanticModelAggregationsTab,
} from '../phase3/semantic-model-editor/aggregations-tab';
import {
  useSemanticModelDirectLake,
} from '../phase3/semantic-model-editor/direct-lake-tab';
import {
  useSemanticModelIncrementalRefreshState,
  useSemanticModelIncrementalRefreshActions,
  SemanticModelIncrementalRefreshTab,
} from '../phase3/semantic-model-editor/incremental-refresh-tab';
import type { IncrementalRefreshApi } from '../phase3/semantic-model-editor/incremental-refresh-tab';
import type { TableLite } from '../phase3/semantic-model-editor/types';

const TABLES: TableLite[] = [
  { name: 'FactSales', columns: [{ name: 'OrderDate', dataType: 'dateTime' }, { name: 'Amount', dataType: 'double' }] },
];

/** A minimal stand-in for the parent's griffel class map. */
const S = new Proxy({}, { get: (_t, k) => String(k) }) as any;

const lastCall = (calls: Array<{ url: string; init?: RequestInit }>, needle: string) =>
  [...calls].reverse().find((c) => c.url.includes(needle));

describe('R10 module — aggregations-tab', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('seeds alternateOf mappings from the first table and derives the agg table name', () => {
    installFetchMock({});
    const { result } = renderHook(() => useSemanticModelAggregations({ workspaceId: 'ws', datasetId: 'ds', tables: TABLES }));
    expect(result.current.aggAltMaps).toHaveLength(0);
    act(() => { result.current.seedAltMapsFromTable(); });
    expect(result.current.aggAltMaps.map((m) => m.aggColumn)).toEqual(['OrderDate', 'Amount']);
    // First column is the GroupBy grain; the numeric one summarises as Sum.
    expect(result.current.aggAltMaps[0].summarization).toBe('GroupBy');
    expect(result.current.aggAltMaps[1].summarization).toBe('Sum');
    expect(result.current.aggTableName).toBe('FactSales_Agg');
  });

  it('add / update / remove keep the mapping list immutable and in order', () => {
    installFetchMock({});
    const { result } = renderHook(() => useSemanticModelAggregations({ workspaceId: 'ws', datasetId: 'ds', tables: TABLES }));
    act(() => { result.current.addAltMap(); result.current.addAltMap(); });
    expect(result.current.aggAltMaps).toHaveLength(2);
    act(() => { result.current.updateAltMap(1, { aggColumn: 'Amount' }); });
    expect(result.current.aggAltMaps[1].aggColumn).toBe('Amount');
    expect(result.current.aggAltMaps[0].aggColumn).toBe('');
    act(() => { result.current.removeAltMap(0); });
    expect(result.current.aggAltMaps).toHaveLength(1);
    expect(result.current.aggAltMaps[0].aggColumn).toBe('Amount');
  });

  it('createAggregation POSTs the TMSL alternateOf payload to the model route', async () => {
    const { calls } = installFetchMock({ '/model': () => ({ ok: true, tmsl: '{}' }) });
    const { result } = renderHook(() => useSemanticModelAggregations({ workspaceId: 'ws-1', datasetId: 'ds-1', tables: TABLES }));
    act(() => { result.current.setAggTableName('FactSales_Agg'); result.current.seedAltMapsFromTable(); });
    await act(async () => { await result.current.createAggregation(); });

    const call = lastCall(calls, '/api/items/semantic-model/ds-1/model');
    expect(call, 'createAggregation must call the model route').toBeDefined();
    expect(call!.url).toContain('workspaceId=ws-1');
    expect(call!.init?.method).toBe('POST');
    const body = JSON.parse(String(call!.init?.body));
    expect(body.action).toBe('aggregation');
    expect(body.aggTableName).toBe('FactSales_Agg');
    expect(body.altMaps[0]).toMatchObject({
      aggColumn: 'OrderDate', summarization: 'GroupBy', detailTable: 'FactSales', detailColumn: 'OrderDate',
    });
  });

  it('createAggregation is a no-op with no mappings (guard preserved from the monolith)', async () => {
    const { calls } = installFetchMock({});
    const { result } = renderHook(() => useSemanticModelAggregations({ workspaceId: 'ws-1', datasetId: 'ds-1', tables: TABLES }));
    act(() => { result.current.setAggTableName('Anything'); });
    await act(async () => { await result.current.createAggregation(); });
    expect(calls.filter((c) => c.init?.method === 'POST')).toHaveLength(0);
  });

  it('the tab body renders the mapping grid the hook owns', async () => {
    installFetchMock({});
    function Host() {
      const agg = useSemanticModelAggregations({ workspaceId: 'ws', datasetId: 'ds', tables: TABLES });
      return <SemanticModelAggregationsTab s={S} agg={agg} tables={TABLES} targetStorageMode="Import" datasetId="ds" />;
    }
    render(<Host />);
    expect(await screen.findByText(/Automatic aggregations/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Seed from first table/i }));
    // Two mapping rows appear — one per column of the seeded table.
    expect(await screen.findAllByDisplayValue('OrderDate')).toHaveLength(2);
    expect(screen.getAllByDisplayValue('Amount')).toHaveLength(2);
  });
});

describe('R10 module — direct-lake-tab', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('does NOT load or seed while another tab is active', async () => {
    const { calls } = installFetchMock({ '/direct-lake': () => ({ ok: true, shimEnabled: true }) });
    const { result } = renderHook(() => useSemanticModelDirectLake({ tab: 'tables', datasetId: 'ds-1', workspaceId: 'ws-1', tables: TABLES }));
    await act(async () => { await Promise.resolve(); });
    expect(calls.some((c) => c.url.includes('/direct-lake'))).toBe(false);
    expect(result.current.dlTables).toHaveLength(0);
  });

  it('loads the shim config and seeds one policy row per model table when the tab IS active', async () => {
    const { calls } = installFetchMock({
      '/direct-lake': () => ({
        ok: true, shimEnabled: true, runs: [],
        config: { deltaSourcePath: 'abfss://gold@acct.dfs.core.windows.net/fact', freshnessSlaSeconds: 900, tables: {} },
      }),
    });
    const { result } = renderHook(() => useSemanticModelDirectLake({ tab: 'direct-lake', datasetId: 'ds-1', workspaceId: 'ws-1', tables: TABLES }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    const call = lastCall(calls, '/direct-lake');
    expect(call).toBeDefined();
    expect(call!.url).toContain('/api/items/semantic-model/ds-1/direct-lake?workspaceId=ws-1');
    expect(result.current.dlEnabled).toBe(true);
    expect(result.current.dlDeltaPath).toBe('abfss://gold@acct.dfs.core.windows.net/fact');
    expect(result.current.dlSla).toBe(900);
    expect(result.current.dlTables.map((t) => t.tableName)).toEqual(['FactSales']);
    expect(result.current.dlTables[0].policy).toBe('Partition');
  });

  it('saveDirectLake PUTs the per-table policy payload, and refuses without a delta path', async () => {
    const { calls } = installFetchMock({ '/direct-lake': () => ({ ok: true, shimEnabled: true, runs: [] }) });
    const { result } = renderHook(() => useSemanticModelDirectLake({ tab: 'direct-lake', datasetId: 'ds-1', workspaceId: 'ws-1', tables: TABLES }));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // No delta path yet → honest in-UI refusal, no network call.
    await act(async () => { await result.current.saveDirectLake(); });
    expect(result.current.dlMsg?.ok).toBe(false);
    expect(calls.filter((c) => c.init?.method === 'PUT')).toHaveLength(0);

    act(() => { result.current.setDlDeltaPath('abfss://gold@acct.dfs.core.windows.net/fact'); });
    act(() => { result.current.setDlTablePartCol(0, 'OrderDate'); });
    await act(async () => { await result.current.saveDirectLake(); });

    const put = calls.find((c) => c.init?.method === 'PUT');
    expect(put, 'saveDirectLake must PUT').toBeDefined();
    const body = JSON.parse(String(put!.init?.body));
    expect(body.deltaSourcePath).toBe('abfss://gold@acct.dfs.core.windows.net/fact');
    expect(body.workspaceId).toBe('ws-1');
    expect(body.datasetId).toBe('ds-1');
    expect(body.tables).toEqual([{ tableName: 'FactSales', policy: 'Partition', partitionColumn: 'OrderDate' }]);
  });
});

describe('R10 module — incremental-refresh-tab', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function useIrApi(loadRefreshes = vi.fn()) {
    const st = useSemanticModelIncrementalRefreshState();
    const actions = useSemanticModelIncrementalRefreshActions(st, { workspaceId: 'ws-1', datasetId: 'ds-1', loadRefreshes });
    return { ...st, ...actions } as IncrementalRefreshApi;
  }

  it('starts from the monolith defaults (3 years archive / 10 days incremental / transactional)', () => {
    installFetchMock({});
    const { result } = renderHook(() => useIrApi());
    expect(result.current.irRollingWindowPeriods).toBe(3);
    expect(result.current.irRollingWindowGranularity).toBe('year');
    expect(result.current.irIncrementalPeriods).toBe(10);
    expect(result.current.irIncrementalGranularity).toBe('day');
    expect(result.current.enhApplyPolicy).toBe(true);
    expect(result.current.enhCommitMode).toBe('transactional');
  });

  it('loadIrPolicy surfaces the honest AAS gate instead of throwing', async () => {
    installFetchMock({ '/refresh-policy': () => ({ ok: false, error: 'Set LOOM_SEMANTIC_BACKEND=analysis-services' }) });
    const { result } = renderHook(() => useIrApi());
    await act(async () => { await result.current.loadIrPolicy(); });
    expect(result.current.irGate).toBe('Set LOOM_SEMANTIC_BACKEND=analysis-services');
    expect(result.current.irPartitions).toHaveLength(0);
  });

  it('saveIrPolicy PUTs the refreshPolicy TMSL payload and reports the DirectQuery partition', async () => {
    const { calls } = installFetchMock({
      '/refresh-policy': () => ({
        ok: true,
        partitions: [
          { name: '2024', storageMode: 'Import' },
          { name: 'current', storageMode: 'DirectQuery' },
        ],
      }),
    });
    const { result } = renderHook(() => useIrApi());
    act(() => {
      result.current.setIrTableName('FactSales');
      result.current.setIrEnableHybrid(true);
      result.current.setIrPollingExpression('Table.Max(FactSales, "LastModified")[LastModified]');
    });
    await act(async () => { await result.current.saveIrPolicy(); });

    const put = calls.find((c) => c.init?.method === 'PUT' && c.url.includes('/refresh-policy'));
    expect(put).toBeDefined();
    expect(put!.url).toContain('/api/items/semantic-model/ds-1/refresh-policy?workspaceId=ws-1');
    const body = JSON.parse(String(put!.init?.body));
    expect(body.tableName).toBe('FactSales');
    expect(body.policy).toMatchObject({
      rollingWindowGranularity: 'year',
      rollingWindowPeriods: 3,
      incrementalGranularity: 'day',
      incrementalPeriods: 10,
      mode: 'Hybrid',
      pollingExpression: 'Table.Max(FactSales, "LastModified")[LastModified]',
    });
    expect(result.current.irPartitions).toHaveLength(2);
    expect(result.current.irMsg?.ok).toBe(true);
    expect(result.current.irMsg?.text).toMatch(/1 live DirectQuery partition/);
  });

  it('saveIrPolicy is a no-op without a table (guard preserved from the monolith)', async () => {
    const { calls } = installFetchMock({});
    const { result } = renderHook(() => useIrApi());
    await act(async () => { await result.current.saveIrPolicy(); });
    expect(calls.filter((c) => c.init?.method === 'PUT')).toHaveLength(0);
  });

  it('triggerEnhancedRefresh POSTs commitMode + applyRefreshPolicy and re-polls the refresh history', async () => {
    vi.useFakeTimers();
    try {
      const loadRefreshes = vi.fn();
      const { calls } = installFetchMock({ '/refreshes': () => ({ ok: true, requestId: 'abcdef0123456789' }) });
      const { result } = renderHook(() => useIrApi(loadRefreshes));
      act(() => { result.current.setEnhApplyPolicy(false); result.current.setEnhCommitMode('partialBatch'); });
      await act(async () => { await result.current.triggerEnhancedRefresh(); });

      const post = calls.find((c) => c.init?.method === 'POST' && c.url.includes('/refreshes'));
      expect(post).toBeDefined();
      const body = JSON.parse(String(post!.init?.body));
      expect(body).toMatchObject({ type: 'full', commitMode: 'partialBatch', applyRefreshPolicy: false });
      expect(result.current.enhMsg?.ok).toBe(true);
      expect(result.current.enhMsg?.text).toContain('abcdef01');

      expect(loadRefreshes).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(2000); });
      expect(loadRefreshes).toHaveBeenCalledWith('ws-1', 'ds-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the state hook keeps a draft alive while the tab BODY unmounts (the whole point of the split)', async () => {
    installFetchMock({});
    function Host({ show }: { show: boolean }) {
      const ir = useIrApi();
      return show
        ? <SemanticModelIncrementalRefreshTab s={S} ir={ir} tables={TABLES} workspaceId="ws-1" datasetId="ds-1" />
        : <div data-testid="other-tab" />;
    }
    const { rerender } = render(<Host show />);
    const input = await screen.findByPlaceholderText(/Table\.Max\(FactSales/);
    await userEvent.type(input, 'KEEP_ME');
    expect((input as HTMLInputElement).value).toBe('KEEP_ME');

    rerender(<Host show={false} />);
    expect(screen.getByTestId('other-tab')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Table\.Max\(FactSales/)).not.toBeInTheDocument();

    rerender(<Host show />);
    expect((await screen.findByPlaceholderText(/Table\.Max\(FactSales/) as HTMLInputElement).value).toBe('KEEP_ME');
  });
});
