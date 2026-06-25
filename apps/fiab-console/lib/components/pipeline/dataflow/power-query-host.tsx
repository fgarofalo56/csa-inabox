'use client';

/**
 * PowerQueryHost — Power Query Online-parity authoring surface for Dataflow
 * Gen2 on the Azure-native backend (no Fabric required).
 *
 * Mirrors the real Power Query Online / ADF "Power Query" editor layout:
 *   - Ribbon (Home / Transform / Add column) — each button appends a real M
 *     transform step chaining off the previous applied step.
 *   - Formula bar — edit the selected applied step's M expression inline.
 *   - Queries pane (left) — add / select / rename / delete named queries.
 *   - Applied Steps pane (right) — the let-block steps of the active query;
 *     select / rename / delete steps.
 *   - Data preview (center) — honest-gated: ADF has no inline M-eval endpoint,
 *     so preview rows come from a real ADF run (Output tab → Run), surfaced via
 *     a Fluent MessageBar rather than fabricated sample rows.
 *
 * The M script stays the single source of truth: every edit recomputes the M
 * and emits it via onChange, so what you see is exactly what Save persists and
 * Run compiles into an ADF WranglingDataFlow.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Body1, Body1Strong, Button, Input, Tab, TabList,
  Tooltip, MessageBar, MessageBarBody, MessageBarTitle, Badge,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Add16Regular, Delete16Regular, Table16Regular, ChevronRight16Regular,
  TableSettings20Regular, NumberSymbolSquare20Regular,
} from '@fluentui/react-icons';
import {
  parseSharedQueries, parseLetBody, buildLetBody, setQueryBody,
  appendStep, renameIdentifier, RIBBON_TRANSFORMS, type RibbonTransform,
} from './m-script';
import {
  CATEGORY_ACCENT, CATEGORY_ICON, accentTint, accentGradient,
} from '@/lib/components/canvas/canvas-node-kit';
import { EmptyState } from '@/lib/components/empty-state';

/**
 * Power Query is a data-wrangling surface → it belongs to the kit's `transform`
 * category. Reuse the SAME accent (violet) + section glyph the mapping-data-flow
 * transform nodes use, so this frame reads as the same product as the canvas.
 */
