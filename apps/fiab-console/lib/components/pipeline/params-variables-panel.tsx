'use client';

/**
 * params-variables-panel — the DEEPENED Loom one-for-one of ADF / Synapse /
 * Fabric Studio's pipeline-level **Parameters** and **Variables** authoring
 * panes, plus a read-only **System variables** reference.
 *
 * WHY THIS MODULE EXISTS (and what it round-trips)
 * ------------------------------------------------
 * ADF Studio's pipeline-configurations pane lets the author:
 *   • Parameters tab — add / rename / retype / remove pipeline parameters and
 *     set each one's *default value*. The type comes from the param-type model
 *     (string | int | float | bool | array | object | secureString) and the
 *     default may itself be an `@{…}` expression (e.g. a default that calls
 *     `@utcNow()` or references another parameter). Parameters are read-only at
 *     runtime and are referenced as `@pipeline().parameters.<name>`.
 *   • Variables tab — add / rename / retype / remove pipeline variables
 *     (String | Boolean | Array) and set a literal default. Variables are
 *     mutable at runtime via Set/Append-variable activities and referenced as
 *     `@variables('<name>')`.
 *   • System variables — a read-only reference of `@pipeline().*` / `@trigger().*`
 *     accessors so the author knows what's available without leaving the pane.
 *
 * These write straight to `pipeline.properties.parameters` /
 * `pipeline.properties.variables` (the flat editor arrays are converted back to
 * the ADF wire record by `paramsToSpec` / `varsToSpec` in the editor core) and
 * round-trip on the real REST via adf-client / synapse-artifacts-client. No
 * mocks, no freeform JSON — structured Fluent forms only
 * (loom-no-freeform-config + no-vaporware).
 *
 * REUSE
 * -----
 *   • ExpressionField (expression-field.tsx) — parameter default values that
 *     ADF allows to be `@{…}` expressions; the picker offers the OTHER
 *     parameters / variables / system variables so a default can reference them.
 *   • SYSTEM_VARIABLES / systemVariablesByScope (expression-functions.ts) — the
 *     single canonical system-variable catalog, also used by the dynamic-content
 *     builder, so the reference here never drifts.
 *
 * The existing `pipeline-config-panes.tsx` re-exports `ParametersPane` /
 * `VariablesPane` from here so the editor-core wiring is unchanged.
 */

import { useMemo, useState } from 'react';
import {
  Button, Caption1, Field, Input, Select, Subtitle2, Body1Strong, Tooltip,
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  Switch, MessageBar, MessageBarBody, Badge, SearchBox,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular, Copy16Regular, Info16Regular } from '@fluentui/react-icons';
import { ExpressionField, isDynamicExpression } from './expression-field';
import { SYSTEM_VARIABLES, systemVariablesByScope } from './expression-functions';
import type {
  PipelineParameter, PipelineParameterType, PipelineVariable,
} from './types';

const useStyles = makeStyles({
  pane: {
    padding: tokens.spacingHorizontalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    overflow: 'auto',
    minWidth: 0,
  },
  headRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3 },
  nameCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  ref: {
    fontFamily: 'Consolas, monospace',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorBrandForeground1,
    overflowWrap: 'anywhere',
  },
  addCard: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  grow: { flexGrow: 1, minWidth: '160px' },
  defaultCell: { minWidth: '220px' },
  sysVarRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  sysVarName: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    fontFamily: 'Consolas, monospace',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorBrandForeground1,
  },
});

const PARAM_TYPES: PipelineParameterType[] = ['string', 'int', 'float', 'bool', 'array', 'object', 'secureString'];
const VAR_TYPES: PipelineVariable['type'][] = ['String', 'Boolean', 'Array'];

/** ADF parameter-name rule: letters, digits, underscores; not starting with a digit. */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function nameError(name: string, existing: string[], self?: string): string | null {
  const n = name.trim();
  if (!n) return null;
  if (!NAME_RE.test(n)) return 'Use letters, digits, and underscores; cannot start with a digit.';
  if (existing.some((e) => e === n && e !== self)) return 'A name with this value already exists.';
  return null;
}

