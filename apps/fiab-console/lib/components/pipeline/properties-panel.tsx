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
 */

import { useState, useEffect } from 'react';
import {
  Tab, TabList, Input, Field, Textarea, Caption1, Button, Subtitle2,
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, Badge, makeStyles, tokens, Select, Switch,
  Dropdown, Option,
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular } from '@fluentui/react-icons';
import { findByType } from './activity-catalog';
import type { PipelineActivity, PipelineParameter, PipelineParameterType, PipelineVariable } from './types';

const useStyles = makeStyles({
  // Right-rail layout (legacy callers).
  root: {
    display: 'flex', flexDirection: 'column',
    width: 380, minWidth: 320,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 4,
    overflow: 'hidden',
  },
  // Bottom-dock layout (ADF Studio parity) — full width, fixed height,
  // header + horizontal tab strip + scrollable body.
  dockRoot: {
    display: 'flex', flexDirection: 'column',
    width: '100%', height: 260,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 4,
    overflow: 'hidden',
  },
  header: {
    display: 'flex', flexDirection: 'column', gap: 4,
    padding: '12px 16px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  body: { padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, flex: 1 },
  empty: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 40, color: tokens.colorNeutralForeground3,
  },
  jsonArea: {
    width: '100%', minHeight: 160,
    fontFamily: 'Consolas, monospace', fontSize: 12, padding: 8,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 4,
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
}

type TabId = 'general' | 'source-sink' | 'settings' | 'parameters' | 'user-props';

export function PropertiesPanel({ activity, allActivities, parameters, variables, onPatch, onDelete, layout = 'rail' }: PropertiesPanelProps) {
  const s = useStyles();
  const rootClass = layout === 'dock' ? s.dockRoot : s.root;
  const [tab, setTab] = useState<TabId>('general');
  const [typePropsText, setTypePropsText] = useState('');
  const [typePropsErr, setTypePropsErr] = useState<string | null>(null);

  // Factory datasets — backs the Source/Sink input/output dataset pickers.
  // Best-effort: on Synapse (or unconfigured factory) the route gates and the
  // dropdowns simply render empty, never blocking the raw JSON editors below.
  const [datasets, setDatasets] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/adf/datasets');
        const body = await res.json().catch(() => ({}));
        if (alive && body?.ok && Array.isArray(body.datasets)) {
          setDatasets(body.datasets.map((d: any) => d.name).filter(Boolean));
        }
      } catch { /* leave empty — raw JSON editors still work */ }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!activity) return;
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
        <div className={s.empty}>
          <Caption1>Select an activity on the canvas to edit its properties (General, Source/Sink, Settings, Parameters, User properties).</Caption1>
        </div>
      </div>
    );
  }

  const def = findByType(activity.type);
  const hasSourceSink = !!(activity.typeProperties && ('source' in activity.typeProperties || 'sink' in activity.typeProperties));

  return (
    <div className={rootClass} data-properties-dock={layout === 'dock' ? '' : undefined}>
      <div className={s.header}>
        <Subtitle2>{activity.name}</Subtitle2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Badge appearance="filled" size="small"
            style={{ backgroundColor: def?.color || tokens.colorBrandBackground, color: def?.fg || '#fff' }}>
            {def?.label || activity.type || 'Unknown'}
          </Badge>
          {def && !def.runnable && (
            <Badge appearance="outline" size="small" color="warning" title={def.remediation}>Save-only</Badge>
          )}
        </div>
        {def && !def.runnable && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Activity will not execute on this backing</MessageBarTitle>
              {def.remediation}
            </MessageBarBody>
          </MessageBar>
        )}
      </div>

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as TabId)} size="small"
        style={{ padding: '0 8px', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
        <Tab value="general">General</Tab>
        {hasSourceSink && <Tab value="source-sink">Source / Sink</Tab>}
        <Tab value="settings">Settings</Tab>
        <Tab value="parameters">Parameters</Tab>
        <Tab value="user-props">User properties</Tab>
      </TabList>

      <div className={s.body}>
        {tab === 'general' && (
          <>
            <Field label="Name" required>
              <Input value={activity.name} onChange={(_, d) => onPatch({ name: d.value })} />
            </Field>
            <Field label="Description">
              <Textarea value={activity.description || ''} rows={2}
                onChange={(_, d) => onPatch({ description: d.value })} />
            </Field>
            <Field label="Depends on">
              <Caption1>Click to toggle a dependency on another activity.</Caption1>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                {allActivities.filter((a) => a.name !== activity.name).map((a) => {
                  const dep = (activity.dependsOn || []).find((d) => d.activity === a.name);
                  const conds = dep?.dependencyConditions || [];
                  return (
                    <div key={a.name} style={{ display: 'flex', gap: 4 }}>
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
            <Button appearance="subtle" icon={<Delete20Regular />} onClick={onDelete}
              style={{ marginTop: 'auto', alignSelf: 'flex-start', color: tokens.colorPaletteRedForeground1 }}>
              Delete activity
            </Button>
          </>
        )}

        {tab === 'source-sink' && hasSourceSink && (
          <>
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
                    in the ribbon&apos;s <strong>Manage</strong> hub. {datasets.length === 0 && '(No datasets found — create one in Manage, or the factory isn’t configured.)'}
                  </Caption1>
                  <Field label="Source dataset (inputs[0])">
                    <Dropdown
                      placeholder={datasets.length ? 'Select a dataset' : 'No datasets available'}
                      value={inputName || ''}
                      selectedOptions={inputName ? [inputName] : []}
                      disabled={!datasets.length}
                      onOptionSelect={(_, d) => onPatch({ inputs: refOrEmpty(d.optionValue || '') })}
                    >
                      <Option value="" text="(none)">(none)</Option>
                      {datasets.map((n) => <Option key={n} value={n} text={n}>{n}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Sink dataset (outputs[0])">
                    <Dropdown
                      placeholder={datasets.length ? 'Select a dataset' : 'No datasets available'}
                      value={outputName || ''}
                      selectedOptions={outputName ? [outputName] : []}
                      disabled={!datasets.length}
                      onOptionSelect={(_, d) => onPatch({ outputs: refOrEmpty(d.optionValue || '') })}
                    >
                      <Option value="" text="(none)">(none)</Option>
                      {datasets.map((n) => <Option key={n} value={n} text={n}>{n}</Option>)}
                    </Dropdown>
                  </Field>
                </>
              );
            })()}
            <Caption1>Source / sink JSON. Wire up datasets via the Lookup or Copy reference list — these fields are surfaced raw so power users can target any connector type.</Caption1>
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
          </>
        )}

        {tab === 'settings' && (
          <>
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
            <Subtitle2>Activity policy</Subtitle2>
            <Caption1>Run-time behaviour (ADF activity policy). Defaults: timeout 7 days, retry 0, retry interval 30s.</Caption1>
            <Field label="Timeout (D.HH:MM:SS)">
              <Input
                value={(activity.policy as any)?.timeout || ''}
                placeholder="7.00:00:00"
                onChange={(_, d) => onPatch({ policy: { ...(activity.policy || {}), timeout: d.value } })}
              />
            </Field>
            <div style={{ display: 'flex', gap: 12 }}>
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
            <Field label="Secure output">
              <Switch
                checked={!!(activity.policy as any)?.secureOutput}
                label="Don't log output for monitoring"
                onChange={(_, d) => onPatch({ policy: { ...(activity.policy || {}), secureOutput: d.checked } })}
              />
            </Field>
          </>
        )}

        {tab === 'parameters' && (
          <>
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
          </>
        )}

        {tab === 'user-props' && (
          <>
            <Caption1>User properties tag pipeline runs for monitoring. Keys/values appear in ADF run history.</Caption1>
            {(activity.userProperties || []).map((up, i) => (
              <div key={i} style={{ display: 'flex', gap: 6 }}>
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
          </>
        )}
      </div>
    </div>
  );
}