const PQ_ACCENT = CATEGORY_ACCENT.transform;
const PQ_GLYPH = CATEGORY_ICON.transform;

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, flex: 1, minHeight: 0 },
  // Shared elevated-card chrome for every panel (ribbon / formula bar / panes / center).
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    backgroundColor: tokens.colorNeutralBackground1,
    transitionProperty: 'box-shadow, border-color',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': { boxShadow: tokens.shadow8 },
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  ribbon: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalS,
  },
  ribbonRow: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', alignItems: 'center' },
  formulaBar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXXS, paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS,
  },
  // Accent-tinted "fx" chip, mirroring the kit's iconChip.
  fxChip: {
    flexShrink: 0,
    width: '28px', height: '28px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontStyle: 'italic', fontWeight: tokens.fontWeightBold,
    background: accentGradient(PQ_ACCENT), color: PQ_ACCENT,
    border: `1px solid ${accentTint(PQ_ACCENT, 24)}`,
  },
  body: { display: 'flex', gap: tokens.spacingHorizontalM, flex: 1, minHeight: '320px' },
  pane: {
    width: '244px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalS, overflow: 'auto',
  },
  center: {
    flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  paneHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalXS },
  paneTitle: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  // Accent-tinted section glyph chip on pane / center headers (matches palette + node headers).
  headerIcon: {
    flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '28px', height: '28px',
    borderRadius: tokens.borderRadiusMedium,
    background: accentTint(PQ_ACCENT, 14), color: PQ_ACCENT,
  },
  listItem: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    paddingTop: tokens.spacingVerticalXXS, paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalXS, paddingRight: tokens.spacingHorizontalXS,
    borderRadius: tokens.borderRadiusMedium, cursor: 'pointer',
    transitionProperty: 'background-color',
    transitionDuration: tokens.durationFaster,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  listItemActive: {
    backgroundColor: accentTint(PQ_ACCENT, 12),
    boxShadow: `inset 3px 0 0 0 ${PQ_ACCENT}`,
  },
  listIcon: { flexShrink: 0, color: PQ_ACCENT, display: 'inline-flex', alignItems: 'center' },
  itemText: {
    flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase300,
  },
  fillInput: { flex: 1 },
  hint: { marginTop: 'auto', color: tokens.colorNeutralForeground3 },
  mPreviewLabel: { color: tokens.colorNeutralForeground3 },
  mPreview: {
    margin: 0,
    padding: tokens.spacingHorizontalM,
    overflow: 'auto',
    background: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke3}`,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'pre-wrap',
  },
});

const RIBBON_TABS: Array<{ id: RibbonTransform['tab']; label: string }> = [
  { id: 'home', label: 'Home' },
  { id: 'transform', label: 'Transform' },
  { id: 'addColumn', label: 'Add column' },
];

export interface PowerQueryHostProps {
  /** The Power Query M script (single source of truth). */
  mScript: string;
  /** Emit the next M script on any edit. */
  onChange: (nextM: string) => void;
  readOnly?: boolean;
  /** Notified whenever the active query changes (so a docked Copilot pane can
   *  target the same query the user is editing). Fires on mount + selection. */
  onActiveQueryChange?: (name: string) => void;
}

export function PowerQueryHost({ mScript, onChange, readOnly = false, onActiveQueryChange }: PowerQueryHostProps) {
  const s = useStyles();
  const queries = useMemo(() => parseSharedQueries(mScript), [mScript]);
  const [activeQuery, setActiveQuery] = useState<string>(queries[0]?.name || '');
  const [activeStepIdx, setActiveStepIdx] = useState<number>(0);
  const [ribbonTab, setRibbonTab] = useState<RibbonTransform['tab']>('home');
  const [renaming, setRenaming] = useState<{ kind: 'query' | 'step'; value: string } | null>(null);

  const current = queries.find((q) => q.name === activeQuery) || queries[0];
  const parsed = useMemo(() => (current ? parseLetBody(current.body) : { steps: [], result: '' }), [current]);

  // Report the resolved active query name up to a docked Copilot pane.
  const currentName = current?.name || '';
  useEffect(() => { onActiveQueryChange?.(currentName); }, [currentName, onActiveQueryChange]);

  const steps = parsed.steps;
  const safeStepIdx = Math.min(activeStepIdx, Math.max(0, steps.length - 1));
  const activeStep = steps[safeStepIdx];

  const emitQueryBody = useCallback((queryName: string, body: string) => {
    onChange(setQueryBody(mScript, queryName, body));
  }, [mScript, onChange]);

  // ---- Queries ----
  const addQuery = useCallback(() => {
    if (readOnly) return;
    const existing = new Set(queries.map((q) => q.name));
    let n = queries.length + 1;
    let name = `Query${n}`;
    while (existing.has(name)) { n += 1; name = `Query${n}`; }
    const body = 'let\n    Source = #table({"col1","col2"}, {{"hello","world"}})\nin\n    Source';
    let next = mScript;
    if (!/^\s*section\s/m.test(next)) next = `section Section1;\n${next}`;
    onChange(`${next.replace(/\s*$/, '')}\nshared ${name} = ${body};\n`);
    setActiveQuery(name);
    setActiveStepIdx(0);
  }, [readOnly, queries, mScript, onChange]);

  const deleteQuery = useCallback((name: string) => {
    if (readOnly) return;
    const remaining = queries.filter((q) => q.name !== name);
    const rebuilt = `section Section1;\n\n${remaining.map((q) => `shared ${q.name} = ${q.body};`).join('\n\n')}\n`;
    onChange(rebuilt);
    if (activeQuery === name) { setActiveQuery(remaining[0]?.name || ''); setActiveStepIdx(0); }
  }, [readOnly, queries, onChange, activeQuery]);

  const commitRenameQuery = useCallback((oldName: string, newName: string) => {
    const trimmed = newName.trim();
    setRenaming(null);
    if (readOnly || !trimmed || trimmed === oldName) return;
    if (queries.some((q) => q.name === trimmed)) return;
    // Rename the declaration + every cross-query reference.
    const renamed = renameIdentifier(mScript, oldName, trimmed)
      .replace(new RegExp(`shared\\s+#?"?${oldName}"?\\s*=`), `shared ${trimmed} =`);
    onChange(renamed);
    setActiveQuery(trimmed);
  }, [readOnly, queries, mScript, onChange]);

  // ---- Steps ----
  const updateStepExpr = useCallback((idx: number, expr: string) => {
    if (readOnly || !current) return;
    const nextSteps = steps.map((st, i) => (i === idx ? { ...st, expr } : st));
    emitQueryBody(current.name, buildLetBody(nextSteps, parsed.result));
  }, [readOnly, current, steps, parsed.result, emitQueryBody]);

  const deleteStep = useCallback((idx: number) => {
    if (readOnly || !current || steps.length <= 1) return;
    const nextSteps = steps.filter((_, i) => i !== idx);
    const result = parsed.result === steps[idx].name ? nextSteps[nextSteps.length - 1].name : parsed.result;
    emitQueryBody(current.name, buildLetBody(nextSteps, result));
    setActiveStepIdx(Math.max(0, idx - 1));
  }, [readOnly, current, steps, parsed.result, emitQueryBody]);

  const commitRenameStep = useCallback((oldName: string, newName: string) => {
    const trimmed = newName.trim();
    setRenaming(null);
    if (readOnly || !current || !trimmed || trimmed === oldName) return;
    if (steps.some((st) => st.name === trimmed)) return;
    // Rename within this query body only (steps are query-scoped).
    const newBody = renameIdentifier(current.body, oldName, trimmed);
    emitQueryBody(current.name, newBody);
  }, [readOnly, current, steps, emitQueryBody]);

  const applyTransform = useCallback((t: RibbonTransform) => {
    if (readOnly || !current) return;
    const newBody = appendStep(current.body, t);
    emitQueryBody(current.name, newBody);
    const after = parseLetBody(newBody);
    setActiveStepIdx(Math.max(0, after.steps.length - 1));
  }, [readOnly, current, emitQueryBody]);

  const ribbonButtons = RIBBON_TRANSFORMS.filter((t) => t.tab === ribbonTab);

  if (queries.length === 0) {
    return (
      <div className={s.root}>
        <EmptyState
          icon={PQ_GLYPH}
          title="No queries yet"
          body="This dataflow has no Power Query declarations the visual editor can read. Add one to start shaping data with the ribbon, or author raw M on the Script (M) tab."
          primaryAction={readOnly
            ? undefined
            : { label: 'Add query', appearance: 'primary', onClick: addQuery }}
        />
      </div>
    );
  }

  return (
    <div className={s.root}>
      {/* Ribbon */}
      <div className={mergeClasses(s.card, s.ribbon)}>
        <TabList selectedValue={ribbonTab} onTabSelect={(_, d) => setRibbonTab(d.value as RibbonTransform['tab'])} size="small">
          {RIBBON_TABS.map((t) => <Tab key={t.id} value={t.id}>{t.label}</Tab>)}
        </TabList>
        <div className={s.ribbonRow}>
          {ribbonButtons.map((t) => (
            <Tooltip key={t.key} content={`Append: ${t.label}`} relationship="label">
              <Button size="small" appearance="subtle" disabled={readOnly || !current} onClick={() => applyTransform(t)}>
                {t.label}
              </Button>
            </Tooltip>
          ))}
        </div>
      </div>

      {/* Formula bar */}
      <div className={mergeClasses(s.card, s.formulaBar)}>
        <span className={s.fxChip} aria-hidden="true">fx</span>
        <Input
          appearance="filled-lighter"
          className={s.fillInput}
          value={activeStep?.expr || ''}
          placeholder={activeStep ? '' : 'Select an applied step'}
          disabled={readOnly || !activeStep}
          onChange={(_, d) => updateStepExpr(safeStepIdx, d.value)}
          aria-label="Step formula (M)"
        />
      </div>

      <div className={s.body}>
        {/* Queries pane */}
        <div className={mergeClasses(s.card, s.pane)} role="navigation" aria-label="Queries">
          <div className={s.paneHeader}>
            <span className={s.paneTitle}>
              <span className={s.headerIcon} aria-hidden="true"><TableSettings20Regular /></span>
              <Subtitle2>Queries</Subtitle2>
            </span>
            <Tooltip content="New query" relationship="label">
              <Button size="small" appearance="subtle" icon={<Add16Regular />} onClick={addQuery} disabled={readOnly} aria-label="New query" />
            </Tooltip>
          </div>
          {queries.map((q) => (
            <div
              key={q.name}
              className={mergeClasses(s.listItem, q.name === activeQuery && s.listItemActive)}
              onClick={() => { setActiveQuery(q.name); setActiveStepIdx(0); }}
              onDoubleClick={() => setRenaming({ kind: 'query', value: q.name })}
              role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') { setActiveQuery(q.name); setActiveStepIdx(0); } }}
            >
              <span className={s.listIcon} aria-hidden="true"><Table16Regular /></span>
              {renaming?.kind === 'query' && q.name === activeQuery ? (
                <Input
                  size="small" className={s.fillInput} defaultValue={q.name} autoFocus
                  onBlur={(e) => commitRenameQuery(q.name, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitRenameQuery(q.name, (e.target as HTMLInputElement).value); if (e.key === 'Escape') setRenaming(null); }}
                  aria-label="Rename query"
                />
              ) : (
                <span className={s.itemText}>{q.name === activeQuery ? <Body1Strong>{q.name}</Body1Strong> : q.name}</span>
              )}
              {q.name === activeQuery && queries.length > 1 && (
                <Tooltip content="Delete query" relationship="label">
                  <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={readOnly}
                    onClick={(e) => { e.stopPropagation(); deleteQuery(q.name); }} aria-label="Delete query" />
                </Tooltip>
              )}
            </div>
          ))}
          <Caption1 className={s.hint}>
            Double-click a query to rename.
          </Caption1>
        </div>

        {/* Data preview (honest-gated) */}
        <div className={mergeClasses(s.card, s.center)}>
          <div className={s.paneHeader}>
            <span className={s.paneTitle}>
              <span className={s.headerIcon} aria-hidden="true"><Table16Regular /></span>
              <Body1Strong>Data preview — {current?.name}</Body1Strong>
            </span>
            <Badge appearance="tint" color="informative">{steps.length} step{steps.length === 1 ? '' : 's'}</Badge>
          </div>
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Live preview runs on ADF Spark</MessageBarTitle>
              ADF has no inline Power Query evaluation endpoint, so Loom does not fabricate
              sample rows. Set an Output destination, then <strong>Save &amp; Run</strong> to
              execute this mashup on ADF and write real rows. Opt into Fabric
              (<code>LOOM_DATAFLOW_BACKEND=fabric</code> + a bound workspace) for inline preview.
            </MessageBarBody>
          </MessageBar>
          <Body1 className={s.mPreviewLabel}>
            Applied step expression (M):
          </Body1>
          <pre className={s.mPreview}>
            {activeStep ? `${activeStep.name} =\n    ${activeStep.expr}` : '— select an applied step —'}
          </pre>
        </div>

        {/* Applied steps pane */}
        <div className={mergeClasses(s.card, s.pane)} role="navigation" aria-label="Applied steps">
          <div className={s.paneHeader}>
            <span className={s.paneTitle}>
              <span className={s.headerIcon} aria-hidden="true"><NumberSymbolSquare20Regular /></span>
              <Subtitle2>Applied steps</Subtitle2>
            </span>
          </div>
          {steps.map((st, i) => (
            <div
              key={`${st.name}-${i}`}
              className={mergeClasses(s.listItem, i === safeStepIdx && s.listItemActive)}
              onClick={() => setActiveStepIdx(i)}
              onDoubleClick={() => setRenaming({ kind: 'step', value: st.name })}
              role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') setActiveStepIdx(i); }}
            >
              <span className={s.listIcon} aria-hidden="true"><ChevronRight16Regular /></span>
              {renaming?.kind === 'step' && i === safeStepIdx ? (
                <Input
                  size="small" className={s.fillInput} defaultValue={st.name} autoFocus
                  onBlur={(e) => commitRenameStep(st.name, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitRenameStep(st.name, (e.target as HTMLInputElement).value); if (e.key === 'Escape') setRenaming(null); }}
                  aria-label="Rename step"
                />
              ) : (
                <span className={s.itemText}>{st.name}</span>
              )}
              {i === safeStepIdx && steps.length > 1 && (
                <Tooltip content="Delete step" relationship="label">
                  <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={readOnly}
                    onClick={(e) => { e.stopPropagation(); deleteStep(i); }} aria-label="Delete step" />
                </Tooltip>
              )}
            </div>
          ))}
          <Caption1 className={s.hint}>
            Double-click a step to rename. Add steps from the ribbon.
          </Caption1>
        </div>
      </div>
    </div>
  );
}
