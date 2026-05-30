'use client';

/**
 * PipelineDesigner — the Azure-Data-Factory / Synapse-Studio pipeline builder,
 * rebuilt one-for-one (only the Loom Fluent-v9 theme differs):
 *
 *   ┌──────────┬─────────────────────────────────────────┐
 *   │ Activities│  Breadcrumb (Pipeline > ForEach1 > True) │
 *   │  palette  ├─────────────────────────────────────────┤
 *   │ (search + │  Pipeline canvas (drag-drop, 4-colour    │
 *   │  3 groups)│  dependency edges, zoom/fit/auto-align)  │
 *   │           ├─────────────────────────────────────────┤
 *   │           │  Bottom properties dock (selected         │
 *   │           │  activity — General / activity tabs)      │
 *   └──────────┴─────────────────────────────────────────┘
 *
 * Matches ADF Studio's real layout (Learn: author-visually#authoring-canvas):
 * "Subresources such as pipeline activities … are edited using the panel at
 * the bottom of the canvas." The palette is the left "Activities" pane; the
 * canvas is where activities appear; the bottom dock edits the selected
 * activity. Pipeline-level Parameters / Variables / Settings live in the
 * hosting editor's tab row (PipelineEditorCore), per ADF's pipeline
 * configurations pane.
 *
 * Nested control flow (Learn: concepts-nested-activities): ForEach / Until /
 * IfCondition / Switch container activities hold their inner activities under
 * typeProperties. The designer keeps a `drillPath` — the trail of containers
 * (and branch, for If/Switch) the user has drilled into. The palette / canvas
 * / properties all operate on the CURRENT level via getLevelActivities +
 * setLevelActivities, which write the mutated array back into the full
 * top-level tree before calling onActivitiesChange. A breadcrumb above the
 * canvas reflects the path; clicking a crumb pops back to that level.
 *
 * Backend-agnostic: operates on the top-level PipelineActivity[] + emits
 * onActivitiesChange with the FULL tree. The host editor serialises into its
 * definition JSON and PUTs to the real backend on Save (per
 * .claude/rules/no-vaporware.md).
 */

import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbButton, BreadcrumbDivider,
  Button, Caption1, Input, MessageBar, MessageBarBody, Tab, TabList, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add16Regular, Dismiss16Regular, Home16Regular,
  PanelLeftContract20Regular, PanelLeftExpand20Regular,
} from '@fluentui/react-icons';
import { ActivityPalette } from './palette';
import { PipelineCanvas, type CanvasHandle } from './canvas';
import { PropertiesPanel } from './properties-panel';
import type { ConnectorCondition } from './connector';
import { ACTIVITY_CATALOG, findByKey, nextNameSuffix, type ActivityTypeDef } from './activity-catalog';
import {
  branchLabel, branchesOf, canAddTypeAtLevel, containerAt, getLevelActivities,
  setLevelActivities, type DrillBranch, type DrillPath,
} from './drill-path';
import type {
  PipelineActivity, PipelineParameter, PipelineVariable,
} from './types';

