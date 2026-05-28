'use client';

/**
 * PipelineDesigner — the reusable Azure-Data-Factory-style three-pane visual
 * builder: activity palette (left) · drag-drop canvas (center) · properties
 * (right). It is intentionally backend-agnostic: it operates purely on a
 * PipelineActivity[] and emits onChange. Each editor (Fabric data-pipeline,
 * Synapse pipeline, ADF pipeline, Dataflow Gen2) hosts this surface and is
 * responsible for serializing the activities into its own definition JSON and
 * POST/PUT-ing to the real backend on Save.
 *
 * Per .claude/rules/no-vaporware.md this component is fully functional with NO
 * backend dependency — you can drag activities onto the canvas, move them,
 * connect them with success arrows, and edit their properties even before any
 * Azure service is reachable. The hosting editor's Save button is what hits a
 * real backend (or shows an honest MessageBar when it can't).
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { Caption1, makeStyles, tokens } from '@fluentui/react-components';
import { ActivityPalette } from './palette';
import { PipelineCanvas, type CanvasHandle } from './canvas';
import { PropertiesPanel } from './properties-panel';
import { ACTIVITY_CATALOG, findByKey, nextNameSuffix, type ActivityTypeDef } from './activity-catalog';
import type {
  PipelineActivity, PipelineParameter, PipelineVariable,
} from './types';

const useStyles = makeStyles({
  threePane: {
    display: 'flex',
    flex: 1,
    minHeight: '480px',
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
  },
  centerCol: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minWidth: 0,
  },
});

export interface PipelineDesignerProps {
  /** The activities to render on the canvas (single source of truth). */
  activities: PipelineActivity[];
  /** Emit the full next activities[] whenever the graph mutates. */
  onActivitiesChange: (next: PipelineActivity[]) => void;
  /** Pipeline-scoped parameters (read-only reference in the properties pane). */
  parameters?: PipelineParameter[];
  /** Pipeline-scoped variables. */
  variables?: PipelineVariable[];
  /** Disable mutation (e.g. while a save is in flight). */
  readOnly?: boolean;
}

/**
 * The shared visual designer. Selection + canvas layout are local state;
 * the activity list itself is fully controlled by the parent.
 */
export function PipelineDesigner({
  activities,
  onActivitiesChange,
  parameters = [],
  variables = [],
  readOnly = false,
}: PipelineDesignerProps) {
  const s = useStyles();
  const canvasRef = useRef<CanvasHandle>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [snapToGrid] = useState(true);
  const [showGrid] = useState(true);

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
  }, [activities, onActivitiesChange, readOnly]);

  const patchActivity = useCallback((name: string, patch: Partial<PipelineActivity>) => {
    if (readOnly) return;
    const next = activities.map((a) => (a.name === name ? { ...a, ...patch } : a));
    onActivitiesChange(next);
    if (patch.name && patch.name !== name) setSelectedName(patch.name as string);
  }, [activities, onActivitiesChange, readOnly]);

  const deleteActivity = useCallback((name: string) => {
    if (readOnly) return;
    const next = activities
      .filter((a) => a.name !== name)
      .map((a) => ({ ...a, dependsOn: (a.dependsOn || []).filter((d) => d.activity !== name) }));
    onActivitiesChange(next);
    setSelectedName(null);
  }, [activities, onActivitiesChange, readOnly]);

  // Wire a success dependency from `from` → `to`. Idempotent and cycle-safe:
  // we refuse a connection that would make `to` depend on itself transitively.
  const connect = useCallback((from: string, to: string) => {
    if (readOnly || from === to) return;
    // Cycle guard — walk the existing dependency graph from `from` upward; if
    // `to` is already an ancestor of `from`, adding from→to would loop.
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
      if (deps.some((d) => d.activity === from)) return a; // already wired
      return {
        ...a,
        dependsOn: [...deps, { activity: from, dependencyConditions: ['Succeeded'] }],
      };
    });
    onActivitiesChange(next);
  }, [activities, onActivitiesChange, readOnly]);

  return (
    <div className={s.threePane}>
      <div className={s.paletteCol}>
        <ActivityPalette onInsert={insertActivity} />
      </div>
      <div className={s.centerCol}>
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
        <Caption1 style={{ color: tokens.colorNeutralForeground3, paddingLeft: tokens.spacingHorizontalXS }}>
          {activities.length} activit{activities.length === 1 ? 'y' : 'ies'} · {ACTIVITY_CATALOG.length} types in palette
        </Caption1>
      </div>
      <PropertiesPanel
        activity={selected}
        allActivities={activities}
        parameters={parameters}
        variables={variables}
        onPatch={(patch) => { if (selected) patchActivity(selected.name, patch); }}
        onDelete={() => { if (selected) deleteActivity(selected.name); }}
      />
    </div>
  );
}
