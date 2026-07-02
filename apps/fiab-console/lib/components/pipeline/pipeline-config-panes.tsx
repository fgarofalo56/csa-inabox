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
 *
 * The deepened Parameters / Variables authoring (per-type default values,
 * rename + validation, `@{…}` expression defaults, copyable references, and the
 * read-only System-variables reference) lives in `params-variables-panel.tsx`.
 * `ParametersPane` / `VariablesPane` are re-exported from there UNCHANGED so the
 * existing editor-core wiring (which imports them from this module) keeps
 * working; `SettingsPane` (General) remains here.
 */

import {
  Button, Field, Input, Subtitle2, Tag, TagGroup, Textarea,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular } from '@fluentui/react-icons';
import { useState } from 'react';

// Deepened Parameters / Variables authoring + System-variables reference.
export {
  ParametersPane, VariablesPane, SystemVariablesReference,
  type ParametersPaneProps, type VariablesPaneProps,
} from './params-variables-panel';

const useStyles = makeStyles({
  pane: { padding: tokens.spacingHorizontalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalM, overflow: 'auto' },
  rowActions: { display: 'flex', gap: tokens.spacingHorizontalSNudge, alignItems: 'flex-end', flexWrap: 'wrap' },
  annAdd: { marginTop: tokens.spacingVerticalS },
});

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
          <div className={`${s.rowActions} ${s.annAdd}`}>
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
