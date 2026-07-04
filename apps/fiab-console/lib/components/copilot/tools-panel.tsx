'use client';

/**
 * ToolsPanel — the Loom Copilot console right rail (audit-T121).
 *
 * Self-explanatory tools + active persona:
 *   • Persona header from getPanePersona(contextSlug) — title + greeting, plus a
 *     "reads your active query/schema" chip when context is attached.
 *   • Live orchestrator status (Ready badge / honest AOAI gate is owned by the
 *     parent; this shows the tool count + AOAI deployment when ready).
 *   • Suggested-prompt chips from the persona — clicking fills the composer.
 *   • Tools grouped by service in an Accordion; each row shows name + what it
 *     does (description) + "when to use" (whenToUse, falls back to description)
 *     + a "reads context" chip, with a guided Run dialog (no raw JSON args).
 *
 * Every Run wires to the real /api/copilot/tools/[name]/invoke route.
 */

import { useCallback, useState } from 'react';
import {
  Body1, Caption1, Subtitle2, Badge, Button, Textarea, Tooltip,
  Accordion, AccordionHeader, AccordionItem, AccordionPanel,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Field, Input, Dropdown, Option, Switch,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Wrench20Regular, Sparkle16Regular, DocumentText16Regular,
} from '@fluentui/react-icons';
import { getPanePersona } from '@/lib/azure/copilot-personas';
import type { Tool } from './types';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0, height: '100%' },
  scroll: { flex: 1, overflow: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  personaCard: {
    background: 'linear-gradient(135deg, rgba(124,58,237,0.12), rgba(0,120,212,0.08))',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingVerticalM,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    flexShrink: 0,
  },
  personaHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  chipRow: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXS },
  promptChip: {
    fontSize: tokens.fontSizeBase200,
    height: 'auto',
    minHeight: '26px',
    padding: '3px 10px',
    borderRadius: tokens.borderRadiusCircular,
    whiteSpace: 'normal',
    textAlign: 'left',
    justifyContent: 'flex-start',
  },
  sectionLabel: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexShrink: 0 },
  toolRow: {
    display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-start',
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    marginBottom: tokens.spacingVerticalXS,
  },
  toolText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
  toolName: { fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold, fontFamily: 'var(--loom-font-mono, ui-monospace, Menlo, Consolas, monospace)' },
  toolDesc: { color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200, lineHeight: tokens.lineHeightBase200 },
  toolWhen: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase100 },
});

/**
 * Guided argument form from a tool's JSON-Schema `parameters` (no JSON typing —
 * loom_no_freeform_config). enum→Dropdown, boolean→Switch, number→number Input,
 * object/array→key=value lines, string→Input.
 */
function SchemaArgForm({ schema, value, onChange }: { schema: any; value: Record<string, any>; onChange: (v: Record<string, any>) => void }) {
  const props: Record<string, any> = schema?.properties || {};
  const required: string[] = Array.isArray(schema?.required) ? schema.required : [];
  const keys = Object.keys(props);
  if (keys.length === 0) {
    return <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>This tool takes no parameters — just run it.</Caption1>;
  }
  const set = (k: string, v: any) => onChange({ ...value, [k]: v });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalM }}>
      {keys.map((k) => {
        const p = props[k] || {};
        const label = `${k}${required.includes(k) ? ' *' : ''}`;
        const hint = p.description as string | undefined;
        const enumVals: any[] | undefined = Array.isArray(p.enum) ? p.enum : undefined;
        if (enumVals) {
          const cur = value[k] != null ? String(value[k]) : '';
          return (
            <Field key={k} label={label} hint={hint}>
              <Dropdown placeholder={`Select ${k}`} selectedOptions={cur ? [cur] : []} value={cur}
                onOptionSelect={(_e, d) => set(k, d.optionValue)}>
                {enumVals.map((o) => <Option key={String(o)} value={String(o)}>{String(o)}</Option>)}
              </Dropdown>
            </Field>
          );
        }
        if (p.type === 'boolean') {
          return (
            <Field key={k} label={label} hint={hint}>
              <Switch checked={!!value[k]} onChange={(_e, d) => set(k, d.checked)} />
            </Field>
          );
        }
        if (p.type === 'number' || p.type === 'integer') {
          return (
            <Field key={k} label={label} hint={hint}>
              <Input type="number" value={value[k] != null ? String(value[k]) : ''}
                onChange={(_e, d) => set(k, d.value === '' ? undefined : Number(d.value))} />
            </Field>
          );
        }
        if (p.type === 'object' || p.type === 'array') {
          return (
            <Field key={k} label={`${label} (one key=value per line)`} hint={hint}>
              <Textarea rows={3}
                value={typeof value[`__kv_${k}`] === 'string' ? value[`__kv_${k}`] : ''}
                onChange={(_e, d) => {
                  const obj: Record<string, string> = {};
                  for (const line of d.value.split('\n')) {
                    const i = line.indexOf('=');
                    if (i > 0) obj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
                  }
                  onChange({ ...value, [`__kv_${k}`]: d.value, [k]: p.type === 'array' ? Object.values(obj) : obj });
                }} />
            </Field>
          );
        }
        return (
          <Field key={k} label={label} hint={hint}>
            <Input value={value[k] != null ? String(value[k]) : ''} onChange={(_e, d) => set(k, d.value)} />
          </Field>
        );
      })}
    </div>
  );
}

