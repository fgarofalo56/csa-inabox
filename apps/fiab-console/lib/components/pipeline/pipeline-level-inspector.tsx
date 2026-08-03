'use client';

/**
 * PipelineLevelInspector — what the bottom dock shows when NOTHING is selected.
 *
 * Fabric parity, verbatim from Learn (fabric/data-factory/pipeline-canvas-experience,
 * "Canvas and pipeline settings"):
 *
 *   "When no activity is selected, the configuration pane at the bottom of the
 *    canvas shows pipeline-level settings. These settings include:
 *      1. Parameters …  2. Variables …  3. Settings …  4. Output …"
 *
 * Before this the same slot rendered a single "No activity selected" `EmptyState`
 * card. That card carries `minHeight: 320px`, which under `box-sizing: border-box`
 * is a HARD FLOOR — inside an unbounded, `flexShrink: 0` dock it took 320px of a
 * 552px column and left the canvas ~96px, i.e. invisible. So this module is both
 * the parity fix and half of the layout fix: everything here lives inside the
 * dock's own scrolling body and imposes no minimum height on its container.
 *
 * NO FABRICATED DATA (`no-vaporware.md`): every row rendered here comes from the
 * live pipeline the designer is editing — the same `parameters` / `variables` /
 * `activities` arrays the canvas and the host editor's tab row read and write.
 * Nothing is stubbed, and no control is rendered unless it does something: the
 * "open the host tab" buttons appear only when the host actually supplies
 * `onOpenPipelineTab`.
 *
 * Where Fabric's **Settings** and **Output** tabs live in Loom: the host editor's
 * pipeline-configurations tab row (PipelineEditorCore — Parameters / Variables /
 * Settings / Code / Output), which is ADF Studio's own arrangement. The Settings
 * tab here surfaces the real pipeline-level facts and, when the host wires it,
 * one-click navigation to those panes.
 *
 * Token discipline (web3-ui): every colour / space / radius is a Fluent v9
 * `tokens.*` value. This file has no default export.
 */

import {
  Badge, Body1, Button, Caption1, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add16Regular, Open16Regular, Settings20Regular, TableSimple20Regular,
} from '@fluentui/react-icons';
import { activityIssueCount, activityDisplayLabel, countIssuesDeep } from './pipeline-validation';
import { getActivityVisual } from '@/lib/components/canvas/canvas-node-kit';
import type { DockedInspectorTab } from '@/lib/components/shared/docked-inspector';
import type { PipelineActivity, PipelineParameter, PipelineVariable } from './types';

/** Host tab the dock can navigate to (matches PipelineEditorCore's tab row). */
export type PipelineHostTab = 'parameters' | 'variables' | 'settings' | 'runs';

const useStyles = makeStyles({
  pane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  hint: { color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  // Real table — content never butts the borders (web3-ui §3).
  table: {
    display: 'flex', flexDirection: 'column',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
    minWidth: 0,
  },
  headRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) minmax(0, 2fr)',
    gap: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
  },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) minmax(0, 2fr)',
    gap: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    minWidth: 0,
  },
  cell: { minWidth: 0, overflowWrap: 'anywhere', color: tokens.colorNeutralForeground1 },
  cellMuted: { minWidth: 0, overflowWrap: 'anywhere', color: tokens.colorNeutralForeground3 },
  // Clickable activity row — selects the node on the canvas.
  activityRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    cursor: 'pointer', minWidth: 0, textAlign: 'left', width: '100%',
    backgroundColor: 'transparent',
    borderTopStyle: 'none', borderLeftStyle: 'none', borderRightStyle: 'none',
    transitionProperty: 'background-color',
    transitionDuration: tokens.durationFaster,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '-2px' },
    '@media (prefers-reduced-motion: reduce)': { transitionProperty: 'none' },
  },
  activityDot: {
    flexShrink: 0, width: '10px', height: '10px',
    borderRadius: tokens.borderRadiusCircular,
  },
  activityName: { flex: 1, minWidth: 0, overflowWrap: 'anywhere', color: tokens.colorNeutralForeground1 },
  // Badge rows wrap + truncate — never overlap at any width (ux-baseline §5).
  badgeRow: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 },
  factGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))',
    gap: tokens.spacingHorizontalM,
    minWidth: 0,
  },
  fact: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingHorizontalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
    minWidth: 0,
  },
  factValue: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1 },
  factLabel: { color: tokens.colorNeutralForeground3 },
});

