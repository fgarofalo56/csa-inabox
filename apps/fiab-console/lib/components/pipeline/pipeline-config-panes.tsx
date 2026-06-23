'use client';

/**
 * Pipeline-level configuration panes — ADF Studio's "pipeline configurations
 * pane": Parameters, Variables, and (General) Settings. These edit the
 * pipeline JSON's `properties.parameters`, `properties.variables`,
 * `properties.concurrency` / `annotations` / `description` — NOT a single
 * activity. Grounded in Learn: concepts-pipelines-activities#pipeline-json
 * (parameters, concurrency, annotations) + author-visually (annotations).
 *
 * Pure controlled editors — they take the flat arrays and emit the next ones.
 */

import {
  Button, Caption1, Field, Input, Select, Subtitle2, Tag, TagGroup, Textarea,
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular } from '@fluentui/react-icons';
import { useState } from 'react';
import type {
  PipelineParameter, PipelineParameterType, PipelineVariable,
} from './types';

const useStyles = makeStyles({
  pane: { padding: tokens.spacingHorizontalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalM, overflow: 'auto' },
  rowActions: { display: 'flex', gap: tokens.spacingHorizontalSNudge, alignItems: 'flex-end', flexWrap: 'wrap' },
});

const PARAM_TYPES: PipelineParameterType[] = ['string', 'int', 'float', 'bool', 'array', 'object', 'secureString'];
const VAR_TYPES: PipelineVariable['type'][] = ['String', 'Boolean', 'Array'];

