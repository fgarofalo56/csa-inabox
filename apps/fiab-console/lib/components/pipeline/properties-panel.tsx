'use client';

/**
 * PropertiesPanel — right rail tabbed editor for the selected activity.
 *
 * Tabs (Fabric parity):
 *   - General        — name, description, dependsOn
 *   - Source / Sink  — when activity has source/sink typeProperties
 *   - Settings       — typeProperties JSON (fallback for not-yet-form-ified types)
 *   - Parameters     — show pipeline params, allow @pipeline().parameters.foo refs
 *   - User properties— optional userProperties[] entries
 *
 * Edits go through a single `onPatchActivity` callback so the editor's
 * undo/save lifecycle stays consistent.
 *
 * Web-5.0 chrome: the panel REUSES the shared canvas-node-kit so its header
 * carries the SAME per-type glyph + per-category accent the canvas node uses
 * for the selected activity (`getActivityVisual`) — accent-tinted icon chip,
 * gradient header, accent type-chip. Section headers carry a Fluent glyph +
 * `Subtitle2`/`Caption1` hint, panels get elevation + `borderRadiusLarge`, and
 * the no-selection pane uses the shared `EmptyState`. Every colour / space /
 * radius / shadow is a Fluent v9 `tokens.*` value or a `--loom-accent-*` var
 * combined via the kit's token-only `accentTint` / `accentGradient` helpers —
 * no raw px / hex / hardcoded shadow.
 */

import { useState, useEffect } from 'react';
import {
  Tab, TabList, Input, Field, Textarea, Caption1, Button, Subtitle2,
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, Badge, makeStyles, tokens, Select, Switch,
  Dropdown, Option, Accordion, AccordionItem, AccordionHeader, AccordionPanel,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, Cursor20Regular, Settings20Regular,
  BranchCompare20Regular, Timer20Regular,
  BracesVariable20Regular, TagMultiple20Regular,
} from '@fluentui/react-icons';
import { findForActivity, canvasCategoryForType } from './activity-catalog';
import { ActivityForm, hasActivityForm } from './activity-forms';
import { SourceTab } from './copy/source-tab';
import { SinkTab } from './copy/sink-tab';
import { MappingTab } from './copy/mapping-tab';
import { CopySettingsTab } from './copy/copy-settings-tab';
import { useCopyResources } from './copy/use-copy-resources';
import {
  getActivityVisual, CATEGORY_ICON, accentTint, accentGradient,
} from '@/lib/components/canvas/canvas-node-kit';
import { EmptyState } from '@/lib/components/empty-state';
import type { PipelineActivity, PipelineParameter, PipelineParameterType, PipelineVariable } from './types';