/** Placeholder a param default Input should show for a given type. */
function paramDefaultPlaceholder(t: PipelineParameterType): string {
  switch (t) {
    case 'int': return '0';
    case 'float': return '0.0';
    case 'bool': return 'true';
    case 'array': return '["a","b"]';
    case 'object': return '{ "key": "value" }';
    case 'secureString': return '(stored as secureString)';
    default: return 'windowStart';
  }
}

/** Coerce a default-value string into the JSON-typed value ADF stores. */
function coerceParamDefault(raw: string, t: PipelineParameterType): unknown {
  const v = raw ?? '';
  // An @-expression is stored verbatim (ADF resolves it at runtime).
  if (isDynamicExpression(v)) return v;
  if (v === '') return undefined;
  if (t === 'int') { const n = parseInt(v, 10); return Number.isFinite(n) ? n : v; }
  if (t === 'float') { const n = Number(v); return Number.isFinite(n) ? n : v; }
  if (t === 'bool') { if (v === 'true') return true; if (v === 'false') return false; return v; }
  if (t === 'array' || t === 'object') {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

/** Render the stored default value back to an editable string. */
function paramDefaultToString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') { try { return JSON.stringify(value); } catch { return ''; } }
  return String(value);
}

// =============================================================================
// Parameters
// =============================================================================

export interface ParametersPaneProps {
  parameters: PipelineParameter[];
  onChange: (next: PipelineParameter[]) => void;
  /** Variable names — offered in the default-value expression picker. */
  variables?: PipelineVariable[];
  readOnly?: boolean;
  /** Pipeline item id + workspace id — let ExpressionField's Evaluate pre-fill from the last run. */
  pipelineId?: string;
  workspaceId?: string;
}

export function ParametersPane({
  parameters, onChange, variables, readOnly, pipelineId, workspaceId,
}: ParametersPaneProps) {
  const s = useStyles();
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<PipelineParameterType>('string');

  const names = useMemo(() => parameters.map((p) => p.name), [parameters]);
  const addErr = nameError(newName, names);

  // The picker should offer the OTHER params (not the one being edited) + all variables.
  const variableNames = useMemo(() => (variables ?? []).map((v) => v.name), [variables]);

  const add = () => {
    const n = newName.trim();
    if (!n || addErr) return;
    onChange([...parameters, { name: n, type: newType, defaultValue: newType === 'secureString' ? undefined : '' }]);
    setNewName('');
    setNewType('string');
  };

  const update = (i: number, patch: Partial<PipelineParameter>) =>
    onChange(parameters.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <div className={s.pane} data-config-pane="parameters">
      <div className={s.headRow}>
        <Subtitle2>Parameters</Subtitle2>
        <Badge appearance="tint" color="informative">{parameters.length}</Badge>
      </div>
      <Caption1 className={s.hint}>
        Pipeline parameters are read-only at runtime. Reference one with{' '}
        <code>@pipeline().parameters.&lt;name&gt;</code>. A default value may be a
        literal or an <code>@&#123;…&#125;</code> expression.
      </Caption1>

      <Table size="small" aria-label="Pipeline parameters">
        <TableHeader><TableRow>
          <TableHeaderCell>Name</TableHeaderCell>
          <TableHeaderCell>Type</TableHeaderCell>
          <TableHeaderCell>Default value</TableHeaderCell>
          <TableHeaderCell>Reference</TableHeaderCell>
          <TableHeaderCell aria-label="Actions" />
        </TableRow></TableHeader>
        <TableBody>
          {parameters.length === 0 && (
            <TableRow><TableCell colSpan={5}><Caption1 className={s.hint}>No parameters yet. Add one below.</Caption1></TableCell></TableRow>
          )}
          {parameters.map((p, i) => {
            const renameErr = nameError(p.name, names, p.name);
            const otherParamNames = names.filter((_, j) => j !== i);
            const ref = `@pipeline().parameters.${p.name}`;
            return (
              <TableRow key={`param-${i}`}>
                <TableCell>
                  <Field
                    validationState={renameErr ? 'error' : undefined}
                    validationMessage={renameErr ?? undefined}>
                    <Input size="small" value={p.name} disabled={readOnly}
                      aria-label={`Parameter name ${p.name}`}
                      onChange={(_, d) => update(i, { name: d.value })} />
                  </Field>
                </TableCell>
                <TableCell>
                  <Select size="small" value={p.type} disabled={readOnly}
                    aria-label={`Parameter type ${p.name}`}
                    onChange={(_, d) => {
                      const t = d.value as PipelineParameterType;
                      // Re-coerce the existing default to the new type.
                      update(i, { type: t, defaultValue: coerceParamDefault(paramDefaultToString(p.defaultValue), t) });
                    }}>
                    {PARAM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </Select>
                </TableCell>
                <TableCell className={s.defaultCell}>
                  {p.type === 'secureString' ? (
                    <Input size="small" type="password" disabled={readOnly}
                      placeholder="(secret default)"
                      value={paramDefaultToString(p.defaultValue)}
                      aria-label={`Default value ${p.name}`}
                      onChange={(_, d) => update(i, { defaultValue: d.value === '' ? undefined : d.value })} />
                  ) : (
                    <ExpressionField
                      value={paramDefaultToString(p.defaultValue)}
                      onChange={(next) => update(i, { defaultValue: coerceParamDefault(next, p.type) })}
                      placeholder={paramDefaultPlaceholder(p.type)}
                      disabled={readOnly}
                      multiline={p.type === 'array' || p.type === 'object'}
                      availableParams={otherParamNames}
                      availableVariables={variableNames}
                      pipelineId={pipelineId}
                      workspaceId={workspaceId}
                    />
                  )}
                </TableCell>
                <TableCell>
                  <div className={s.nameCell}>
                    <span className={s.ref}>{ref}</span>
                    <Tooltip content="Copy reference" relationship="label">
                      <Button size="small" appearance="subtle" icon={<Copy16Regular />}
                        aria-label={`Copy reference for ${p.name}`}
                        onClick={() => copyText(ref)} />
                    </Tooltip>
                  </div>
                </TableCell>
                <TableCell>
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={readOnly}
                    aria-label={`Delete parameter ${p.name}`}
                    onClick={() => onChange(parameters.filter((_, j) => j !== i))} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {!readOnly && (
        <div className={s.addCard}>
          <Field label="New parameter" className={s.grow}
            validationState={addErr ? 'error' : undefined}
            validationMessage={addErr ?? undefined}>
            <Input size="small" value={newName} placeholder="windowStart"
              onChange={(_, d) => setNewName(d.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
          </Field>
          <Field label="Type">
            <Select size="small" value={newType} onChange={(_, d) => setNewType(d.value as PipelineParameterType)}>
              {PARAM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
          <Button size="small" appearance="primary" icon={<Add20Regular />}
            disabled={!newName.trim() || !!addErr} onClick={add}>
            Add parameter
          </Button>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Variables
// =============================================================================

export interface VariablesPaneProps {
  variables: PipelineVariable[];
  onChange: (next: PipelineVariable[]) => void;
  readOnly?: boolean;
}

/** Coerce a variable default to its declared type. */
function coerceVarDefault(raw: string, t: PipelineVariable['type']): unknown {
  const v = raw ?? '';
  if (v === '') return '';
  if (t === 'Boolean') { if (v === 'true') return true; if (v === 'false') return false; return v; }
  if (t === 'Array') { try { return JSON.parse(v); } catch { return v; } }
  return v;
}
function varDefaultToString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) { try { return JSON.stringify(value); } catch { return ''; } }
  return String(value);
}

export function VariablesPane({ variables, onChange, readOnly }: VariablesPaneProps) {
  const s = useStyles();
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<PipelineVariable['type']>('String');

  const names = useMemo(() => variables.map((v) => v.name), [variables]);
  const addErr = nameError(newName, names);

  const add = () => {
    const n = newName.trim();
    if (!n || addErr) return;
    onChange([...variables, { name: n, type: newType, defaultValue: newType === 'Boolean' ? false : newType === 'Array' ? [] : '' }]);
    setNewName('');
    setNewType('String');
  };

  const update = (i: number, patch: Partial<PipelineVariable>) =>
    onChange(variables.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <div className={s.pane} data-config-pane="variables">
      <div className={s.headRow}>
        <Subtitle2>Variables</Subtitle2>
        <Badge appearance="tint" color="informative">{variables.length}</Badge>
      </div>
      <Caption1 className={s.hint}>
        Pipeline variables are mutable at runtime via Set/Append-variable
        activities. Reference one with <code>@variables('&lt;name&gt;')</code>.
      </Caption1>

      <Table size="small" aria-label="Pipeline variables">
        <TableHeader><TableRow>
          <TableHeaderCell>Name</TableHeaderCell>
          <TableHeaderCell>Type</TableHeaderCell>
          <TableHeaderCell>Default value</TableHeaderCell>
          <TableHeaderCell>Reference</TableHeaderCell>
          <TableHeaderCell aria-label="Actions" />
        </TableRow></TableHeader>
        <TableBody>
          {variables.length === 0 && (
            <TableRow><TableCell colSpan={5}><Caption1 className={s.hint}>No variables yet. Add one below.</Caption1></TableCell></TableRow>
          )}
          {variables.map((v, i) => {
            const renameErr = nameError(v.name, names, v.name);
            const ref = `@variables('${v.name}')`;
            return (
              <TableRow key={`var-${i}`}>
                <TableCell>
                  <Field
                    validationState={renameErr ? 'error' : undefined}
                    validationMessage={renameErr ?? undefined}>
                    <Input size="small" value={v.name} disabled={readOnly}
                      aria-label={`Variable name ${v.name}`}
                      onChange={(_, d) => update(i, { name: d.value })} />
                  </Field>
                </TableCell>
                <TableCell>
                  <Select size="small" value={v.type} disabled={readOnly}
                    aria-label={`Variable type ${v.name}`}
                    onChange={(_, d) => {
                      const t = d.value as PipelineVariable['type'];
                      update(i, { type: t, defaultValue: coerceVarDefault(varDefaultToString(v.defaultValue), t) });
                    }}>
                    {VAR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </Select>
                </TableCell>
                <TableCell className={s.defaultCell}>
                  {v.type === 'Boolean' ? (
                    <Switch
                      checked={v.defaultValue === true}
                      disabled={readOnly}
                      label={v.defaultValue === true ? 'true' : 'false'}
                      aria-label={`Default value ${v.name}`}
                      onChange={(_, d) => update(i, { defaultValue: d.checked })} />
                  ) : (
                    <Input size="small" disabled={readOnly}
                      placeholder={v.type === 'Array' ? '["a","b"]' : 'value'}
                      value={varDefaultToString(v.defaultValue)}
                      aria-label={`Default value ${v.name}`}
                      onChange={(_, d) => update(i, { defaultValue: coerceVarDefault(d.value, v.type) })} />
                  )}
                </TableCell>
                <TableCell>
                  <div className={s.nameCell}>
                    <span className={s.ref}>{ref}</span>
                    <Tooltip content="Copy reference" relationship="label">
                      <Button size="small" appearance="subtle" icon={<Copy16Regular />}
                        aria-label={`Copy reference for ${v.name}`}
                        onClick={() => copyText(ref)} />
                    </Tooltip>
                  </div>
                </TableCell>
                <TableCell>
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={readOnly}
                    aria-label={`Delete variable ${v.name}`}
                    onClick={() => onChange(variables.filter((_, j) => j !== i))} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {!readOnly && (
        <div className={s.addCard}>
          <Field label="New variable" className={s.grow}
            validationState={addErr ? 'error' : undefined}
            validationMessage={addErr ?? undefined}>
            <Input size="small" value={newName} placeholder="counter"
              onChange={(_, d) => setNewName(d.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
          </Field>
          <Field label="Type">
            <Select size="small" value={newType} onChange={(_, d) => setNewType(d.value as PipelineVariable['type'])}>
              {VAR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
          <Button size="small" appearance="primary" icon={<Add20Regular />}
            disabled={!newName.trim() || !!addErr} onClick={add}>
            Add variable
          </Button>
        </div>
      )}

      <SystemVariablesReference />
    </div>
  );
}

// =============================================================================
// System variables — read-only reference (the canonical catalog)
// =============================================================================

/**
 * Read-only reference of the system variables ADF/Synapse expose, grouped by
 * scope (Pipeline / Schedule trigger / Tumbling-window trigger / Storage-event
 * trigger). Sourced from the SAME `SYSTEM_VARIABLES` catalog the dynamic-content
 * builder uses, so it never drifts. Each row is copyable.
 */
export function SystemVariablesReference() {
  const s = useStyles();
  const [query, setQuery] = useState('');
  const groups = useMemo(() => systemVariablesByScope(), []);
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => groups
      .map((g) => ({
        ...g,
        variables: q
          ? g.variables.filter((v) => v.name.toLowerCase().includes(q) || v.description.toLowerCase().includes(q))
          : g.variables,
      }))
      .filter((g) => g.variables.length > 0),
    [groups, q],
  );

  return (
    <div data-config-pane="system-variables">
      <div className={s.headRow} style={{ marginTop: tokens.spacingVerticalS }}>
        <Body1Strong>System variables</Body1Strong>
        <Tooltip
          content="Built-in run/trigger context you can reference in any expression. Read-only — defined by the service, not editable."
          relationship="label">
          <Info16Regular />
        </Tooltip>
        <Badge appearance="tint" color="subtle">read-only</Badge>
      </div>
      <Caption1 className={s.hint}>
        Reference these anywhere an expression is allowed — e.g.{' '}
        <code>@pipeline().RunId</code> or <code>@trigger().scheduledTime</code>.
      </Caption1>
      <SearchBox
        size="small"
        placeholder="Filter system variables"
        value={query}
        onChange={(_, d) => setQuery(d.value)}
        style={{ marginTop: tokens.spacingVerticalXS, maxWidth: '320px' }}
      />
      <Accordion multiple collapsible defaultOpenItems={['pipeline']} style={{ marginTop: tokens.spacingVerticalXS }}>
        {filtered.map((g) => (
          <AccordionItem key={g.scope} value={g.scope}>
            <AccordionHeader>{g.label} ({g.variables.length})</AccordionHeader>
            <AccordionPanel>
              <Table size="small" aria-label={`${g.label} system variables`}>
                <TableHeader><TableRow>
                  <TableHeaderCell>Variable</TableHeaderCell>
                  <TableHeaderCell>Description</TableHeaderCell>
                  <TableHeaderCell aria-label="Copy" />
                </TableRow></TableHeader>
                <TableBody>
                  {g.variables.map((v) => (
                    <TableRow key={v.name}>
                      <TableCell>
                        <span className={s.sysVarName}>{v.name}</span>
                      </TableCell>
                      <TableCell><Caption1 className={s.hint}>{v.description}</Caption1></TableCell>
                      <TableCell>
                        <Tooltip content="Copy expression" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Copy16Regular />}
                            aria-label={`Copy ${v.name}`}
                            onClick={() => copyText(v.name)} />
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </AccordionPanel>
          </AccordionItem>
        ))}
        {filtered.length === 0 && (
          <MessageBar intent="info"><MessageBarBody>No system variables match “{query}”.</MessageBarBody></MessageBar>
        )}
      </Accordion>
    </div>
  );
}

/** Best-effort clipboard copy (client-only; silently no-ops where unavailable). */
function copyText(text: string) {
  try { void navigator.clipboard?.writeText(text); } catch { /* clipboard unavailable */ }
}

// Re-export the canonical catalog count for callers that want a quick badge.
export const SYSTEM_VARIABLE_COUNT = SYSTEM_VARIABLES.length;