// ---------------- Parameters ----------------
export function ParametersPane({ parameters, onChange, readOnly }: {
  parameters: PipelineParameter[];
  onChange: (next: PipelineParameter[]) => void;
  readOnly?: boolean;
}) {
  const s = useStyles();
  const [name, setName] = useState('');
  const [type, setType] = useState<PipelineParameterType>('string');
  const add = () => {
    if (!name.trim() || parameters.some((p) => p.name === name.trim())) return;
    onChange([...parameters, { name: name.trim(), type, defaultValue: '' }]);
    setName('');
  };
  return (
    <div className={s.pane} data-config-pane="parameters">
      <Subtitle2>Parameters</Subtitle2>
      <Caption1>Pipeline parameters are read-only at runtime; reference them with <code>@pipeline().parameters.&lt;name&gt;</code>.</Caption1>
      <Table size="small" aria-label="Pipeline parameters">
        <TableHeader><TableRow>
          <TableHeaderCell>Name</TableHeaderCell>
          <TableHeaderCell>Type</TableHeaderCell>
          <TableHeaderCell>Default value</TableHeaderCell>
          <TableHeaderCell></TableHeaderCell>
        </TableRow></TableHeader>
        <TableBody>
          {parameters.length === 0 && (<TableRow><TableCell colSpan={4}><Caption1>No parameters.</Caption1></TableCell></TableRow>)}
          {parameters.map((p, i) => (
            <TableRow key={p.name}>
              <TableCell><code>{p.name}</code></TableCell>
              <TableCell>
                <Select size="small" value={p.type} disabled={readOnly}
                  onChange={(_, d) => onChange(parameters.map((x, j) => j === i ? { ...x, type: d.value as PipelineParameterType } : x))}>
                  {PARAM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </Select>
              </TableCell>
              <TableCell>
                <Input size="small" value={String(p.defaultValue ?? '')} disabled={readOnly}
                  onChange={(_, d) => onChange(parameters.map((x, j) => j === i ? { ...x, defaultValue: d.value } : x))} />
              </TableCell>
              <TableCell>
                <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={readOnly}
                  aria-label={`Delete parameter ${p.name}`}
                  onClick={() => onChange(parameters.filter((_, j) => j !== i))} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!readOnly && (
        <div className={s.rowActions}>
          <Field label="New parameter"><Input size="small" value={name} placeholder="windowStart" onChange={(_, d) => setName(d.value)} /></Field>
          <Field label="Type">
            <Select size="small" value={type} onChange={(_, d) => setType(d.value as PipelineParameterType)}>
              {PARAM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
          <Button size="small" icon={<Add20Regular />} disabled={!name.trim()} onClick={add}>Add parameter</Button>
        </div>
      )}
    </div>
  );
}

// ---------------- Variables ----------------
export function VariablesPane({ variables, onChange, readOnly }: {
  variables: PipelineVariable[];
  onChange: (next: PipelineVariable[]) => void;
  readOnly?: boolean;
}) {
  const s = useStyles();
  const [name, setName] = useState('');
  const [type, setType] = useState<PipelineVariable['type']>('String');
  const add = () => {
    if (!name.trim() || variables.some((v) => v.name === name.trim())) return;
    onChange([...variables, { name: name.trim(), type, defaultValue: '' }]);
    setName('');
  };
  return (
    <div className={s.pane} data-config-pane="variables">
      <Subtitle2>Variables</Subtitle2>
      <Caption1>Pipeline variables are mutable at runtime via Set/Append variable activities.</Caption1>
      <Table size="small" aria-label="Pipeline variables">
        <TableHeader><TableRow>
          <TableHeaderCell>Name</TableHeaderCell>
          <TableHeaderCell>Type</TableHeaderCell>
          <TableHeaderCell>Default value</TableHeaderCell>
          <TableHeaderCell></TableHeaderCell>
        </TableRow></TableHeader>
        <TableBody>
          {variables.length === 0 && (<TableRow><TableCell colSpan={4}><Caption1>No variables.</Caption1></TableCell></TableRow>)}
          {variables.map((v, i) => (
            <TableRow key={v.name}>
              <TableCell><code>{v.name}</code></TableCell>
              <TableCell>
                <Select size="small" value={v.type} disabled={readOnly}
                  onChange={(_, d) => onChange(variables.map((x, j) => j === i ? { ...x, type: d.value as PipelineVariable['type'] } : x))}>
                  {VAR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </Select>
              </TableCell>
              <TableCell>
                <Input size="small" value={String(v.defaultValue ?? '')} disabled={readOnly}
                  onChange={(_, d) => onChange(variables.map((x, j) => j === i ? { ...x, defaultValue: d.value } : x))} />
              </TableCell>
              <TableCell>
                <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={readOnly}
                  aria-label={`Delete variable ${v.name}`}
                  onClick={() => onChange(variables.filter((_, j) => j !== i))} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!readOnly && (
        <div className={s.rowActions}>
          <Field label="New variable"><Input size="small" value={name} placeholder="counter" onChange={(_, d) => setName(d.value)} /></Field>
          <Field label="Type">
            <Select size="small" value={type} onChange={(_, d) => setType(d.value as PipelineVariable['type'])}>
              {VAR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
          <Button size="small" icon={<Add20Regular />} disabled={!name.trim()} onClick={add}>Add variable</Button>
        </div>
      )}
    </div>
  );
}

// ---------------- Settings (General) ----------------
export function SettingsPane({ description, concurrency, annotations, onChange, readOnly }: {
  description: string;
  concurrency: number | undefined;
  annotations: string[];
  onChange: (next: { description?: string; concurrency?: number; annotations?: string[] }) => void;
  readOnly?: boolean;
}) {
  const s = useStyles();
  const [ann, setAnn] = useState('');
  return (
    <div className={s.pane} data-config-pane="settings">
      <Subtitle2>General settings</Subtitle2>
      <Field label="Description">
        <Textarea value={description} rows={2} disabled={readOnly}
          onChange={(_, d) => onChange({ description: d.value })} />
      </Field>
      <Field label="Concurrency" hint="Max concurrent pipeline runs. Blank = unlimited.">
        <Input type="number" min={1} value={concurrency != null ? String(concurrency) : ''} disabled={readOnly}
          placeholder="unlimited"
          onChange={(_, d) => onChange({ concurrency: d.value ? Math.max(1, parseInt(d.value, 10) || 1) : undefined })} />
      </Field>
      <Field label="Annotations">
        <TagGroup
          onDismiss={readOnly ? undefined : (_, d) => onChange({ annotations: annotations.filter((a) => a !== d.value) })}>
          {annotations.map((a) => (
            <Tag key={a} value={a} dismissible={!readOnly}>{a}</Tag>
          ))}
        </TagGroup>
        {!readOnly && (
          <div className={s.rowActions} style={{ marginTop: 8 }}>
            <Input size="small" value={ann} placeholder="prod" onChange={(_, d) => setAnn(d.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && ann.trim()) { onChange({ annotations: [...annotations, ann.trim()] }); setAnn(''); } }} />
            <Button size="small" icon={<Add20Regular />} disabled={!ann.trim() || annotations.includes(ann.trim())}
              onClick={() => { onChange({ annotations: [...annotations, ann.trim()] }); setAnn(''); }}>Add</Button>
          </div>
        )}
      </Field>
    </div>
  );
}