function ToolRow({ tool }: { tool: Tool }) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [argv, setArgv] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const invoke = useCallback(async () => {
    const parsed: Record<string, any> = {};
    for (const [k, v] of Object.entries(argv)) {
      if (k.startsWith('__kv_')) continue;
      if (v === undefined || v === '') continue;
      parsed[k] = v;
    }
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await fetch(`/api/copilot/tools/${encodeURIComponent(tool.name)}/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: parsed }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (j.ok) setResult(j);
      else setError(j.remediation ? `${j.error}\n\nRemediation: ${j.remediation}` : (j.error || `HTTP ${r.status}`));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [tool.name, argv]);

  const whenToUse = tool.whenToUse || tool.description;

  return (
    <>
      <div className={s.toolRow}>
        <div className={s.toolText}>
          <span className={s.toolName}>{tool.name}</span>
          <span className={s.toolDesc}>{tool.description}</span>
          {tool.whenToUse && <span className={s.toolWhen}>When to use: {tool.whenToUse}</span>}
          {tool.readsContext && (
            <Badge size="small" appearance="tint" color="informative" icon={<DocumentText16Regular />}>
              reads active context
            </Badge>
          )}
        </div>
        <Button size="small" appearance="subtle" onClick={() => setOpen(true)} aria-label={`Run ${tool.name}`}>Run</Button>
      </div>
      <Dialog open={open} onOpenChange={(_e, d) => setOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 640 }}>
          <DialogBody>
            <DialogTitle>{tool.name}</DialogTitle>
            <DialogContent>
              <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalSNudge }}>{tool.description}</Caption1>
              <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalM, color: tokens.colorNeutralForeground3 }}>When to use: {whenToUse}</Caption1>
              <SchemaArgForm schema={tool.parameters} value={argv} onChange={setArgv} />
              <Button appearance="subtle" size="small" style={{ marginTop: tokens.spacingVerticalS }} onClick={() => setArgv({})}>Reset inputs</Button>
              {error && (
                <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
                  <MessageBarBody style={{ whiteSpace: 'pre-wrap' }}>{error}</MessageBarBody>
                </MessageBar>
              )}
              {result && (
                <MessageBar intent="success" style={{ marginTop: tokens.spacingVerticalM }}>
                  <MessageBarBody>
                    <MessageBarTitle>OK — {result.durationMs}ms</MessageBarTitle>
                    <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto', fontSize: tokens.fontSizeBase100, margin: tokens.spacingVerticalNone }}>
                      {JSON.stringify(result.result, null, 2)}
                    </pre>
                  </MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)}>Close</Button>
              <Button appearance="primary" onClick={invoke} disabled={busy}>
                {busy ? 'Running…' : 'Invoke'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

export interface ToolsPanelProps {
  contextSlug?: string;
  tools: Record<string, Tool[]>;
  toolCount: number;
  ready?: boolean;
  deployment?: string;
  /** True when the active editor context (query/schema) is attached. */
  hasContext?: boolean;
  /** Fill the composer with a suggested prompt (does not auto-send). */
  onSuggestedPrompt: (prompt: string) => void;
}

export function ToolsPanel(props: ToolsPanelProps) {
  const s = useStyles();
  const persona = getPanePersona(props.contextSlug);
  const services = Object.keys(props.tools).sort();

  return (
    <div className={s.root}>
      {/* Active persona */}
      <div className={s.personaCard}>
        <div className={s.personaHead}>
          <Sparkle16Regular style={{ color: tokens.colorBrandForeground1 }} />
          <Subtitle2>{persona.title}</Subtitle2>
        </div>
        <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>{persona.greeting}</Caption1>
        <div className={s.chipRow}>
          {props.ready ? (
            <Badge appearance="tint" color="success">Ready{props.deployment ? ` · ${props.deployment}` : ''}</Badge>
          ) : (
            <Badge appearance="tint" color="warning">Tools callable directly</Badge>
          )}
          <Badge appearance="tint" color="brand">{props.toolCount} tools</Badge>
          {props.hasContext && <Badge appearance="tint" color="informative">grounded on open editor</Badge>}
        </div>
      </div>

      <div className={s.scroll}>
        {/* Suggested prompts */}
        {persona.suggestedPrompts.length > 0 && (
          <div>
            <Caption1 className={s.sectionLabel}><Sparkle16Regular /> Suggested prompts</Caption1>
            <div className={s.chipRow}>
              {persona.suggestedPrompts.map((p) => (
                <Button
                  key={p}
                  className={s.promptChip}
                  appearance="outline"
                  size="small"
                  onClick={() => props.onSuggestedPrompt(p)}
                >
                  {p}
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* Tools */}
        <div>
          <Caption1 className={s.sectionLabel}><Wrench20Regular fontSize={16} /> Tools ({props.toolCount})</Caption1>
          {services.length === 0 ? (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No tools registered in this deployment.</Caption1>
          ) : (
            <Accordion multiple collapsible>
              {services.map((svc) => (
                <AccordionItem key={svc} value={svc}>
                  <AccordionHeader>{svc} ({props.tools[svc].length})</AccordionHeader>
                  <AccordionPanel>
                    {props.tools[svc].map((t) => <ToolRow key={t.name} tool={t} />)}
                  </AccordionPanel>
                </AccordionItem>
              ))}
            </Accordion>
          )}
        </div>
      </div>
    </div>
  );
}
