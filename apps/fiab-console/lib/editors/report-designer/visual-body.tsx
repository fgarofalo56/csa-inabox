'use client';

// visual-body.tsx — VisualBody, MatrixPivotTable, TooltipPageContent, BubblePlayBody.

import { useState, useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import {
  Badge, Button, Caption1, MessageBar, MessageBarBody, Spinner, Text, Tooltip,
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  Slider, tokens,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
} from '@fluentui/react-components';
import {
  Play20Regular, Pause20Regular, Info16Regular, ArrowExpand16Regular, MoreHorizontal20Regular,
} from '@fluentui/react-icons';
import {
  LoomChart, type LoomChartType,
  type ChartErrorBar, type ChartForecast, type ChartSymmetry,
} from '@/lib/components/charts/loom-chart';
import { formatToChartProps, type ChartAdapterContext } from '@/lib/components/charts/loom-chart-format';
import { VisualChrome } from '../report/visual-chrome';
import { applyFilters, type ReportFilter } from '../report/filters-pane';
import { applyConditionalFormat } from '../report/conditional-format';
import {
  applySelection, selectionFromRow,
  type InteractionMode, type VisualSelection,
} from '../report/interactions';
import { formatValue } from '../report/format-pane';
import type { ReportVisualFormat } from '../report/format-pane';
import { MapVisual } from '../report/map-visual';
import { ScriptVisual } from '../report/script-visual';
import { SmartNarrative } from '../report/ai-visuals/smart-narrative';
import { ReportQA } from '../report/ai-visuals/qa';
import { DecompositionTree } from '../report/ai-visuals/decomposition-tree';
import { KeyInfluencers } from '../report/ai-visuals/key-influencers';
import { SlicerVisual, slicerFilterId, type SlicerStyle } from '../report/slicer-visual';
import {
  computeReferenceLines, computeErrorBars, computeForecast, computeSymmetry,
} from '../report/analytics-pane';
import type { CopilotVisualSpec } from '@/lib/components/report/report-powerbi-copilot';
import type { ReportFilterInput } from '@/lib/azure/wells-to-sql';
import type { ThemeChartProps } from '../report/themes';
import {
  AI_TYPES, AI_SELF_QUERY, SCRIPT_TYPES, KPI_TYPES, GAUGE_KPI, CHART_TYPES, CARTESIAN_TYPES, CHART_RENDER,
} from './constants';
import {
  hasBinding, cellIsNumeric, measureAggregates, splitCols, chartCategories,
  computeAnomalyOverlay, wellResultAlias, fieldLabel, queryVisual,
} from './helpers';
import type { DVisual, VisualState, WellField, AiVisualWiring } from './types';
import type { Styles } from './styles';

// ── MatrixPivotTable ──────────────────────────────────────────────────────────

export function MatrixPivotTable({ rows, rowKeys, pivotKey, valueAliases, valueLabels, nf, styles }: {
  rows: Array<Record<string, unknown>>;
  rowKeys: string[];
  pivotKey: string;
  valueAliases: string[];
  valueLabels: string[];
  nf?: Parameters<typeof formatValue>[1];
  styles: Styles;
}) {
  const multi = valueAliases.length > 1;
  const pivotValues: string[] = [];
  const seenPv = new Set<string>();
  for (const r of rows) {
    const pv = String(r[pivotKey] ?? '');
    if (!seenPv.has(pv)) { seenPv.add(pv); pivotValues.push(pv); if (pivotValues.length >= 40) break; }
  }
  const rowMap = new Map<string, { display: string[]; cells: Map<string, number> }>();
  const rowOrder: string[] = [];
  for (const r of rows) {
    const display = rowKeys.map((k) => String(r[k] ?? ''));
    const rk = display.join('');
    let entry = rowMap.get(rk);
    if (!entry) { entry = { display, cells: new Map() }; rowMap.set(rk, entry); rowOrder.push(rk); }
    const pv = String(r[pivotKey] ?? '');
    for (const a of valueAliases) {
      const cell = r[a];
      if (cellIsNumeric(cell)) {
        const ck = `${pv}${a}`;
        entry.cells.set(ck, (entry.cells.get(ck) ?? 0) + Number(cell));
      }
    }
  }
  const bodyRows = rowOrder.slice(0, 200).map((rk) => rowMap.get(rk)!);
  const colHeader = (pv: string, li: number) =>
    multi ? `${pv || '(blank)'} · ${valueLabels[li]}` : (pv || '(blank)');
  const totalHeader = (li: number) => (multi ? `Total · ${valueLabels[li]}` : 'Total');
  const cellNum = (row: { cells: Map<string, number> }, pv: string, a: string): number | undefined => {
    const v = row.cells.get(`${pv}${a}`);
    return v === undefined ? undefined : v;
  };
  const matrixEl = (
    <Table size="small">
      <TableHeader>
        <TableRow>
          {rowKeys.map((k) => <TableHeaderCell key={`h_${k}`}>{k}</TableHeaderCell>)}
          {pivotValues.map((pv) =>
            valueAliases.map((_a, li) => (
              <TableHeaderCell key={`h_${pv}_${li}`} style={{ textAlign: 'right' }}>{colHeader(pv, li)}</TableHeaderCell>
            )),
          )}
          {valueAliases.map((_a, li) => (
            <TableHeaderCell key={`h_total_${li}`} style={{ textAlign: 'right' }}>{totalHeader(li)}</TableHeaderCell>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {bodyRows.map((row, ri) => (
          <TableRow key={ri}>
            {rowKeys.map((k, ki) => (
              <TableCell key={`c_${k}`}><Text weight={ki === 0 ? 'semibold' : 'regular'}>{row.display[ki] || ''}</Text></TableCell>
            ))}
            {pivotValues.map((pv) =>
              valueAliases.map((a, li) => {
                const v = cellNum(row, pv, a);
                return (
                  <TableCell key={`c_${pv}_${li}`} style={{ textAlign: 'right' }}>
                    {v === undefined ? '' : formatValue(v, nf)}
                  </TableCell>
                );
              }),
            )}
            {valueAliases.map((a, li) => {
              const rowTotal = pivotValues.reduce((acc, pv) => acc + (cellNum(row, pv, a) ?? 0), 0);
              return (
                <TableCell key={`c_total_${li}`} style={{ textAlign: 'right' }}>
                  <Text weight="semibold">{formatValue(rowTotal, nf)}</Text>
                </TableCell>
              );
            })}
          </TableRow>
        ))}
        <TableRow style={{ borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}` }}>
          {rowKeys.map((k, ki) => (
            <TableCell key={`t_${k}`}>{ki === 0 ? <Text weight="semibold">Total</Text> : ''}</TableCell>
          ))}
          {pivotValues.map((pv) =>
            valueAliases.map((a, li) => {
              const colTotal = bodyRows.reduce((acc, row) => acc + (cellNum(row, pv, a) ?? 0), 0);
              return (
                <TableCell key={`t_${pv}_${li}`} style={{ textAlign: 'right' }}>
                  <Text weight="semibold">{formatValue(colTotal, nf)}</Text>
                </TableCell>
              );
            }),
          )}
          {valueAliases.map((a, li) => {
            const grand = bodyRows.reduce(
              (acc, row) => acc + pivotValues.reduce((s, pv) => s + (cellNum(row, pv, a) ?? 0), 0),
              0,
            );
            return (
              <TableCell key={`t_total_${li}`} style={{ textAlign: 'right' }}>
                <Text weight="semibold">{formatValue(grand, nf)}</Text>
              </TableCell>
            );
          })}
        </TableRow>
      </TableBody>
    </Table>
  );
  return <div className={styles.section} style={{ overflowX: 'auto', minWidth: 0 }}>{matrixEl}</div>;
}

// ── VisualBody ────────────────────────────────────────────────────────────────

export function VisualBody({ visual, state, styles, filters, selection, interactionMode, onSelect, onPageFilter, onSlicerStyle, themeChart, ai, script, reportId, onPointSelect, onPointHover, onExportData }: {
  visual: DVisual; state?: VisualState; styles: Styles; filters?: ReportFilter[];
  selection?: VisualSelection | null; interactionMode?: InteractionMode;
  onSelect?: (sel: VisualSelection | null) => void;
  onPageFilter?: (filter: ReportFilter | null, removeId: string) => void;
  onSlicerStyle?: (style: SlicerStyle) => void;
  themeChart?: ThemeChartProps; ai?: AiVisualWiring;
  script?: { onChange: (id: string, patch: { script?: string; language?: 'python' | 'r' }) => void };
  reportId?: string;
  onPointSelect?: (category: string) => void;
  onPointHover?: (category: string, coords: { x: number; y: number }) => void;
  onExportData?: () => void;
}) {
  if (AI_TYPES.has(visual.type)) {
    if (!ai) return <Caption1 className={styles.muted}>Preparing…</Caption1>;
    if (visual.type === 'smartNarrative') {
      return <SmartNarrative reportId={ai.reportId} pageRows={ai.pageRows} />;
    }
    if (visual.type === 'qna') {
      return <ReportQA reportId={ai.reportId} tables={ai.tables} queryAdHoc={ai.queryAdHoc} onApplyVisual={ai.onApplyVisual} />;
    }
    const aiWells = {
      analyze: visual.wells.values || [],
      explainBy: [...(visual.wells.category || []), ...(visual.wells.legend || [])],
    };
    if (visual.type === 'decompositionTree') {
      return <DecompositionTree wells={aiWells} queryAdHoc={ai.queryAdHoc} />;
    }
    return <KeyInfluencers wells={aiWells} queryAdHoc={ai.queryAdHoc} />;
  }
  if (SCRIPT_TYPES.has(visual.type)) {
    const onScriptChange = script?.onChange;
    return (
      <ScriptVisual
        reportId={ai?.reportId ?? reportId ?? ''}
        language={(visual.config?.language as 'python' | 'r') || 'python'}
        script={visual.config?.script || ''}
        rows={state?.rows || []}
        valueFields={visual.wells.values || []}
        onChange={onScriptChange ? (p) => onScriptChange(visual.id, p) : () => {}}
      />
    );
  }
  if (!hasBinding(visual)) {
    return <Caption1 className={styles.muted}>Add a field from the Fields pane to render this {visual.type}.</Caption1>;
  }
  if (!state || state.loading) return <Spinner size="tiny" label="Querying model…" />;
  if (state.err) return <MessageBar intent="error"><MessageBarBody>{state.err}</MessageBarBody></MessageBar>;
  const fmt = visual.format;
  const nf = fmt?.numberFormat;
  let rows = applyFilters(state.rows, filters || []);
  let dimmed: boolean[] = [];
  if (selection && interactionMode && interactionMode !== 'none' && selection.sourceId !== visual.id) {
    const chartLike = CHART_TYPES.has(visual.type);
    const mode: InteractionMode = interactionMode === 'highlight' && chartLike ? 'filter' : interactionMode;
    const res = applySelection(rows, selection, mode);
    rows = res.rows; dimmed = res.dimmed;
  }
  if (state.rows.length === 0) return <Caption1 className={styles.muted}>No rows returned.</Caption1>;
  if (rows.length === 0) return <Caption1 className={styles.muted}>No rows match the current selection.</Caption1>;
  const cols = Object.keys(rows[0]);
  const cf = applyConditionalFormat(rows, fmt?.conditionalFormat);

  if (KPI_TYPES.has(visual.type)) {
    const valKey = cols[0];
    const paint = cf.active ? cf.paintFor(valKey, rows[0][valKey]) : undefined;
    return (
      <div className={styles.section}>
        <div className={styles.kpi}
          style={{
            color: paint?.color, background: paint?.background,
            borderRadius: paint?.background ? tokens.borderRadiusMedium : undefined,
            paddingInline: paint?.background ? tokens.spacingHorizontalS : undefined,
          }}>
          {paint?.icon && (
            <span aria-hidden style={{ color: paint.icon.color, marginInlineEnd: tokens.spacingHorizontalXS }}>{paint.icon.glyph}</span>
          )}
          {formatValue(rows[0][valKey], nf)}
        </div>
      </div>
    );
  }

  if (GAUGE_KPI.has(visual.type)) {
    const numAt = (f?: WellField): number | undefined => {
      if (!f) return undefined;
      const cell = rows[0]?.[wellResultAlias(f)];
      return cellIsNumeric(cell) ? Number(cell) : undefined;
    };
    const tgt = numAt(visual.wells.target?.[0]);
    const lo = numAt(visual.wells.minimum?.[0]);
    const hi = numAt(visual.wells.maximum?.[0]);
    const lead = fmt?.dataColors?.[0];
    const wrapStyle = lead ? ({ '--colorBrandForeground1': lead } as unknown as CSSProperties) : undefined;
    const geom = visual.type === 'gauge'
      ? { target: tgt, gaugeMin: lo, gaugeMax: hi }
      : { kpiGoal: tgt, kpiTarget: hi };
    const gkType: string = visual.type === 'gauge' ? 'gauge' : 'kpi';
    return (
      <div style={wrapStyle}>
        <LoomChart type={gkType as LoomChartType} rows={rows} height={200} format={fmt} onExportData={onExportData} {...(geom as any)} />
      </div>
    );
  }

  if (visual.type === 'slicer') {
    const col = cols[0];
    const slcField = visual.wells.category?.[0] ?? null;
    const slcId = slicerFilterId(slcField, col);
    return (
      <SlicerVisual
        field={slcField}
        column={col}
        rows={state.rows}
        style={visual.config?.slicerStyle}
        value={(filters || []).find((f) => f.id === slcId) ?? null}
        onFilter={(f) => onPageFilter?.(f, slcId)}
        onStyleChange={onSlicerStyle}
        queryAdHoc={ai?.queryAdHoc}
        title={visual.title}
      />
    );
  }

  if (visual.type === 'map') {
    const mapReportId = ai?.reportId ?? reportId ?? '';
    const aliasOf = (w?: WellField[]) => (w && w.length ? wellResultAlias(w[0]) : undefined);
    return (
      <MapVisual
        reportId={mapReportId}
        rows={rows}
        cols={cols}
        numberFormat={nf}
        latitudeColumn={aliasOf(visual.wells.latitude)}
        longitudeColumn={aliasOf(visual.wells.longitude)}
        locationColumn={aliasOf(visual.wells.category)}
        sizeColumn={aliasOf(visual.wells.size)}
        legendColumn={aliasOf(visual.wells.legend)}
      />
    );
  }

  if (visual.type === 'scatter' && (((visual.wells.size?.length ?? 0) > 0) || ((visual.wells.playAxis?.length ?? 0) > 0))) {
    return (
      <BubblePlayBody
        rows={rows} cols={cols} fmt={fmt} styles={styles}
        hasSize={(visual.wells.size?.length ?? 0) > 0}
        hasPlay={(visual.wells.playAxis?.length ?? 0) > 0}
      />
    );
  }

  if (CHART_TYPES.has(visual.type)) {
    const hasNumeric = visual.type === 'scatter'
      || rows.some((r) => Object.values(r).some((v) => v != null && v !== '' && !Number.isNaN(Number(v))));
    if (hasNumeric) {
      const lead = fmt?.dataColors?.[0];
      const themeLead = themeChart && themeChart.palette[0] !== 'var(--colorBrandForeground1)' ? themeChart.palette[0] : undefined;
      const leadVar = lead || themeLead;
      const wrapStyle = leadVar ? ({ '--colorBrandForeground1': leadVar } as unknown as CSSProperties) : undefined;
      const refLines = CARTESIAN_TYPES.has(visual.type) ? computeReferenceLines(rows, visual.analytics) : [];
      const xLineIds = new Set<string>(
        ((((visual.analytics as { lines?: Array<{ id?: string; axis?: string }> } | undefined)?.lines) || [])
          .filter((l) => l?.axis === 'x')
          .map((l) => l?.id)
          .filter((id): id is string => typeof id === 'string')),
      );
      const orientedRefLines = refLines.map((rl) =>
        (xLineIds.has(rl.id) ? { ...rl, orientation: 'v' as const } : rl));
      const ebCats = chartCategories(rows);
      const errorBars: ChartErrorBar[] = CARTESIAN_TYPES.has(visual.type)
        ? computeErrorBars(rows, visual.analytics).flatMap((eb) =>
            eb.points.map((p) => ({ x: ebCats[p.index] ?? String(p.index), low: p.low, high: p.high, color: eb.color })))
        : [];
      let forecast: ChartForecast | undefined;
      if ((visual.type === 'line' || visual.type === 'area') && visual.analytics?.forecast?.length) {
        const cf2 = computeForecast(rows, visual.analytics.forecast[0]);
        if (cf2) forecast = {
          projected: cf2.points.map((p) => p.y),
          band: { low: cf2.points.map((p) => p.lower), high: cf2.points.map((p) => p.upper) },
          color: tokens.colorBrandForeground2,
        };
      }
      let symmetry: ChartSymmetry | undefined;
      if (visual.type === 'scatter') {
        const cs = computeSymmetry(rows, visual.analytics);
        if (cs) symmetry = { color: cs.color };
      }
      const aliasesOf = (a?: WellField[]) => (a || []).map(wellResultAlias);
      const facetColumn = visual.wells.smallMultiples?.[0]?.column || undefined;
      const detailColumn = (visual.type === 'treemap' && visual.wells.details?.[0]?.column) || undefined;
      const tooltipAliases = aliasesOf(visual.wells.tooltips);
      const comboLineSeries = aliasesOf(visual.wells.secondaryValues);
      const stackingRaw = (fmt as { stacking?: string } | undefined)?.stacking;
      const stackMode = stackingRaw === 'stacked' || stackingRaw === 'stacked100' ? stackingRaw : 'none';
      const anomalies = CARTESIAN_TYPES.has(visual.type)
        ? computeAnomalyOverlay(rows, (visual.analytics as { anomalies?: unknown[] } | undefined)?.anomalies, ebCats)
        : undefined;
      const shadedRangesRaw = (visual.analytics as { shadedRanges?: unknown[] } | undefined)?.shadedRanges;
      const shadedRanges = Array.isArray(shadedRangesRaw) && shadedRangesRaw.length ? shadedRangesRaw : undefined;
      const geomProps: Record<string, unknown> = {
        stackMode,
        comboLineSeries,
        ...(facetColumn ? { smallMultiples: { facetColumn } } : {}),
        ...(detailColumn ? { detailColumn } : {}),
        ...(tooltipAliases.length ? { tooltips: tooltipAliases } : {}),
        ...(anomalies ? { anomalies } : {}),
        ...(shadedRanges ? { shadedRanges } : {}),
      };
      const chartCtx: ChartAdapterContext = {
        visualType: visual.type,
        rows,
        themeChart,
        perVisualLead: leadVar,
      };
      const adapter = formatToChartProps(fmt, chartCtx);
      const titleMeasureValues = fmt?.title?.conditionalField
        ? measureAggregates(rows, cols)
        : undefined;
      return (
        <div style={wrapStyle}>
          <VisualChrome chrome={adapter.axisChrome} format={fmt} fallbackTitle={visual.title} measureValues={titleMeasureValues}>
            <LoomChart type={(CHART_RENDER[visual.type] || 'column') as LoomChartType} rows={adapter.rows} height={200}
              refLines={orientedRefLines} errorBars={errorBars} forecast={forecast} symmetry={symmetry}
              onPointSelect={onPointSelect} onPointHover={onPointHover} onExportData={onExportData}
              {...(adapter.chartProps as any)} {...(geomProps as any)} />
          </VisualChrome>
          {refLines.length > 0 && (
            <div className={styles.refLineRow}>
              {refLines.map((rl) => (
                <span key={rl.id} className={styles.refLineChip} title={rl.label || rl.kind}>
                  <span className={styles.refLineDot} style={{ backgroundColor: rl.color }} aria-hidden />
                  <Caption1>{rl.label || rl.kind}</Caption1>
                </span>
              ))}
            </div>
          )}
        </div>
      );
    }
  }

  if (visual.type === 'multiRowCard') {
    return (
      <div className={styles.cardList}>
        {rows.slice(0, 60).map((row, ri) => (
          <div key={ri} className={styles.cardRow}>
            {cols.map((c) => {
              const paint = cf.active ? cf.paintFor(c, row[c]) : undefined;
              return (
                <div key={c} className={styles.cardField}>
                  <Caption1 className={styles.muted}>{c}</Caption1>
                  <Text weight="semibold" style={{ color: paint?.color }}>
                    {paint?.icon && (
                      <span aria-hidden style={{ color: paint.icon.color, marginInlineEnd: tokens.spacingHorizontalXXS }}>{paint.icon.glyph}</span>
                    )}
                    {formatValue(row[c], nf)}
                  </Text>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  }

  if (visual.type === 'matrix') {
    const legendField = visual.wells.legend?.[0];
    const valueFields = visual.wells.values || [];
    if (legendField && (legendField.column || legendField.measure) && valueFields.length > 0) {
      const pivotKey = legendField.column ?? legendField.measure ?? '';
      const rowKeys = (visual.wells.category || [])
        .map((f) => f.column ?? f.measure ?? '')
        .filter((k) => k && cols.includes(k));
      const valueAliases = valueFields.map(wellResultAlias);
      const valueLabels = valueFields.map(fieldLabel);
      if (pivotKey && cols.includes(pivotKey) && valueAliases.every((a) => cols.includes(a))) {
        return (
          <MatrixPivotTable
            rows={rows}
            rowKeys={rowKeys}
            pivotKey={pivotKey}
            valueAliases={valueAliases}
            valueLabels={valueLabels}
            nf={nf}
            styles={styles}
          />
        );
      }
    }
  }

  const matrixDrill = visual.type === 'matrix' && !!onPointSelect;
  const fireDrill = (row: Record<string, unknown>) => {
    if (onSelect) onSelect(selectionFromRow(visual.id, row, [cols[0]]));
    onPointSelect?.(String(row[cols[0]] ?? ''));
  };
  const exportOverflow = onExportData ? (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Button size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label="Visual options" />
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem onClick={onExportData}>Export data</MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  ) : null;
  const tableEl = (
    <Table size="small">
      <TableHeader><TableRow>{cols.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
      <TableBody>
        {rows.slice(0, 100).map((row, ri) => (
          <TableRow key={ri}
            style={{ opacity: dimmed[ri] ? 0.35 : undefined, cursor: onSelect ? 'pointer' : undefined }}
            onClick={onSelect ? () => onSelect(selectionFromRow(visual.id, row, [cols[0]])) : undefined}>
            {cols.map((c, ci) => {
              const paint = cf.active ? cf.paintFor(c, row[c]) : undefined;
              const drillCell = matrixDrill && ci === 0;
              const member = drillCell ? String(row[cols[0]] ?? '') : '';
              return (
                <TableCell key={c} style={{ background: paint?.background, color: paint?.color }}>
                  {paint?.icon && (
                    <span aria-hidden style={{ color: paint.icon.color, marginInlineEnd: tokens.spacingHorizontalXXS }}>{paint.icon.glyph}</span>
                  )}
                  {drillCell ? (
                    <span role="button" tabIndex={0}
                      aria-label={`Drill down into ${member || '(blank)'}`}
                      title={`Drill down into ${member || '(blank)'}`}
                      style={{ cursor: 'pointer', color: paint?.color || tokens.colorBrandForeground1, display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS }}
                      onClick={(e) => { e.stopPropagation(); fireDrill(row); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); fireDrill(row); } }}>
                      <ArrowExpand16Regular aria-hidden />
                      {formatValue(row[c], nf)}
                    </span>
                  ) : (
                    formatValue(row[c], nf)
                  )}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
  if (!exportOverflow) return tableEl;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>{exportOverflow}</div>
      {tableEl}
    </div>
  );
}

// ── TooltipPageContent ────────────────────────────────────────────────────────

export function TooltipPageContent({ visuals, seed, queryAdHoc, styles, themeChart, reportId }: {
  visuals: DVisual[];
  seed: ReportFilterInput;
  queryAdHoc: (spec: CopilotVisualSpec, filters?: ReportFilterInput[]) => Promise<Array<Record<string, unknown>>>;
  styles: Styles;
  themeChart?: ThemeChartProps;
  reportId: string;
}) {
  const [rows, setRows] = useState<Record<string, VisualState>>({});
  const seedKey = JSON.stringify(seed);
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const v of visuals) {
        if (!hasBinding(v) || AI_SELF_QUERY.has(v.type) || SCRIPT_TYPES.has(v.type)) continue;
        setRows((p) => ({ ...p, [v.id]: { rows: p[v.id]?.rows || [], loading: true, err: null } }));
        try {
          const spec = queryVisual(v) as unknown as CopilotVisualSpec;
          const r = await queryAdHoc(spec, [seed]);
          if (alive) setRows((p) => ({ ...p, [v.id]: { rows: r, loading: false, err: null } }));
        } catch (e: any) {
          if (alive) setRows((p) => ({ ...p, [v.id]: { rows: [], loading: false, err: e?.message || String(e) } }));
        }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visuals.map((v) => v.id).join('~'), seedKey]);
  const shown = visuals.filter((v) => hasBinding(v) && !AI_SELF_QUERY.has(v.type) && !SCRIPT_TYPES.has(v.type)).slice(0, 4);
  if (shown.length === 0) return <Caption1 className={styles.muted}>This tooltip page has no bound visuals.</Caption1>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
      {shown.map((v) => (
        <div key={v.id}>
          {(v.format?.showTitle !== false) && <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>{v.title}</Caption1>}
          <VisualBody visual={v} state={rows[v.id]} styles={styles} themeChart={themeChart} reportId={reportId} />
        </div>
      ))}
    </div>
  );
}

// ── BubblePlayBody ────────────────────────────────────────────────────────────

export function BubblePlayBody({ rows, cols, fmt, styles, hasSize, hasPlay }: {
  rows: Array<Record<string, unknown>>; cols: string[]; fmt?: ReportVisualFormat;
  styles: Styles; hasSize: boolean; hasPlay: boolean;
}) {
  const { cats, nums } = splitCols(rows, cols);
  const playCol = hasPlay && cats.length >= 2 ? cats[cats.length - 1] : null;
  const frames = useMemo(() => {
    if (!playCol) return [] as string[];
    const seen: string[] = [];
    for (const r of rows) { const v = String(r[playCol] ?? '—'); if (!seen.includes(v)) seen.push(v); }
    return seen;
  }, [rows, playCol]);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const safeFrame = frames.length ? Math.min(frame, frames.length - 1) : 0;
  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % frames.length), 1100);
    return () => clearInterval(t);
  }, [playing, frames.length]);
  useEffect(() => { if (frame > Math.max(0, frames.length - 1)) setFrame(0); }, [frames.length, frame]);
  const frameRows = playCol ? rows.filter((r) => String(r[playCol] ?? '—') === (frames[safeFrame] ?? '')) : rows;
  const xKey = nums[0];
  const yKey = nums[1] ?? nums[0];
  const rKey = hasSize ? nums[nums.length - 1] : undefined;
  const labelKey = cats.find((c) => c !== playCol) ?? cats[0];
  if (!xKey) {
    return <Caption1 className={styles.muted}>Add an X and a Y measure to the Values well to plot a bubble chart.</Caption1>;
  }
  const W = 520, H = 220, padL = 48, padR = 14, padT = 12, padB = 30;
  const pts = frameRows.map((r) => ({
    x: cellIsNumeric(r[xKey]) ? Number(r[xKey]) : 0,
    y: cellIsNumeric(r[yKey]) ? Number(r[yKey]) : 0,
    r: rKey && cellIsNumeric(r[rKey]) ? Number(r[rKey]) : 0,
    label: labelKey ? String(r[labelKey] ?? '—') : '—',
  }));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y), rs = pts.map((p) => p.r);
  const xMin = Math.min(...xs, 0), xMax = Math.max(...xs, 1);
  const yMin = Math.min(...ys, 0), yMax = Math.max(...ys, 1);
  const rMax = Math.max(...rs, 1);
  const xSpan = (xMax - xMin) || 1, ySpan = (yMax - yMin) || 1;
  const xPix = (v: number) => padL + ((v - xMin) / xSpan) * (W - padL - padR);
  const yPix = (v: number) => padT + (H - padT - padB) - ((v - yMin) / ySpan) * (H - padT - padB);
  const rPix = (v: number) => 4 + (rKey ? (Math.sqrt(Math.max(v, 0)) / Math.sqrt(rMax)) * 18 : 0);
  const lead = fmt?.dataColors?.[0] || tokens.colorBrandForeground1;
  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`bubble chart${rKey ? ' with size encoding' : ''}`}
        style={{ display: 'block', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, background: tokens.colorNeutralBackground1, overflow: 'visible' }}>
        <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke={tokens.colorNeutralStroke2} strokeWidth={1} />
        <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke={tokens.colorNeutralStroke2} strokeWidth={1} />
        <text x={padL - 4} y={padT + 6} fontSize={9} textAnchor="end" fill={tokens.colorNeutralForeground3}>{yKey}</text>
        <text x={W - padR} y={H - padB + 14} fontSize={9} textAnchor="end" fill={tokens.colorNeutralForeground3}>{xKey}</text>
        {pts.map((p, i) => (
          <circle key={i} cx={xPix(p.x)} cy={yPix(p.y)} r={rPix(p.r)}
            fill={lead} opacity={0.55} stroke={tokens.colorNeutralBackground1} strokeWidth={0.8}>
            <title>{`${p.label}\n${xKey}: ${p.x.toLocaleString()}, ${yKey}: ${p.y.toLocaleString()}${rKey ? `, ${rKey}: ${p.r.toLocaleString()}` : ''}`}</title>
          </circle>
        ))}
      </svg>
      <div className={styles.approxNote}>
        <Info16Regular aria-hidden />
        <Caption1>
          X = {xKey}, Y = {yKey}{rKey ? `, bubble size = ${rKey}` : ''}
          {playCol ? ` · animated by ${playCol}` : ''}.
        </Caption1>
      </div>
      {playCol && frames.length > 1 && (
        <div className={styles.playRow}>
          <Button size="small" appearance="subtle" aria-label={playing ? 'Pause' : 'Play'}
            icon={playing ? <Pause20Regular /> : <Play20Regular />} onClick={() => setPlaying((p) => !p)} />
          <Slider className={styles.playSlider} min={0} max={frames.length - 1} value={safeFrame}
            aria-label={`Play axis frame: ${playCol}`}
            onChange={(_e, d) => { setPlaying(false); setFrame(d.value); }} />
          <Badge appearance="tint" color="brand">{frames[safeFrame]}</Badge>
        </div>
      )}
    </div>
  );
}