const useStyles = makeStyles({
  shell: {
    display: 'flex',
    flex: 1,
    minHeight: '560px',
    gap: tokens.spacingHorizontalM,
    width: '100%',
  },
  paletteCol: {
    flexShrink: 0,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  paletteHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '4px 6px 4px 10px', borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    fontWeight: 600, fontSize: 12,
  },
  paletteRail: {
    flexShrink: 0, width: 36, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
    paddingTop: 4,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  railLabel: {
    writingMode: 'vertical-rl', transform: 'rotate(180deg)',
    color: tokens.colorNeutralForeground3, fontSize: 12, userSelect: 'none', marginTop: 4,
  },
  // The canvas + bottom dock stack — this is the ADF "authoring canvas + the
  // panel at the bottom of the canvas" arrangement.
  centerCol: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minWidth: 0,
  },
  // Breadcrumb + (for If/Switch) branch selector — the drill navigation strip.
  navStrip: {
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  branchRow: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', flexWrap: 'wrap' },
  canvasWrap: { display: 'flex', flex: 1, minHeight: 0 },
  dock: { flexShrink: 0 },
  status: {
    color: tokens.colorNeutralForeground3,
    paddingLeft: tokens.spacingHorizontalXS,
  },
});

export interface PipelineDesignerHandle {
  fitToScreen: () => void;
  resetZoom: () => void;
  autoAlign: () => void;
}

export interface PipelineDesignerProps {
  /** The TOP-LEVEL activities to render (single source of truth). */
  activities: PipelineActivity[];
  /** Emit the full next top-level activities[] whenever the graph mutates. */
  onActivitiesChange: (next: PipelineActivity[]) => void;
  /** Pipeline-scoped parameters (referenceable in the properties pane). */
  parameters?: PipelineParameter[];
  /** Pipeline-scoped variables. */
  variables?: PipelineVariable[];
  /** Disable mutation (e.g. while a save is in flight). */
  readOnly?: boolean;
  /** Externally select an activity (e.g. after the host adds one). */
  selectedName?: string | null;
  onSelectedNameChange?: (name: string | null) => void;
}

export const PipelineDesigner = forwardRef<PipelineDesignerHandle, PipelineDesignerProps>(function PipelineDesigner({
  activities,
  onActivitiesChange,
  parameters = [],
  variables = [],
  readOnly = false,
  selectedName: controlledSelected,
  onSelectedNameChange,
}, ref) {
  const s = useStyles();
  const canvasRef = useRef<CanvasHandle>(null);
  const [internalSelected, setInternalSelected] = useState<string | null>(null);
  const selectedName = controlledSelected !== undefined ? controlledSelected : internalSelected;
  const setSelectedName = useCallback((name: string | null) => {
    if (onSelectedNameChange) onSelectedNameChange(name);
    if (controlledSelected === undefined) setInternalSelected(name);
  }, [onSelectedNameChange, controlledSelected]);
  const [snapToGrid] = useState(true);
  const [showGrid] = useState(true);
  const [paletteCollapsed, setPaletteCollapsed] = useState(false);

  // --- Drill navigation -----------------------------------------------------
  // The trail of (container, branch) steps the user has drilled into. Empty =
  // top-level pipeline. Each step's `branch` is undefined for ForEach/Until,
  // and 'ifTrue'|'ifFalse'|'default'|{caseValue} for If/Switch.
  const [drillPath, setDrillPath] = useState<DrillPath>([]);
  const [newCaseValue, setNewCaseValue] = useState('');

  useImperativeHandle(ref, () => ({
    fitToScreen: () => canvasRef.current?.fitToScreen(),
    resetZoom: () => canvasRef.current?.resetZoom(),
    autoAlign: () => canvasRef.current?.autoAlign(),
  }), []);

  // The activities array at the CURRENT drill level. A stale path (e.g. after a
  // container was deleted at a parent level) collapses to [].
  const levelActivities = useMemo(
    () => getLevelActivities(activities, drillPath),
    [activities, drillPath],
  );

  // The container we're currently inside (null at top level).
  const currentContainer = useMemo(
    () => containerAt(activities, drillPath),
    [activities, drillPath],
  );

  // Write a mutated current-level array back into the full top-level tree.
  const commitLevel = useCallback((nextLevel: PipelineActivity[]) => {
    if (readOnly) return;
    onActivitiesChange(setLevelActivities(activities, drillPath, nextLevel));
  }, [activities, drillPath, onActivitiesChange, readOnly]);

  const selected = useMemo(
    () => levelActivities.find((a) => a.name === selectedName) || null,
    [levelActivities, selectedName],
  );

  // Nesting-limit gate for a candidate activity type at the current level.
  const addRuleFor = useCallback(
    (type?: string) => canAddTypeAtLevel(activities, drillPath, type),
    [activities, drillPath],
  );

  const insertActivity = useCallback((def: ActivityTypeDef) => {
    if (readOnly) return;
    const rule = addRuleFor(def.type);
    if (!rule.allowed) return; // palette already blocks/tooltips; guard anyway
    const n = nextNameSuffix(levelActivities, def.namePrefix);
    const newName = `${def.namePrefix}${n}`;
    const a = def.build(newName);
    commitLevel([...levelActivities, a]);
    setTimeout(() => setSelectedName(newName), 0);
  }, [levelActivities, commitLevel, readOnly, setSelectedName, addRuleFor]);

  const patchActivity = useCallback((name: string, patch: Partial<PipelineActivity>) => {
    if (readOnly) return;
    const next = levelActivities.map((a) => (a.name === name ? { ...a, ...patch } : a));
    commitLevel(next);
    if (patch.name && patch.name !== name) setSelectedName(patch.name as string);
  }, [levelActivities, commitLevel, readOnly, setSelectedName]);

  const deleteActivity = useCallback((name: string) => {
    if (readOnly) return;
    const next = levelActivities
      .filter((a) => a.name !== name)
      .map((a) => ({ ...a, dependsOn: (a.dependsOn || []).filter((d) => d.activity !== name) }));
    commitLevel(next);
    setSelectedName(null);
  }, [levelActivities, commitLevel, readOnly, setSelectedName]);

  // Wire a dependency from `from` → `to` carrying the source port's condition.
  // Idempotent + cycle-safe within the CURRENT level: refuse a connection that
  // would make `to` depend on itself transitively.
  const connect = useCallback((from: string, to: string, cond: ConnectorCondition) => {
    if (readOnly || from === to) return;
    const ancestors = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const cur = stack.pop()!;
      const node = levelActivities.find((a) => a.name === cur);
      for (const d of node?.dependsOn || []) {
        if (!ancestors.has(d.activity)) { ancestors.add(d.activity); stack.push(d.activity); }
      }
    }
    if (ancestors.has(to)) return; // would create a cycle

    const next = levelActivities.map((a) => {
      if (a.name !== to) return a;
      const deps = a.dependsOn || [];
      const existing = deps.find((d) => d.activity === from);
      if (existing) {
        // Merge the condition into the existing edge (ADF allows multiple
        // conditions on one dependency, e.g. Completed alone, or Succeeded).
        const conds = new Set(existing.dependencyConditions || []);
        conds.add(cond);
        return {
          ...a,
          dependsOn: deps.map((d) => d.activity === from
            ? { ...d, dependencyConditions: [...conds] } : d),
        };
      }
      return {
        ...a,
        dependsOn: [...deps, { activity: from, dependencyConditions: [cond] }],
      };
    });
    commitLevel(next);
  }, [levelActivities, commitLevel, readOnly]);

  // --- Drill in / out -------------------------------------------------------
  // Push a drill step for `name` (a container in the current level). For
  // ForEach/Until there's one branch (undefined). For If/Switch we default to
  // the first branch (True / Default) — the branch selector then switches it.
  const drillInto = useCallback((name: string) => {
    const container = levelActivities.find((a) => a.name === name);
    if (!container) return;
    const branches = branchesOf(container);
    const firstBranch = branches[0]?.branch;
    setDrillPath((p) => [...p, { name, branch: firstBranch }]);
    setSelectedName(null);
    setTimeout(() => canvasRef.current?.fitToScreen(), 60);
  }, [levelActivities, setSelectedName]);

  // Jump the breadcrumb to a given depth (0 = top-level pipeline).
  const popTo = useCallback((depth: number) => {
    setDrillPath((p) => p.slice(0, depth));
    setSelectedName(null);
    setTimeout(() => canvasRef.current?.fitToScreen(), 60);
  }, [setSelectedName]);

  // Switch which branch of the CURRENT container we're editing (If/Switch).
  const setCurrentBranch = useCallback((branch: DrillBranch | undefined) => {
    setDrillPath((p) => {
      if (p.length === 0) return p;
      const next = [...p];
      next[next.length - 1] = { ...next[next.length - 1], branch };
      return next;
    });
    setSelectedName(null);
    setTimeout(() => canvasRef.current?.fitToScreen(), 60);
  }, [setSelectedName]);

  // Add / remove a Switch case on the current container (real JSON mutation,
  // committed up the tree like any other edit).
  const addSwitchCase = useCallback((value: string) => {
    if (readOnly || !currentContainer || currentContainer.type !== 'Switch') return;
    const v = value.trim();
    if (!v) return;
    const tp = { ...(currentContainer.typeProperties || {}) } as Record<string, unknown>;
    const cases = Array.isArray(tp.cases) ? [...(tp.cases as Array<{ value: string; activities?: PipelineActivity[] }>)] : [];
    if (cases.some((c) => c.value === v)) return; // no duplicate case values
    cases.push({ value: v, activities: [] });
    tp.cases = cases;
    // Commit the container edit at the PARENT level.
    const parentPath = drillPath.slice(0, -1);
    const parentLevel = getLevelActivities(activities, parentPath);
    const updatedParent = parentLevel.map((a) =>
      a.name === currentContainer.name ? { ...a, typeProperties: tp } : a);
    onActivitiesChange(setLevelActivities(activities, parentPath, updatedParent));
    setNewCaseValue('');
    setCurrentBranch({ caseValue: v });
  }, [readOnly, currentContainer, drillPath, activities, onActivitiesChange, setCurrentBranch]);

  const removeSwitchCase = useCallback((value: string) => {
    if (readOnly || !currentContainer || currentContainer.type !== 'Switch') return;
    const tp = { ...(currentContainer.typeProperties || {}) } as Record<string, unknown>;
    const cases = Array.isArray(tp.cases) ? (tp.cases as Array<{ value: string }>) : [];
    tp.cases = cases.filter((c) => c.value !== value);
    const parentPath = drillPath.slice(0, -1);
    const parentLevel = getLevelActivities(activities, parentPath);
    const updatedParent = parentLevel.map((a) =>
      a.name === currentContainer.name ? { ...a, typeProperties: tp } : a);
    onActivitiesChange(setLevelActivities(activities, parentPath, updatedParent));
    // If we were editing the removed case, fall back to Default.
    const cur = drillPath[drillPath.length - 1]?.branch;
    if (cur && typeof cur === 'object' && cur.caseValue === value) setCurrentBranch('default');
  }, [readOnly, currentContainer, drillPath, activities, onActivitiesChange, setCurrentBranch]);

  // --- Breadcrumb labels ----------------------------------------------------
  // Each crumb shows the container name plus, for If/Switch, the active branch
  // in parentheses (e.g. "If1 (True)" / "Switch1 (Case 'a')").
  const crumbs = useMemo(() => drillPath.map((step) => {
    const bl = branchLabel(step.branch);
    return { name: step.name, label: bl ? `${step.name} (${bl})` : step.name };
  }), [drillPath]);

  const currentBranch = drillPath[drillPath.length - 1]?.branch;
  const branchDefs = currentContainer ? branchesOf(currentContainer) : [];
  const showBranchSelector = !!currentContainer
    && (currentContainer.type === 'IfCondition' || currentContainer.type === 'Switch');

  return (
    <div className={s.shell} data-pipeline-designer>
      {paletteCollapsed ? (
        <div className={s.paletteRail}>
          <Tooltip content="Expand activities" relationship="label">
            <Button appearance="subtle" size="small" icon={<PanelLeftExpand20Regular />}
              aria-label="Expand activities" onClick={() => setPaletteCollapsed(false)} />
          </Tooltip>
          <span className={s.railLabel}>Activities</span>
        </div>
      ) : (
        <div className={s.paletteCol}>
          <div className={s.paletteHeader}>
            <span>Activities</span>
            <Tooltip content="Collapse activities" relationship="label">
              <Button appearance="subtle" size="small" icon={<PanelLeftContract20Regular />}
                aria-label="Collapse activities" onClick={() => setPaletteCollapsed(true)} />
            </Tooltip>
          </div>
          <ActivityPalette onInsert={insertActivity} addRuleFor={addRuleFor} />
        </div>
      )}
      <div className={s.centerCol}>
        {/* Drill navigation strip — breadcrumb + (If/Switch) branch selector. */}
        <div className={s.navStrip} data-drill-strip>
          <Breadcrumb size="small" aria-label="Pipeline drill breadcrumb">
            <BreadcrumbItem>
              <BreadcrumbButton
                icon={<Home16Regular />}
                current={drillPath.length === 0}
                onClick={() => popTo(0)}
                data-crumb-depth="0"
              >
                Pipeline
              </BreadcrumbButton>
            </BreadcrumbItem>
            {crumbs.map((c, i) => (
              <span key={`${c.name}-${i}`} style={{ display: 'contents' }}>
                <BreadcrumbDivider />
                <BreadcrumbItem>
                  <BreadcrumbButton
                    current={i === crumbs.length - 1}
                    onClick={() => popTo(i + 1)}
                    data-crumb-depth={i + 1}
                  >
                    {c.label}
                  </BreadcrumbButton>
                </BreadcrumbItem>
              </span>
            ))}
          </Breadcrumb>

          {showBranchSelector && (
            <div className={s.branchRow} data-branch-selector>
              <Caption1>{currentContainer!.type === 'IfCondition' ? 'Branch:' : 'Case:'}</Caption1>
              <TabList
                size="small"
                selectedValue={JSON.stringify(currentBranch ?? null)}
                onTabSelect={(_, d) => {
                  const parsed = JSON.parse(d.value as string) as DrillBranch | null;
                  setCurrentBranch(parsed ?? undefined);
                }}
              >
                {branchDefs.map((b) => (
                  <Tab key={JSON.stringify(b.branch ?? null)} value={JSON.stringify(b.branch ?? null)}>
                    {b.label} ({b.count})
                  </Tab>
                ))}
              </TabList>
              {currentContainer!.type === 'Switch' && (
                <>
                  {/* Remove the currently-selected case (not Default). */}
                  {currentBranch && typeof currentBranch === 'object' && 'caseValue' in currentBranch && (
                    <Tooltip content={`Remove case '${currentBranch.caseValue}'`} relationship="label">
                      <Button
                        size="small" appearance="subtle" icon={<Dismiss16Regular />}
                        aria-label={`Remove case ${currentBranch.caseValue}`}
                        onClick={() => removeSwitchCase((currentBranch as { caseValue: string }).caseValue)}
                        disabled={readOnly}
                      />
                    </Tooltip>
                  )}
                  <Input
                    size="small"
                    placeholder="New case value"
                    value={newCaseValue}
                    onChange={(_, d) => setNewCaseValue(d.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addSwitchCase(newCaseValue); }}
                    style={{ width: 140 }}
                    aria-label="New Switch case value"
                  />
                  <Button
                    size="small" appearance="primary" icon={<Add16Regular />}
                    onClick={() => addSwitchCase(newCaseValue)}
                    disabled={readOnly || !newCaseValue.trim()}
                  >
                    Add case
                  </Button>
                </>
              )}
            </div>
          )}

          {currentContainer && (
            <MessageBar intent="info" politeness="polite" data-drill-context>
              <MessageBarBody>
                Editing inner activities of <strong>{currentContainer.name}</strong>
                {branchLabel(currentBranch) ? ` — ${branchLabel(currentBranch)} branch` : ''}.
                These run inside the {ACTIVITY_CATALOG.find((d) => d.type === currentContainer.type)?.label || currentContainer.type}.
              </MessageBarBody>
            </MessageBar>
          )}
        </div>

        <div className={s.canvasWrap}>
          <PipelineCanvas
            ref={canvasRef}
            activities={levelActivities}
            selectedName={selectedName || undefined}
            onSelect={setSelectedName}
            snapToGrid={snapToGrid}
            showGrid={showGrid}
            onDrillInto={drillInto}
            onDropPaletteKey={(key) => {
              const def = findByKey(key);
              if (!def) return;
              if (!addRuleFor(def.type).allowed) return; // nesting-limit gate
              insertActivity(def);
            }}
            onConnect={connect}
          />
        </div>
        {/* Bottom properties dock — ADF Studio edits the selected sub-resource
            (activity) in a panel at the bottom of the canvas. */}
        <div className={s.dock}>
          <PropertiesPanel
            layout="dock"
            activity={selected}
            allActivities={levelActivities}
            parameters={parameters}
            variables={variables}
            onPatch={(patch) => { if (selected) patchActivity(selected.name, patch); }}
            onDelete={() => { if (selected) deleteActivity(selected.name); }}
          />
        </div>
        <Caption1 className={s.status}>
          {drillPath.length === 0 ? 'Pipeline' : `${currentContainer?.name || ''}${branchLabel(currentBranch) ? ` · ${branchLabel(currentBranch)}` : ''}`}
          {' · '}
          {levelActivities.length} activit{levelActivities.length === 1 ? 'y' : 'ies'} at this level · {ACTIVITY_CATALOG.length} types in palette
        </Caption1>
      </div>
    </div>
  );
});