const useStyles = makeStyles({
  // Right-rail layout (legacy callers).
  root: {
    display: 'flex', flexDirection: 'column',
    width: '380px', minWidth: '320px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    overflow: 'hidden',
  },
  // Bottom-dock layout (ADF Studio parity) — full width, fixed height,
  // header + horizontal tab strip + scrollable body.
  dockRoot: {
    // Fills the resizable bottom dock (height is owned by the parent splitter
    // pane); the body scrolls internally so section expand/collapse never grows
    // the dock or resizes the canvas above it.
    display: 'flex', flexDirection: 'column',
    width: '100%', height: '100%', minHeight: 0,
    backgroundColor: tokens.colorNeutralBackground1,
    overflow: 'hidden',
  },
  // Accent-gradient header (category-tinted, matches the canvas node header).
  header: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  headerTop: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  iconChip: {
    flexShrink: 0,
    width: '32px', height: '32px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  headerTitleCol: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  headerMeta: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', flexWrap: 'wrap' },
  // Tab strip — subtle background lane so it reads as a distinct band.
  tabStrip: {
    paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  body: {
    paddingTop: tokens.spacingVerticalL, paddingBottom: tokens.spacingVerticalL,
    paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL,
    overflowY: 'auto', display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalM, flex: 1,
  },
  // Section header — Fluent glyph + Subtitle2 + Caption1 hint.
  sectionHead: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
  },
  sectionIcon: {
    flexShrink: 0,
    width: '26px', height: '26px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    color: tokens.colorBrandForeground1,
    backgroundColor: tokens.colorBrandBackground2,
  },
  sectionHint: { color: tokens.colorNeutralForeground3 },
  // Elevated card grouping a logical block of fields.
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  dependsRow: {
    display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS,
    marginTop: tokens.spacingVerticalXS,
  },
  dependsItem: { display: 'flex', gap: tokens.spacingHorizontalXS },
  rowSplit: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  upRow: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center' },
  deleteBtn: {
    marginTop: 'auto', alignSelf: 'flex-start',
    color: tokens.colorPaletteRedForeground1,
  },
  jsonArea: {
    width: '100%', minHeight: '160px',
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    padding: tokens.spacingHorizontalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
});

export interface PropertiesPanelProps {
  activity: PipelineActivity | null;
  /** All activities — used to populate the dependsOn drop-down. */
  allActivities: PipelineActivity[];
  /** Pipeline-scoped params (read-only here; surface them for reference). */
  parameters: PipelineParameter[];
  /** Pipeline-scoped variables. */
  variables: PipelineVariable[];
  /** Patch the currently-selected activity. */
  onPatch: (patch: Partial<PipelineActivity>) => void;
  /** Delete the currently-selected activity. */
  onDelete: () => void;
  /** 'rail' = right-side panel (legacy); 'dock' = bottom dock (ADF parity). */
  layout?: 'rail' | 'dock';
  /** Item id of the pipeline (enables live form helpers e.g. Approval URL fetch). */
  itemId?: string;
  /** Pipeline item id — enables Evaluate (F9) last-run sample pre-fill. */
  pipelineId?: string;
  /** Workspace id of the pipeline. */
  workspaceId?: string;
  /** Editor host API slug (default 'data-pipeline'). */
  apiSlug?: string;
  /**
   * The container activity this activity is nested inside (ForEach, IfCondition,
   * Switch, Until), or null/undefined at the top pipeline level. Used to warn
   * when a SetVariable / AppendVariable sits inside a parallel (non-sequential)
   * ForEach, where concurrent variable writes are not thread-safe.
   */
  parentActivity?: PipelineActivity | null;
  /**
   * Drill into a container activity's inner-activity sub-canvas. Threaded from
   * the designer so the Settings form's "Edit inner activities" affordance
   * navigates the existing canvas. Omit to render the affordance read-only.
   */
  onDrillInto?: (name: string) => void;
}

type TabId =
  | 'general'
  | 'source'         // Copy activity — Source tab
  | 'sink'           // Copy activity — Sink tab
  | 'mapping'        // Copy activity — Mapping tab
  | 'copy-settings'  // Copy activity — Settings tab
  | 'source-sink'    // non-Copy activities with source/sink (Lookup, GetMetadata, …)
  | 'settings'
  | 'parameters'
  | 'user-props';

export function PropertiesPanel({ activity, allActivities, parameters, variables, onPatch, onDelete, layout = 'rail', itemId, pipelineId, workspaceId, apiSlug, parentActivity = null, onDrillInto }: PropertiesPanelProps) {
  const s = useStyles();
  const rootClass = layout === 'dock' ? s.dockRoot : s.root;
  const [tab, setTab] = useState<TabId>('general');
  const [typePropsText, setTypePropsText] = useState('');
  const [typePropsErr, setTypePropsErr] = useState<string | null>(null);

  // Factory datasets + linked services — backs the Source/Sink dataset pickers,
  // the Copy Mapping schema import, and the Settings staging/redirect linked-
  // service pickers. One shared fetch (real ARM REST via the BFF routes); on an
  // unconfigured factory the routes 503 and `gateError` names the missing env
  // var so each tab shows an honest MessageBar instead of going blank.
  const { datasets, linkedServices, gateError, reload: reloadCopyResources } = useCopyResources();
  // Names-only list for the legacy (non-Copy) Source/Sink tab.
  const datasetNames = datasets.map((d) => d.name).filter(Boolean);

  useEffect(() => {
    if (!activity) return;
    // Land on the first ADF-parity tab for the activity (Source for Copy).
    setTab(activity.type === 'Copy' ? 'source' : 'general');
    try {
      setTypePropsText(JSON.stringify(activity.typeProperties || {}, null, 2));
      setTypePropsErr(null);
    } catch {
      setTypePropsText('{}');
    }
  }, [activity?.name, activity?.type]);

  if (!activity) {
    return (
      <div className={rootClass} data-properties-dock={layout === 'dock' ? '' : undefined}>
        <EmptyState
          icon={<Cursor20Regular />}
          title="No activity selected"
          body="Select an activity on the canvas to edit its properties — General, Source / Sink, Settings, Parameters, and User properties all appear here."
        />
      </div>
    );
  }

  const def = findForActivity(activity);
  const isCopyActivity = activity.type === 'Copy';
  const hasSourceSink = !!(activity.typeProperties && ('source' in activity.typeProperties || 'sink' in activity.typeProperties));

  // Reuse the SAME glyph + per-category accent the canvas node uses for this
  // activity type, so the panel chrome reads as the same object the user clicked.
  const visual = getActivityVisual(activity.type);
  const accent = visual.accent;
  const sectionGlyph = CATEGORY_ICON[canvasCategoryForType(activity.type)];

  return (
    <div className={rootClass} data-properties-dock={layout === 'dock' ? '' : undefined}>
      <div className={s.header} style={{ background: accentGradient(accent) }}>
        <div className={s.headerTop}>
          <span
            className={s.iconChip}
            style={{ background: accentTint(accent, 16), color: accent, border: `1px solid ${accentTint(accent, 28)}` }}
            aria-hidden="true"
          >
            {visual.icon}
          </span>
          <div className={s.headerTitleCol}>
            <Subtitle2>{activity.name}</Subtitle2>
            <div className={s.headerMeta}>
              <Badge
                appearance="tint"
                size="small"
                style={{ backgroundColor: accentTint(accent, 14), color: accent, borderColor: accentTint(accent, 28) }}
              >
                {def?.label || activity.type || 'Unknown'}
              </Badge>
              {def && !def.runnable && (
                <Badge appearance="outline" size="small" color="warning" title={def.remediation}>Save-only</Badge>
              )}
            </div>
          </div>
        </div>
        {def && !def.runnable && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Activity will not execute on this backing</MessageBarTitle>
              {def.remediation}
            </MessageBarBody>
          </MessageBar>
        )}
        {/* Thread-safety warning: SetVariable / AppendVariable inside a parallel
            (non-sequential) ForEach. ADF evaluates iterations concurrently when
            isSequential is false — concurrent writes to a pipeline-scoped
            variable are not atomic and the last write wins (non-deterministic). */}
        {(activity.type === 'SetVariable' || activity.type === 'AppendVariable')
          && parentActivity?.type === 'ForEach'
          && (parentActivity.typeProperties as Record<string, unknown> | undefined)?.isSequential === false && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Thread-safety risk — parallel ForEach</MessageBarTitle>
              {activity.type} inside the non-sequential ForEach{' '}
              <strong>{parentActivity.name}</strong> may produce non-deterministic
              results. ADF runs each ForEach iteration concurrently when{' '}
              <strong>isSequential</strong> is <code>false</code> — concurrent writes
              to the same pipeline-scoped variable are not atomic, so the last write
              wins. To fix: turn the parent ForEach&apos;s <strong>Sequential</strong>{' '}
              toggle on, or accumulate results in an external store (SQL table,
              Cosmos container) instead of a pipeline variable.
            </MessageBarBody>
          </MessageBar>
        )}
      </div>

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as TabId)} size="small"
        className={s.tabStrip}>
        <Tab value="general">General</Tab>
        {isCopyActivity && <Tab value="source">Source</Tab>}
        {isCopyActivity && <Tab value="sink">Sink</Tab>}
        {isCopyActivity && <Tab value="mapping">Mapping</Tab>}
        {isCopyActivity && <Tab value="copy-settings">Settings</Tab>}
        {!isCopyActivity && hasSourceSink && <Tab value="source-sink">Source / Sink</Tab>}
        <Tab value="settings">{isCopyActivity ? 'Activity policy' : 'Settings'}</Tab>
        <Tab value="parameters">Parameters</Tab>
        <Tab value="user-props">User properties</Tab>
      </TabList>

      <div className={s.body}>
        {tab === 'general' && (
          <>
            <div className={s.sectionHead}>
              <span className={s.sectionIcon} aria-hidden="true">{sectionGlyph}</span>
              <div>
                <Subtitle2>General</Subtitle2>
                <Caption1 as="p" className={s.sectionHint}>Name, description, and run-order dependencies.</Caption1>
              </div>
            </div>
            <div className={s.card}>
              <Field label="Name" required>
                <Input value={activity.name} onChange={(_, d) => onPatch({ name: d.value })} />
              </Field>
              <Field label="Description">
                <Textarea value={activity.description || ''} rows={2}
                  onChange={(_, d) => onPatch({ description: d.value })} />
              </Field>
              <Field label="Depends on">
                <Caption1>Click to toggle a dependency on another activity.</Caption1>
                <div className={s.dependsRow}>
                  {allActivities.filter((a) => a.name !== activity.name).map((a) => {
                    const dep = (activity.dependsOn || []).find((d) => d.activity === a.name);
                    const conds = dep?.dependencyConditions || [];
                    return (
                      <div key={a.name} className={s.dependsItem}>
                        <Button size="small"
                          appearance={dep ? 'primary' : 'outline'}
                          onClick={() => {
                            const ds = activity.dependsOn || [];
                            if (dep) onPatch({ dependsOn: ds.filter((d) => d.activity !== a.name) });
                            else onPatch({ dependsOn: [...ds, { activity: a.name, dependencyConditions: ['Succeeded'] }] });
                          }}>{a.name}</Button>
                        {dep && (
                          <Select size="small"
                            value={conds[0] || 'Succeeded'}
                            onChange={(_, d) => {
                              const ds = activity.dependsOn || [];
                              onPatch({
                                dependsOn: ds.map((x) => x.activity === a.name
                                  ? { ...x, dependencyConditions: [d.value] } : x),
                              });
                            }}>
                            <option value="Succeeded">Succeeded</option>
                            <option value="Failed">Failed</option>
                            <option value="Completed">Completed</option>
                            <option value="Skipped">Skipped</option>
                          </Select>
                        )}
                      </div>
                    );
                  })}
                  {allActivities.length <= 1 && <Caption1>No other activities to depend on yet.</Caption1>}
                </div>
              </Field>
            </div>
            <Button appearance="subtle" icon={<Delete20Regular />} onClick={onDelete}
              className={s.deleteBtn}>
              Delete activity
            </Button>
          </>
        )}

        {tab === 'source' && isCopyActivity && (
          <SourceTab activity={activity} datasets={datasets} linkedServices={linkedServices} gateError={gateError}
            parameters={parameters} variables={variables} allActivities={allActivities}
            onPatch={onPatch} onDatasetsChanged={() => { void reloadCopyResources(); }} />
        )}
        {tab === 'sink' && isCopyActivity && (
          <SinkTab activity={activity} datasets={datasets} linkedServices={linkedServices} gateError={gateError}
            parameters={parameters} variables={variables} allActivities={allActivities}
            onPatch={onPatch} onDatasetsChanged={() => { void reloadCopyResources(); }} />
        )}
        {tab === 'mapping' && isCopyActivity && (
          <MappingTab activity={activity} datasets={datasets}
            parameters={parameters} variables={variables} allActivities={allActivities}
            onPatch={onPatch} />
        )}
        {tab === 'copy-settings' && isCopyActivity && (
          <CopySettingsTab activity={activity} linkedServices={linkedServices}
            gateError={gateError} onPatch={onPatch} />
        )}

        {tab === 'source-sink' && hasSourceSink && (
          <>
            <div className={s.sectionHead}>
              <span className={s.sectionIcon} aria-hidden="true"><BranchCompare20Regular /></span>
              <div>
                <Subtitle2>Source / Sink</Subtitle2>
                <Caption1 as="p" className={s.sectionHint}>Bind factory datasets and tune copy behaviour for this activity.</Caption1>
              </div>
            </div>
            <div className={s.card}>
            {(() => {
              const inputName = ((activity.inputs as any[]) || [])[0]?.referenceName as string | undefined;
              const outputName = ((activity.outputs as any[]) || [])[0]?.referenceName as string | undefined;
              const refOrEmpty = (name: string) => name
                ? [{ referenceName: name, type: 'DatasetReference', parameters: {} }]
                : [];
              return (
                <>
                  <Caption1>
                    Bind a factory dataset to this activity. Selecting a source/sink dataset sets the
                    activity&apos;s <code>inputs</code>/<code>outputs</code> DatasetReference. Manage datasets
                    in the ribbon&apos;s <strong>Manage</strong> hub. {datasetNames.length === 0 && '(No datasets found — create one in Manage, or the factory isn’t configured.)'}
                  </Caption1>
                  <Field label="Source dataset (inputs[0])">
                    <Dropdown
                      placeholder={datasetNames.length ? 'Select a dataset' : 'No datasets available'}
                      value={inputName || ''}
                      selectedOptions={inputName ? [inputName] : []}
                      disabled={!datasetNames.length}
                      onOptionSelect={(_, d) => onPatch({ inputs: refOrEmpty(d.optionValue || '') })}
                    >
                      <Option value="" text="(none)">(none)</Option>
                      {datasetNames.map((n) => <Option key={n} value={n} text={n}>{n}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Sink dataset (outputs[0])">
                    <Dropdown
                      placeholder={datasetNames.length ? 'Select a dataset' : 'No datasets available'}
                      value={outputName || ''}
                      selectedOptions={outputName ? [outputName] : []}
                      disabled={!datasetNames.length}
                      onOptionSelect={(_, d) => onPatch({ outputs: refOrEmpty(d.optionValue || '') })}
                    >
                      <Option value="" text="(none)">(none)</Option>
                      {datasetNames.map((n) => <Option key={n} value={n} text={n}>{n}</Option>)}
                    </Dropdown>
                  </Field>
                </>
              );
            })()}
            {/* Guided Copy settings (ADF-Studio-style) — no JSON for the common
                90%. Raw source/sink connector JSON moves to Advanced below for
                power users / exotic connectors. */}
            {(() => {
              const tp = (activity.typeProperties || {}) as any;
              const src = tp.source || {};
              const sink = tp.sink || {};
              const patchSrc = (patch: any) => onPatch({ typeProperties: { ...tp, source: { ...src, ...patch } } });
              const patchSink = (patch: any) => onPatch({ typeProperties: { ...tp, sink: { ...sink, ...patch } } });
              return (
                <>
                  <Field label="Parallel copies" hint="Degree of copy parallelism (blank = auto).">
                    <Input type="number" value={tp.parallelCopies != null ? String(tp.parallelCopies) : ''}
                      onChange={(_, d) => onPatch({ typeProperties: { ...tp, parallelCopies: d.value ? Number(d.value) : undefined } })} />
                  </Field>
                  <Field label="Recursive (file source)" hint="Read sub-folders recursively.">
                    <Switch checked={!!src.recursive} onChange={(_, d) => patchSrc({ recursive: d.checked })} />
                  </Field>
                  <Field label="Sink write behavior">
                    <Dropdown value={sink.writeBehavior || ''} selectedOptions={sink.writeBehavior ? [sink.writeBehavior] : []}
                      onOptionSelect={(_, d) => patchSink({ writeBehavior: d.optionValue || undefined })}>
                      <Option value="" text="(default)">(default)</Option>
                      <Option value="insert" text="Insert">Insert</Option>
                      <Option value="upsert" text="Upsert">Upsert</Option>
                    </Dropdown>
                  </Field>
                </>
              );
            })()}
            <Accordion collapsible>
              <AccordionItem value="copy-advanced">
                <AccordionHeader>Advanced — source / sink connector JSON</AccordionHeader>
                <AccordionPanel>
                  <Caption1>Raw connector settings — target any source/sink type (e.g. wildcards, queries, staging).</Caption1>
                  <Field label="source">
                    <textarea
                      className={s.jsonArea}
                      value={JSON.stringify((activity.typeProperties as any)?.source || {}, null, 2)}
                      onChange={(e) => {
                        try {
                          const v = JSON.parse(e.target.value);
                          onPatch({ typeProperties: { ...(activity.typeProperties || {}), source: v } });
                        } catch { /* let the user finish typing */ }
                      }}
                    />
                  </Field>
                  <Field label="sink">
                    <textarea
                      className={s.jsonArea}
                      value={JSON.stringify((activity.typeProperties as any)?.sink || {}, null, 2)}
                      onChange={(e) => {
                        try {
                          const v = JSON.parse(e.target.value);
                          onPatch({ typeProperties: { ...(activity.typeProperties || {}), sink: v } });
                        } catch { /* ignore */ }
                      }}
                    />
                  </Field>
                </AccordionPanel>
              </AccordionItem>
            </Accordion>
            </div>
          </>
        )}

        {tab === 'settings' && (
          <>
            <div className={s.sectionHead}>
              <span className={s.sectionIcon} aria-hidden="true"><Settings20Regular /></span>
              <div>
                <Subtitle2>{isCopyActivity ? 'Activity policy' : 'Settings'}</Subtitle2>
                <Caption1 as="p" className={s.sectionHint}>Type-specific configuration and run-time policy for this activity.</Caption1>
              </div>
            </div>
            {hasActivityForm(activity.type) ? (
              <>
                <ActivityForm
                  activity={activity}
                  onPatch={onPatch}
                  parameters={parameters}
                  variables={variables}
                  allActivities={allActivities}
                  itemId={itemId}
                  pipelineId={pipelineId}
                  workspaceId={workspaceId}
                  apiSlug={apiSlug}
                  onDrillInto={onDrillInto}
                />
                <Accordion collapsible>
                  <AccordionItem value="raw-json">
                    <AccordionHeader>Advanced — raw typeProperties JSON</AccordionHeader>
                    <AccordionPanel>
                      <Field validationMessage={typePropsErr || undefined}
                        validationState={typePropsErr ? 'error' : 'none'}>
                        <textarea
                          className={s.jsonArea}
                          value={typePropsText}
                          onChange={(e) => {
                            setTypePropsText(e.target.value);
                            try {
                              const v = JSON.parse(e.target.value);
                              setTypePropsErr(null);
                              onPatch({ typeProperties: v });
                            } catch (err: any) {
                              setTypePropsErr(err?.message || 'invalid JSON');
                            }
                          }}
                        />
                      </Field>
                    </AccordionPanel>
                  </AccordionItem>
                </Accordion>
              </>
            ) : (
              <Field label="typeProperties (JSON)" validationMessage={typePropsErr || undefined}
                validationState={typePropsErr ? 'error' : 'none'}>
                <textarea
                  className={s.jsonArea}
                  value={typePropsText}
                  onChange={(e) => {
                    setTypePropsText(e.target.value);
                    try {
                      const v = JSON.parse(e.target.value);
                      setTypePropsErr(null);
                      onPatch({ typeProperties: v });
                    } catch (err: any) {
                      setTypePropsErr(err?.message || 'invalid JSON');
                    }
                  }}
                />
              </Field>
            )}
            <div className={s.card}>
              <div className={s.sectionHead}>
                <span className={s.sectionIcon} aria-hidden="true"><Timer20Regular /></span>
                <div>
                  <Subtitle2>Activity policy</Subtitle2>
                  <Caption1 as="p" className={s.sectionHint}>Run-time behaviour. Defaults: timeout 7 days, retry 0, retry interval 30s.</Caption1>
                </div>
              </div>
              <Field label="Timeout (D.HH:MM:SS)">
                <Input
                  value={(activity.policy as any)?.timeout || ''}
                  placeholder="7.00:00:00"
                  onChange={(_, d) => onPatch({ policy: { ...(activity.policy || {}), timeout: d.value } })}
                />
              </Field>
              <div className={s.rowSplit}>
                <Field label="Retry">
                  <Input type="number" min={0} value={String((activity.policy as any)?.retry ?? 0)}
                    onChange={(_, d) => onPatch({ policy: { ...(activity.policy || {}), retry: Math.max(0, parseInt(d.value, 10) || 0) } })}
                  />
                </Field>
                <Field label="Retry interval (s)">
                  <Input type="number" min={30} max={86400} value={String((activity.policy as any)?.retryIntervalInSeconds ?? 30)}
                    onChange={(_, d) => onPatch({ policy: { ...(activity.policy || {}), retryIntervalInSeconds: Math.max(30, Math.min(86400, parseInt(d.value, 10) || 30)) } })}
                  />
                </Field>
              </div>
              <Field label="Secure input">
                <Switch
                  checked={!!(activity.policy as any)?.secureInput}
                  label="Don't log input for monitoring"
                  onChange={(_, d) => onPatch({ policy: { ...(activity.policy || {}), secureInput: d.checked } })}
                />
              </Field>
              <Field label="Secure output">
                <Switch
                  checked={!!(activity.policy as any)?.secureOutput}
                  label="Don't log output for monitoring"
                  onChange={(_, d) => onPatch({ policy: { ...(activity.policy || {}), secureOutput: d.checked } })}
                />
              </Field>
            </div>
          </>
        )}

        {tab === 'parameters' && (
          <>
            <div className={s.sectionHead}>
              <span className={s.sectionIcon} aria-hidden="true"><BracesVariable20Regular /></span>
              <div>
                <Subtitle2>Parameters &amp; variables</Subtitle2>
                <Caption1 as="p" className={s.sectionHint}>Pipeline-scoped values this activity can reference.</Caption1>
              </div>
            </div>
            <div className={s.card}>
              <Caption1>Pipeline-scoped parameters available to this activity. Reference with <code>@pipeline().parameters.&lt;name&gt;</code>.</Caption1>
              <Table size="small">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell>Type</TableHeaderCell>
                    <TableHeaderCell>Default</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parameters.length === 0 && (
                    <TableRow><TableCell colSpan={3}><Caption1>None — add some in the Parameters tab above.</Caption1></TableCell></TableRow>
                  )}
                  {parameters.map((p) => (
                    <TableRow key={p.name}>
                      <TableCell><code>{p.name}</code></TableCell>
                      <TableCell>{p.type}</TableCell>
                      <TableCell>{String(p.defaultValue ?? '')}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Caption1>Pipeline-scoped variables (use with SetVariable / AppendVariable):</Caption1>
              <Table size="small">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell>Type</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {variables.length === 0 && (
                    <TableRow><TableCell colSpan={2}><Caption1>None.</Caption1></TableCell></TableRow>
                  )}
                  {variables.map((v) => (
                    <TableRow key={v.name}>
                      <TableCell><code>{v.name}</code></TableCell>
                      <TableCell>{v.type}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}

        {tab === 'user-props' && (
          <>
            <div className={s.sectionHead}>
              <span className={s.sectionIcon} aria-hidden="true"><TagMultiple20Regular /></span>
              <div>
                <Subtitle2>User properties</Subtitle2>
                <Caption1 as="p" className={s.sectionHint}>Tag pipeline runs for monitoring — keys/values appear in ADF run history.</Caption1>
              </div>
            </div>
            <div className={s.card}>
              {(activity.userProperties || []).map((up, i) => (
                <div key={i} className={s.upRow}>
                  <Input value={up.name} placeholder="key"
                    onChange={(_, d) => {
                      const ups = [...(activity.userProperties || [])];
                      ups[i] = { ...ups[i], name: d.value };
                      onPatch({ userProperties: ups });
                    }} />
                  <Input value={String(up.value ?? '')} placeholder="value"
                    onChange={(_, d) => {
                      const ups = [...(activity.userProperties || [])];
                      ups[i] = { ...ups[i], value: d.value };
                      onPatch({ userProperties: ups });
                    }} />
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />}
                    aria-label="Remove user property"
                    onClick={() => {
                      const ups = [...(activity.userProperties || [])];
                      ups.splice(i, 1);
                      onPatch({ userProperties: ups });
                    }} />
                </div>
              ))}
              <Button size="small" icon={<Add20Regular />}
                onClick={() => onPatch({ userProperties: [...(activity.userProperties || []), { name: '', value: '' }] })}>
                Add user property
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
