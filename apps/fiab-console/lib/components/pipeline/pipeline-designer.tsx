'use client';

/**
 * PipelineDesigner — the Azure-Data-Factory / Synapse-Studio pipeline builder,
 * rebuilt one-for-one (only the Loom Fluent-v9 theme differs):
 *
 *   ┌──────────┬─────────────────────────────────────────┐
 *   │ Activities│  Pipeline canvas (drag-drop, 4-colour    │
 *   │  palette  │  dependency edges, zoom/fit/auto-align)  │
 *   │ (search + ├─────────────────────────────────────────┤
 *   │  3 groups)│  Bottom properties dock (selected         │
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
 * Backend-agnostic: operates on PipelineActivity[] + emits onChange. The host
 * editor serialises into its definition JSON and PUTs to the real backend on
 * Save (per .claude/rules/no-vaporware.md).
 */

import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Button, Caption1, Tooltip, makeStyles, tokens } from '@fluentui/react-components';
import { PanelLeftContract20Regular, PanelLeftExpand20Regular } from '@fluentui/react-icons';
import { ActivityPalette } from './palette';
import { PipelineCanvas, type CanvasHandle } from './canvas';
import { PropertiesPanel } from './properties-panel';
import type { ConnectorCondition } from './connector';
import { ACTIVITY_CATALOG, findByKey, nextNameSuffix, type ActivityTypeDef } from './activity-catalog';
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
  /** The activities to render on the canvas (single source of truth). */
  activities: PipelineActivity[];
  /** Emit the full next activities[] whenever the graph mutates. */
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

  useImperativeHandle(ref, () => ({
    fitToScreen: () => canvasRef.current?.fitToScreen(),
    resetZoom: () => canvasRef.current?.resetZoom(),
    autoAlign: () => canvasRef.current?.autoAlign(),
  }), []);

  const selected = useMemo(
    () => activities.find((a) => a.name === selectedName) || null,
    [activities, selectedName],
  );

  const insertActivity = useCallback((def: ActivityTypeDef) => {
    if (readOnly) return;
    const n = nextNameSuffix(activities, def.namePrefix);
    const newName = `${def.namePrefix}${n}`;
    const a = def.build(newName);
    onActivitiesChange([...activities, a]);
    setTimeout(() => setSelectedName(newName), 0);
  }, [activities, onActivitiesChange, readOnly, setSelectedName]);

  const patchActivity = useCallback((name: string, patch: Partial<PipelineActivity>) => {
    if (readOnly) return;
    const next = activities.map((a) => (a.name === name ? { ...a, ...patch } : a));
    onActivitiesChange(next);
    if (patch.name && patch.name !== name) setSelectedName(patch.name as string);
  }, [activities, onActivitiesChange, readOnly, setSelectedName]);

  const deleteActivity = useCallback((name: string) => {
    if (readOnly) return;
    const next = activities
      .filter((a) => a.name !== name)
      .map((a) => ({ ...a, dependsOn: (a.dependsOn || []).filter((d) => d.activity !== name) }));
    onActivitiesChange(next);
    setSelectedName(null);
  }, [activities, onActivitiesChange, readOnly, setSelectedName]);

  // Wire a dependency from `from` → `to` carrying the source port's condition.
  // Idempotent + cycle-safe: refuse a connection that would make `to` depend
  // on itself transitively.
  const connect = useCallback((from: string, to: string, cond: ConnectorCondition) => {
    if (readOnly || from === to) return;
    const ancestors = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const cur = stack.pop()!;
      const node = activities.find((a) => a.name === cur);
      for (const d of node?.dependsOn || []) {
        if (!ancestors.has(d.activity)) { ancestors.add(d.activity); stack.push(d.activity); }
      }
    }
    if (ancestors.has(to)) return; // would create a cycle

    const next = activities.map((a) => {
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
    onActivitiesChange(next);
  }, [activities, onActivitiesChange, readOnly]);

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
          <ActivityPalette onInsert={insertActivity} />
        </div>
      )}
      <div className={s.centerCol}>
        <div className={s.canvasWrap}>
          <PipelineCanvas
            ref={canvasRef}
            activities={activities}
            selectedName={selectedName || undefined}
            onSelect={setSelectedName}
            snapToGrid={snapToGrid}
            showGrid={showGrid}
            onDropPaletteKey={(key) => {
              const def = findByKey(key);
              if (def) insertActivity(def);
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
            allActivities={activities}
            parameters={parameters}
            variables={variables}
            onPatch={(patch) => { if (selected) patchActivity(selected.name, patch); }}
            onDelete={() => { if (selected) deleteActivity(selected.name); }}
          />
        </div>
        <Caption1 className={s.status}>
          {activities.length} activit{activities.length === 1 ? 'y' : 'ies'} · {ACTIVITY_CATALOG.length} types in palette
        </Caption1>
      </div>
    </div>
  );
});