/** Render a parameter/variable default for display without inventing one. */
function formatDefault(v: unknown): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'string') return v === '' ? '(empty string)' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

export interface PipelineLevelInspectorInput {
  /** Live pipeline parameters (the same array the host's Parameters tab edits). */
  parameters: PipelineParameter[];
  /** Live pipeline variables. */
  variables: PipelineVariable[];
  /** Activities at the CURRENT drill level. */
  levelActivities: PipelineActivity[];
  /** Select an activity on the canvas (opens its properties in this same dock). */
  onSelectActivity?: (name: string) => void;
  /** Navigate the host editor's pipeline-configurations tab row. Omit → no buttons. */
  onOpenPipelineTab?: (tab: PipelineHostTab) => void;
}

/**
 * Build the no-selection dock's tabs. A hook (not a component) so the caller
 * keeps owning `DockedInspector`'s controlled tab state — same contract every
 * other docked inspector in the console uses.
 */
export function usePipelineLevelTabs({
  parameters, variables, levelActivities, onSelectActivity, onOpenPipelineTab,
}: PipelineLevelInspectorInput): DockedInspectorTab[] {
  const s = useStyles();

  const openButton = (tab: PipelineHostTab, label: string) => (
    onOpenPipelineTab
      ? (
        <div className={s.actions}>
          <Button
            size="small"
            appearance="primary"
            icon={<Open16Regular />}
            onClick={() => onOpenPipelineTab(tab)}
          >
            {label}
          </Button>
        </div>
      )
      : null
  );

  const paramsTab: DockedInspectorTab = {
    id: 'pipeline-parameters',
    label: `Parameters (${parameters.length})`,
    content: (
      <div className={s.pane} data-pipeline-level="parameters">
        <Caption1 className={s.hint}>
          Pipeline parameters are supplied at run time and referenced from any activity
          with <code>@pipeline().parameters.&lt;name&gt;</code>.
        </Caption1>
        {parameters.length === 0 ? (
          <Body1 className={s.hint}>
            No parameters defined yet — add one to make this pipeline reusable across runs.
          </Body1>
        ) : (
          <div className={s.table} role="table" aria-label="Pipeline parameters">
            <div className={s.headRow} role="row">
              <span role="columnheader">Name</span>
              <span role="columnheader">Type</span>
              <span role="columnheader">Default value</span>
            </div>
            {parameters.map((p) => (
              <div className={s.row} role="row" key={p.name} data-parameter={p.name}>
                <span className={s.cell} role="cell">{p.name}</span>
                <span className={s.cellMuted} role="cell">{p.type}</span>
                <span className={s.cellMuted} role="cell">{formatDefault(p.defaultValue)}</span>
              </div>
            ))}
          </div>
        )}
        {openButton('parameters', parameters.length === 0 ? 'Add a parameter' : 'Edit parameters')}
      </div>
    ),
  };

  const varsTab: DockedInspectorTab = {
    id: 'pipeline-variables',
    label: `Variables (${variables.length})`,
    content: (
      <div className={s.pane} data-pipeline-level="variables">
        <Caption1 className={s.hint}>
          Variables hold values you set and modify DURING a run (Set variable / Append variable),
          referenced with <code>@variables(&apos;&lt;name&gt;&apos;)</code>.
        </Caption1>
        {variables.length === 0 ? (
          <Body1 className={s.hint}>
            No variables defined yet — add one to carry state between activities in a run.
          </Body1>
        ) : (
          <div className={s.table} role="table" aria-label="Pipeline variables">
            <div className={s.headRow} role="row">
              <span role="columnheader">Name</span>
              <span role="columnheader">Type</span>
              <span role="columnheader">Default value</span>
            </div>
            {variables.map((v) => (
              <div className={s.row} role="row" key={v.name} data-variable={v.name}>
                <span className={s.cell} role="cell">{v.name}</span>
                <span className={s.cellMuted} role="cell">{v.type}</span>
                <span className={s.cellMuted} role="cell">{formatDefault(v.defaultValue)}</span>
              </div>
            ))}
          </div>
        )}
        {openButton('variables', variables.length === 0 ? 'Add a variable' : 'Edit variables')}
      </div>
    ),
  };

  const activitiesTab: DockedInspectorTab = {
    id: 'pipeline-activities',
    label: `Activities (${levelActivities.length})`,
    content: (
      <div className={s.pane} data-pipeline-level="activities">
        <Caption1 className={s.hint}>
          Every activity at this canvas level. Select one to edit it here, or select its node
          on the canvas — both open the same configuration tabs.
        </Caption1>
        {levelActivities.length === 0 ? (
          <Body1 className={s.hint}>
            Nothing on this canvas yet — drag an activity from the Activities palette, or use
            a start card on the canvas.
          </Body1>
        ) : (
          <div className={s.table}>
            {levelActivities.map((a) => {
              const issues = activityIssueCount(a);
              const visual = getActivityVisual(a.type);
              return (
                <button
                  type="button"
                  className={s.activityRow}
                  key={a.name}
                  data-activity-row={a.name}
                  onClick={() => onSelectActivity?.(a.name)}
                  disabled={!onSelectActivity}
                >
                  <span className={s.activityDot} style={{ backgroundColor: visual.accent }} aria-hidden="true" />
                  <span className={s.activityName}>{activityDisplayLabel(a)}</span>
                  <span className={s.badgeRow}>
                    <Badge appearance="tint" size="small">{a.type || 'Unknown'}</Badge>
                    {issues > 0 && (
                      <Badge appearance="filled" color="danger" size="small">
                        {issues} to fix
                      </Badge>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    ),
  };

  // Real, derived pipeline-level facts — no placeholder numbers.
  const deepIssues = countIssuesDeep(levelActivities);
  const distinctTypes = new Set(levelActivities.map((a) => a.type || 'Unknown')).size;
  const settingsTab: DockedInspectorTab = {
    id: 'pipeline-settings',
    label: 'Settings',
    hasValidationIssue: deepIssues > 0,
    issueCount: deepIssues,
    content: (
      <div className={s.pane} data-pipeline-level="settings">
        <Caption1 className={s.hint}>
          Pipeline-level state for what is on the canvas right now. Concurrency, logging,
          annotations, the raw definition, and previous run output are edited on the
          pipeline-configurations tabs above the canvas.
        </Caption1>
        <div className={s.factGrid}>
          <div className={s.fact}>
            <span className={s.factValue}>{levelActivities.length}</span>
            <Caption1 className={s.factLabel}>Activities at this level</Caption1>
          </div>
          <div className={s.fact}>
            <span className={s.factValue}>{distinctTypes}</span>
            <Caption1 className={s.factLabel}>Distinct activity types</Caption1>
          </div>
          <div className={s.fact}>
            <span className={s.factValue}>{parameters.length + variables.length}</span>
            <Caption1 className={s.factLabel}>Parameters + variables</Caption1>
          </div>
          <div className={s.fact}>
            <span className={s.factValue}>{deepIssues}</span>
            <Caption1 className={s.factLabel}>Required fields still to set</Caption1>
          </div>
        </div>
        {onOpenPipelineTab && (
          <div className={s.actions}>
            <Button size="small" appearance="primary" icon={<Settings20Regular />}
              onClick={() => onOpenPipelineTab('settings')}>
              Pipeline settings
            </Button>
            <Button size="small" appearance="secondary" icon={<TableSimple20Regular />}
              onClick={() => onOpenPipelineTab('runs')}>
              Output
            </Button>
            <Button size="small" appearance="subtle" icon={<Add16Regular />}
              onClick={() => onOpenPipelineTab('parameters')}>
              Parameters
            </Button>
          </div>
        )}
      </div>
    ),
  };

  return [paramsTab, varsTab, activitiesTab, settingsTab];
}
