'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * AipLogicEditor (AIP-Logic → Spindle) — no-code typed LLM function with a block graph.
 *
 * Extracted verbatim from palantir-editors.tsx (behavior-preserving split —
 * zero logic change). Shared helpers/types/styles live in ./shared.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import {
  Title2, Subtitle2, Body1, Caption1, Badge, Button, Input, Textarea, Spinner, Switch, Divider,
  Tab, TabList, Field, Dropdown, Option, Checkbox, SearchBox,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Dismiss16Regular, Link20Regular, Code20Regular,
  Flash20Regular, Rocket20Regular, Play20Regular, Database20Regular,
  Copy16Regular, Checkmark16Regular, BrainCircuit20Regular,
  History20Regular, Bug20Regular,
  ArrowSwap20Regular, People20Regular, Tag20Regular, ChevronRight20Regular,
  CheckmarkCircle20Regular, DismissCircle20Regular, Cloud20Regular, Branch20Regular,
  Settings20Regular, Warning20Regular, Pulse20Regular, Alert20Regular,
  ArrowUp16Regular, ArrowDown16Regular, Wrench20Regular, Braces20Regular,
  Clock20Regular, DataHistogram20Regular, TextField20Regular, Beaker20Regular,
  Globe20Regular, CloudArrowUp20Regular, Open20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from '../item-editor-chrome';
import { NewItemCreateGate } from '../new-item-gate';
import { SlateAppBuilder, type SlateQueryDef, type SlateWidgetDef, type SlateVariable } from '../slate/slate-app-builder';
import { WorkshopAppBuilder, type WorkshopWidget, type WorkshopVariable } from '../workshop/workshop-app-builder';
import { deriveObjectProperties } from '../_palantir-codegen';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import {
  CHECK_TYPE_LIBRARY, CHECK_FAMILY_META, COMPARISON_OPERATORS, AGGREGATIONS,
  buildCheckQuery, type CheckTypeDef, type CheckFamily, type CheckField,
} from '@/app/api/items/health-check/_lib/check-types';
import type { OntologyEntityBinding } from '../_family-utils';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { useStyles, CodeBlock, useItemState, SaveStrip, SectionHead, useOntologyBinding, type ItemDoc, type OntologySummary, type OntologyClassLite, type OntologyActionLite, type OntologySurface } from './shared';

// ───────────────────────── AIP Logic function (Spindle Studio) ─────────────────────────
// AIP Logic typed-input system (Palantir parity): full type set, with object*
// types bound to a Weave ontology entity type. Values are coerced client-side
// before they hit the real Azure OpenAI invoke route.
const AIP_INPUT_TYPES = [
  'string', 'integer', 'long', 'double', 'float', 'boolean', 'date', 'timestamp',
  'array', 'struct', 'object', 'object list', 'object set', 'model', 'media reference',
] as const;
const AIP_NUMERIC = new Set(['integer', 'long', 'double', 'float', 'number']);
const AIP_OBJECT = new Set(['object', 'object list', 'object set']);
const AIP_JSON = new Set(['array', 'struct']);
function coerceAipValue(type: string, raw: string): unknown {
  if (AIP_NUMERIC.has(type)) return raw.trim() === '' ? null : Number(raw);
  if (type === 'boolean') return /^(true|1|yes|on)$/i.test(raw.trim());
  if (AIP_JSON.has(type)) { try { return raw.trim() ? JSON.parse(raw) : (type === 'array' ? [] : {}); } catch { return raw; } }
  return raw;
}
interface RunStepLite {
  kind?: string; type?: string; name?: string; callId?: string; content?: string; error?: string;
  result?: unknown; status?: string; elapsedMs?: number; prompt?: string; model?: string;
  // typed-block-graph debugger fields
  output?: string; outputType?: string; gate?: { reason?: string; remediation?: string }; tools?: unknown[];
}
function trimStep(st: RunStepLite): RunStepLite {
  const { kind, type, name, callId, content, error, status, elapsedMs, output, outputType, gate, prompt } = st;
  return {
    kind, type, name, callId, error, status, elapsedMs, output, outputType, gate,
    content: typeof content === 'string' ? content.slice(0, 600) : content,
    prompt: typeof prompt === 'string' ? prompt.slice(0, 600) : prompt,
  };
}
interface AipInputDef { id: string; name: string; type: string; objectType?: string; description?: string; required?: boolean }

// ── Typed BLOCK GRAPH model (Palantir AIP Logic parity) ──
// Each block is configured by dropdowns / typed inputs (no freeform JSON) and
// emits a NAMED, typed output variable that later blocks reference by name.
type AipBlockKind =
  | 'create-variable' | 'get-object-property' | 'use-llm'
  | 'execute-function' | 'transform' | 'branch';
type AipBlockType = 'string' | 'number' | 'boolean' | 'object' | 'array';
type AipToolKind = 'apply-action' | 'ontology-function' | 'execute-function';

interface AipToolBinding {
  id: string;
  kind: AipToolKind;
  // apply-action
  actionName?: string;
  actionKind?: 'create' | 'update' | 'delete';
  objectType?: string;
  keyColumn?: string;
  keyRef?: string;
  valueRefs?: Record<string, string>;
  commit?: boolean;
  // ontology-function
  property?: string;
  // execute-function (tool)
  functionItemId?: string;
  functionName?: string;
  argRefs?: Record<string, string>;
}

interface AipBlockDef {
  id: string;
  kind: AipBlockKind;
  name: string;
  output: string;          // NAMED typed output variable (identifier)
  outputType: AipBlockType;
  valueExpr?: string;                              // create-variable
  objectType?: string; property?: string;          // get-object-property
  keyColumn?: string; keyRef?: string;
  prompt?: string; tools?: AipToolBinding[];        // use-llm
  functionItemId?: string; functionName?: string;   // execute-function
  argRefs?: Record<string, string>;
  sourceRef?: string; transformOp?: string; transformExpr?: string; // transform
  conditionRef?: string; operator?: string; compareValue?: string;  // branch
  thenRef?: string; elseRef?: string;
}

const AIP_BLOCK_TYPES: AipBlockType[] = ['string', 'number', 'boolean', 'object', 'array'];
const AIP_TRANSFORM_OPS = ['template', 'uppercase', 'lowercase', 'trim', 'length', 'to-number', 'to-string', 'json-parse', 'json-stringify'] as const;
const AIP_BRANCH_OPS = ['truthy', 'empty', 'eq', 'ne', 'gt', 'lt', 'contains'] as const;

interface BlockKindMeta { label: string; icon: ReactNode; hint: string }
const AIP_BLOCK_META: Record<AipBlockKind, BlockKindMeta> = {
  'create-variable': { label: 'Create variable', icon: <Braces20Regular />, hint: 'A typed local variable from a literal or a {ref} template.' },
  'get-object-property': { label: 'Get object property', icon: <Database20Regular />, hint: 'Read one property off an ontology object (real Synapse read).' },
  'use-llm': { label: 'Use LLM', icon: <BrainCircuit20Regular />, hint: 'One grounded Azure OpenAI turn; can call Apply-action / Ontology-function / Execute-function tools.' },
  'execute-function': { label: 'Execute function', icon: <Code20Regular />, hint: 'Invoke a sibling Spindle function with resolved args.' },
  'transform': { label: 'Transform', icon: <ArrowSwap20Regular />, hint: 'Map / derive a value from a prior output.' },
  'branch': { label: 'Branch', icon: <Branch20Regular />, hint: 'Conditional (ternary) over a prior output.' },
};

/** Default output identifier for a new block of a kind (out1, out2, …). */
function nextOutputName(kind: AipBlockKind, blocks: AipBlockDef[]): string {
  const stems: Record<AipBlockKind, string> = {
    'create-variable': 'var', 'get-object-property': 'prop', 'use-llm': 'answer',
    'execute-function': 'result', 'transform': 'value', 'branch': 'choice',
  };
  const stem = stems[kind];
  let n = 1;
  const taken = new Set(blocks.map((b) => b.output));
  while (taken.has(`${stem}${n}`)) n += 1;
  return `${stem}${n}`;
}

interface AipUsageLite { promptTokens?: number; completionTokens?: number; totalTokens?: number; [k: string]: unknown }
interface AipRunRecord {
  id: string; ts: string; mode: 'logic' | 'agent'; model?: string;
  inputs?: Record<string, unknown>; output?: string; sources?: string[];
  steps?: RunStepLite[]; usage?: AipUsageLite; ok: boolean;
}
interface AipState {
  inputs?: AipInputDef[]; blocks?: AipBlockDef[]; steps?: unknown[]; outputType?: string; outputDescription?: string;
  boundOntologyId?: string; boundOntologyName?: string; ontologyEntityTypes?: string[];
  foundryAgentId?: string; foundryModel?: string; lastDeployedAt?: string;
  runs?: AipRunRecord[];
  [k: string]: unknown;
}

const AIP_TOOL_LABEL: Record<AipToolKind, string> = {
  'apply-action': 'Apply action', 'ontology-function': 'Ontology function', 'execute-function': 'Execute function',
};
type PropLite = { name: string; isKey?: boolean };

/** Pick a reference to a prior output (typed input or an earlier block's output). */
function RefPicker({ label, value, refs, onSet, className, allowEmpty = true, placeholder }: {
  label: string; value?: string; refs: string[]; onSet: (v: string) => void; className?: string; allowEmpty?: boolean; placeholder?: string;
}) {
  return (
    <Field label={label} className={className}>
      <Dropdown value={value || ''} selectedOptions={value ? [value] : []} placeholder={placeholder || 'Pick a variable'} onOptionSelect={(_, d) => onSet(String(d.optionValue || ''))}>
        {allowEmpty && <Option value="">(none)</Option>}
        {refs.map((r) => <Option key={r} value={r}>{r}</Option>)}
      </Dropdown>
    </Field>
  );
}

/** Edit a map of key → variable-ref (apply-action column values, execute-function args). */
function KeyRefEditor({ title, map, refs, onChange, keyPlaceholder, suggestions }: {
  title: string; map: Record<string, string> | undefined; refs: string[];
  onChange: (next: Record<string, string>) => void; keyPlaceholder: string; suggestions?: string[];
}) {
  const s = useStyles();
  const [newKey, setNewKey] = useState('');
  const entries = Object.entries(map || {});
  const setRef = (k: string, v: string) => onChange({ ...(map || {}), [k]: v });
  const removeKey = (k: string) => { const nx = { ...(map || {}) }; delete nx[k]; onChange(nx); };
  const addKey = (k: string) => { const key = k.trim(); if (!key || (map || {})[key] !== undefined) return; onChange({ ...(map || {}), [key]: '' }); setNewKey(''); };
  return (
    <div className={s.blockBody}>
      <Caption1 className={s.hint}>{title}</Caption1>
      {entries.map(([k, v]) => (
        <div key={k} className={s.row}>
          <Badge appearance="tint" color="brand">{k}</Badge>
          <span className={s.spacer} />
          <RefPicker label="from" value={v} refs={refs} onSet={(nv) => setRef(k, nv)} className={s.fieldNarrow} />
          <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${k}`} onClick={() => removeKey(k)} />
        </div>
      ))}
      <div className={s.addBar}>
        {suggestions && suggestions.length ? (
          <Field label="Column" className={s.fieldMed}>
            <Dropdown value={newKey} selectedOptions={newKey ? [newKey] : []} placeholder="Pick a column" onOptionSelect={(_, d) => setNewKey(String(d.optionValue || ''))}>
              {suggestions.map((c) => <Option key={c} value={c}>{c}</Option>)}
            </Dropdown>
          </Field>
        ) : (
          <Field label="Name" className={s.fieldMed}><Input value={newKey} onChange={(_, d) => setNewKey(d.value)} placeholder={keyPlaceholder} /></Field>
        )}
        <Button size="small" appearance="secondary" icon={<Add20Regular />} disabled={!newKey.trim()} onClick={() => addKey(newKey)}>Add</Button>
      </div>
    </div>
  );
}

/** Configure one Use-LLM tool binding (all three wire to real Azure-native backends). */
function AipToolEditor({ tool, refs, entityTypes, propsByType, actionTypes, siblingFns, onChange, onRemove }: {
  tool: AipToolBinding; refs: string[]; entityTypes: string[]; propsByType: Record<string, PropLite[]>;
  actionTypes: OntologyActionLite[]; siblingFns: { id: string; displayName: string }[];
  onChange: (next: AipToolBinding) => void; onRemove: () => void;
}) {
  const s = useStyles();
  const setT = (patch: Partial<AipToolBinding>) => onChange({ ...tool, ...patch });
  const props = tool.objectType ? (propsByType[tool.objectType] || []) : [];
  return (
    <div className={s.toolCard}>
      <div className={s.blockCardHead}>
        <Wrench20Regular />
        <Field label="Tool" className={s.fieldMed}>
          <Dropdown value={AIP_TOOL_LABEL[tool.kind]} selectedOptions={[tool.kind]} onOptionSelect={(_, d) => setT({ kind: (d.optionValue as AipToolKind) || 'apply-action' })}>
            <Option value="apply-action">Apply action</Option>
            <Option value="ontology-function">Ontology function</Option>
            <Option value="execute-function">Execute function</Option>
          </Dropdown>
        </Field>
        <span className={s.spacer} />
        <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove tool" onClick={onRemove} />
      </div>
      {tool.kind === 'apply-action' && (
        <div className={s.blockBody}>
          <div className={s.blockGrid}>
            <Field label="Action">
              <Dropdown value={tool.actionName || ''} selectedOptions={tool.actionName ? [tool.actionName] : []} placeholder={actionTypes.length ? 'Pick an Action' : 'No Actions on the ontology'} disabled={!actionTypes.length}
                onOptionSelect={(_, d) => { const a = actionTypes.find((x) => x.name === String(d.optionValue)); setT({ actionName: a?.name, objectType: a?.objectType, actionKind: a?.kind, valueRefs: a?.params ? Object.fromEntries((a.params || []).map((p) => [p, (tool.valueRefs || {})[p] || ''])) : tool.valueRefs }); }}>
                {actionTypes.map((a) => <Option key={a.name} value={a.name} text={`${a.name} (${a.kind} ${a.objectType})`}>{a.name} ({a.kind} {a.objectType})</Option>)}
              </Dropdown>
            </Field>
            {(tool.actionKind === 'update' || tool.actionKind === 'delete') && (
              <RefPicker label="Key from" value={tool.keyRef} refs={refs} onSet={(v) => setT({ keyRef: v })} />
            )}
            {(tool.actionKind === 'update' || tool.actionKind === 'delete') && (
              <Field label="Key column (optional)"><Input value={tool.keyColumn || ''} onChange={(_, d) => setT({ keyColumn: d.value })} placeholder="from ontology binding" /></Field>
            )}
          </div>
          {(tool.actionKind === 'create' || tool.actionKind === 'update') && (
            <KeyRefEditor title="Column values (from prior outputs)" map={tool.valueRefs} refs={refs} onChange={(m) => setT({ valueRefs: m })} keyPlaceholder="column" suggestions={props.map((p) => p.name)} />
          )}
          <Switch checked={!!tool.commit} onChange={(_, d) => setT({ commit: !!d.checked })} label={tool.commit ? 'Commit writes to Synapse (real CRUD)' : 'Propose only (show the real SQL, do not write)'} />
        </div>
      )}
      {tool.kind === 'ontology-function' && (
        <div className={s.blockGrid}>
          <Field label="Object type">
            <Dropdown value={tool.objectType || ''} selectedOptions={tool.objectType ? [tool.objectType] : []} placeholder={entityTypes.length ? 'Pick a type' : 'Bind an ontology'} disabled={!entityTypes.length} onOptionSelect={(_, d) => setT({ objectType: String(d.optionValue || ''), property: '' })}>
              {entityTypes.map((t) => <Option key={t} value={t}>{t}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Property">
            <Dropdown value={tool.property || ''} selectedOptions={tool.property ? [tool.property] : []} placeholder="Pick a property" disabled={!tool.objectType} onOptionSelect={(_, d) => setT({ property: String(d.optionValue || '') })}>
              {props.map((p) => <Option key={p.name} value={p.name} text={p.isKey ? `${p.name} (key)` : p.name}>{p.name}{p.isKey ? ' (key)' : ''}</Option>)}
            </Dropdown>
          </Field>
          <RefPicker label="Key from" value={tool.keyRef} refs={refs} onSet={(v) => setT({ keyRef: v })} />
        </div>
      )}
      {tool.kind === 'execute-function' && (
        <div className={s.blockBody}>
          <Field label="Function">
            <Dropdown value={tool.functionName || ''} selectedOptions={tool.functionItemId ? [tool.functionItemId] : []} placeholder={siblingFns.length ? 'Pick a function' : 'No sibling functions'} disabled={!siblingFns.length}
              onOptionSelect={(_, d) => { const f = siblingFns.find((x) => x.id === String(d.optionValue)); setT({ functionItemId: f?.id, functionName: f?.displayName }); }}>
              {siblingFns.map((f) => <Option key={f.id} value={f.id}>{f.displayName}</Option>)}
            </Dropdown>
          </Field>
          <KeyRefEditor title="Arguments (sibling input → prior output)" map={tool.argRefs} refs={refs} onChange={(m) => setT({ argRefs: m })} keyPlaceholder="input name" />
        </div>
      )}
    </div>
  );
}

/** One typed block in the graph — kind-specific dropdown config + named typed output. */
function AipBlockCard({ block, index, total, priorRefs, entityTypes, propsByType, actionTypes, siblingFns, onChange, onRemove, onMove }: {
  block: AipBlockDef; index: number; total: number; priorRefs: string[];
  entityTypes: string[]; propsByType: Record<string, PropLite[]>; actionTypes: OntologyActionLite[];
  siblingFns: { id: string; displayName: string }[];
  onChange: (patch: Partial<AipBlockDef>) => void; onRemove: () => void; onMove: (dir: -1 | 1) => void;
}) {
  const s = useStyles();
  const meta = AIP_BLOCK_META[block.kind];
  const setB = (patch: Partial<AipBlockDef>) => onChange(patch);
  const tools = Array.isArray(block.tools) ? block.tools : [];
  const props = block.objectType ? (propsByType[block.objectType] || []) : [];
  return (
    <div className={s.blockCard}>
      <div className={s.blockCardHead}>
        <Badge appearance="filled" color="brand">{index + 1}</Badge>
        <span className={s.blockIcon}>{meta.icon}</span>
        <Field label="Block name" className={s.fieldMed}><Input value={block.name} onChange={(_, d) => setB({ name: d.value })} /></Field>
        <span className={s.spacer} />
        <Field label="Output var" className={s.fieldNarrow}><Input value={block.output} onChange={(_, d) => setB({ output: d.value.replace(/[^A-Za-z0-9_]/g, '') })} /></Field>
        <Field label="Type" className={s.fieldNarrow}>
          <Dropdown value={block.outputType} selectedOptions={[block.outputType]} onOptionSelect={(_, d) => setB({ outputType: (d.optionValue as AipBlockType) || 'string' })}>
            {AIP_BLOCK_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
          </Dropdown>
        </Field>
        <Button size="small" appearance="subtle" icon={<ArrowUp16Regular />} aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)} />
        <Button size="small" appearance="subtle" icon={<ArrowDown16Regular />} aria-label="Move down" disabled={index === total - 1} onClick={() => onMove(1)} />
        <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove block" onClick={onRemove} />
      </div>
      <Caption1 className={s.hint}>{meta.hint}</Caption1>

      {block.kind === 'create-variable' && (
        <Field label="Value / template" hint="A literal, or use {ref} to interpolate a prior output.">
          <Input value={block.valueExpr || ''} onChange={(_, d) => setB({ valueExpr: d.value })} placeholder="e.g. High, or {answer1}" />
        </Field>
      )}

      {block.kind === 'get-object-property' && (
        <div className={s.blockGrid}>
          <Field label="Object type">
            <Dropdown value={block.objectType || ''} selectedOptions={block.objectType ? [block.objectType] : []} placeholder={entityTypes.length ? 'Pick a type' : 'Bind an ontology'} disabled={!entityTypes.length} onOptionSelect={(_, d) => setB({ objectType: String(d.optionValue || ''), property: '' })}>
              {entityTypes.map((t) => <Option key={t} value={t}>{t}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Property">
            <Dropdown value={block.property || ''} selectedOptions={block.property ? [block.property] : []} placeholder="Pick a property" disabled={!block.objectType} onOptionSelect={(_, d) => setB({ property: String(d.optionValue || '') })}>
              {props.map((p) => <Option key={p.name} value={p.name} text={p.isKey ? `${p.name} (key)` : p.name}>{p.name}{p.isKey ? ' (key)' : ''}</Option>)}
            </Dropdown>
          </Field>
          <RefPicker label="Key from" value={block.keyRef} refs={priorRefs} onSet={(v) => setB({ keyRef: v })} />
          <Field label="Key column (optional)"><Input value={block.keyColumn || ''} onChange={(_, d) => setB({ keyColumn: d.value })} placeholder="from ontology binding" /></Field>
        </div>
      )}

      {block.kind === 'use-llm' && (
        <div className={s.blockBody}>
          <Field label="Prompt" hint="{ref} interpolates a prior output.">
            <Textarea value={block.prompt || ''} onChange={(_, d) => setB({ prompt: d.value })} resize="vertical" placeholder="Assess {customer} risk using the tool results." />
          </Field>
          <div className={s.blockCardHead}>
            <Wrench20Regular />
            <Subtitle2>Tools</Subtitle2>
            <span className={s.spacer} />
            <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={() => onChange({ tools: [...tools, { id: `tool_${Date.now()}`, kind: 'apply-action' }] })}>Add tool</Button>
          </div>
          <Caption1 className={s.hint}>Apply-action (real Synapse CRUD) · Ontology-function (real Synapse read) · Execute-function (sibling invoke) — each runs and is fed into this turn.</Caption1>
          {tools.map((t) => (
            <AipToolEditor key={t.id} tool={t} refs={priorRefs} entityTypes={entityTypes} propsByType={propsByType} actionTypes={actionTypes} siblingFns={siblingFns}
              onChange={(nx) => onChange({ tools: tools.map((x) => x.id === t.id ? nx : x) })} onRemove={() => onChange({ tools: tools.filter((x) => x.id !== t.id) })} />
          ))}
        </div>
      )}

      {block.kind === 'execute-function' && (
        <div className={s.blockBody}>
          <Field label="Function">
            <Dropdown value={block.functionName || ''} selectedOptions={block.functionItemId ? [block.functionItemId] : []} placeholder={siblingFns.length ? 'Pick a function' : 'No sibling functions'} disabled={!siblingFns.length}
              onOptionSelect={(_, d) => { const f = siblingFns.find((x) => x.id === String(d.optionValue)); setB({ functionItemId: f?.id, functionName: f?.displayName }); }}>
              {siblingFns.map((f) => <Option key={f.id} value={f.id}>{f.displayName}</Option>)}
            </Dropdown>
          </Field>
          <KeyRefEditor title="Arguments (sibling input → prior output)" map={block.argRefs} refs={priorRefs} onChange={(m) => setB({ argRefs: m })} keyPlaceholder="input name" />
        </div>
      )}

      {block.kind === 'transform' && (
        <div className={s.blockGrid}>
          <RefPicker label="Source" value={block.sourceRef} refs={priorRefs} onSet={(v) => setB({ sourceRef: v })} allowEmpty={false} />
          <Field label="Operation">
            <Dropdown value={block.transformOp || 'template'} selectedOptions={[block.transformOp || 'template']} onOptionSelect={(_, d) => setB({ transformOp: String(d.optionValue || 'template') })}>
              {AIP_TRANSFORM_OPS.map((o) => <Option key={o} value={o}>{o}</Option>)}
            </Dropdown>
          </Field>
          {(block.transformOp === 'template' || !block.transformOp) && (
            <Field label="Template" hint="{ref} interpolation"><Input value={block.transformExpr || ''} onChange={(_, d) => setB({ transformExpr: d.value })} placeholder="Risk for {customer}: {score}" /></Field>
          )}
        </div>
      )}

      {block.kind === 'branch' && (
        <div className={s.blockGrid}>
          <RefPicker label="Condition from" value={block.conditionRef} refs={priorRefs} onSet={(v) => setB({ conditionRef: v })} allowEmpty={false} />
          <Field label="Operator">
            <Dropdown value={block.operator || 'truthy'} selectedOptions={[block.operator || 'truthy']} onOptionSelect={(_, d) => setB({ operator: String(d.optionValue || 'truthy') })}>
              {AIP_BRANCH_OPS.map((o) => <Option key={o} value={o}>{o}</Option>)}
            </Dropdown>
          </Field>
          {['eq', 'ne', 'gt', 'lt', 'contains'].includes(block.operator || '') && (
            <Field label="Compare value"><Input value={block.compareValue || ''} onChange={(_, d) => setB({ compareValue: d.value })} /></Field>
          )}
          <RefPicker label="Then (optional)" value={block.thenRef} refs={priorRefs} onSet={(v) => setB({ thenRef: v })} />
          <RefPicker label="Else (optional)" value={block.elseRef} refs={priorRefs} onSet={(v) => setB({ elseRef: v })} />
        </div>
      )}
    </div>
  );
}

export function AipLogicEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<AipState>('aip-logic', id, { inputs: [], blocks: [], outputType: 'string' });
  const [inName, setInName] = useState('');
  const [inType, setInType] = useState<string>('string');
  const [inObjType, setInObjType] = useState('');
  const [inDesc, setInDesc] = useState('');
  const [inReq, setInReq] = useState(false);
  const [addBlockKind, setAddBlockKind] = useState<AipBlockKind>('use-llm');
  const [invokeVals, setInvokeVals] = useState<Record<string, string>>({});
  const [invokeBusy, setInvokeBusy] = useState(false);
  const [invokeOut, setInvokeOut] = useState<string | null>(null);
  const [invokeMsg, setInvokeMsg] = useState<{ intent: 'error' | 'warning'; text: string } | null>(null);
  const [agentMode, setAgentMode] = useState(false);
  const [runSteps, setRunSteps] = useState<RunStepLite[]>([]);
  const [sourcesUsed, setSourcesUsed] = useState<string[]>([]);
  const [siblingFns, setSiblingFns] = useState<{ id: string; displayName: string }[]>([]);

  // Ontology binding (Spindle grounds on the Weave) — shared hook for parity with
  // Workshop / SDK editors. Avoids divergent local grounding logic.
  const onto = useOntologyBinding('aip-logic', id);

  // Deploy / run-as-Foundry-agent.
  const [deployBusy, setDeployBusy] = useState(false);
  const [deployMsg, setDeployMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);

  const inputs = Array.isArray(state.inputs) ? state.inputs : [];
  const blocks = Array.isArray(state.blocks) ? state.blocks : [];
  const runs = Array.isArray(state.runs) ? state.runs : [];

  // Ontology surface → the dropdowns that make block config typed (no freeform):
  // entity types (get-object-property / apply-action), per-type properties, and
  // declared write-back Action types (apply-action tool).
  const surfaceClasses = onto.surface?.classes || [];
  const surfaceBindings = onto.surface?.bindings || [];
  const actionTypes: OntologyActionLite[] = onto.surface?.actionTypes || [];
  const propsByType = useMemo(
    () => deriveObjectProperties(surfaceClasses, surfaceBindings, actionTypes.map((a) => ({ name: a.name, objectType: a.objectType, kind: a.kind, params: a.params }))),
    [surfaceClasses, surfaceBindings, actionTypes],
  );
  const entityTypes = useMemo(() => (
    surfaceClasses.length ? surfaceClasses.map((c) => c.name) : (Array.isArray(state.ontologyEntityTypes) ? state.ontologyEntityTypes : [])
  ), [surfaceClasses, state.ontologyEntityTypes]);

  // Sibling Spindle functions (for Execute-function blocks / tools).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await clientFetch('/api/items/aip-logic');
        const j = await r.json().catch(() => ({}));
        if (alive && j?.ok && Array.isArray(j.items)) {
          setSiblingFns(j.items.filter((it: any) => it?.id && it.id !== id).map((it: any) => ({ id: it.id, displayName: it.displayName || it.id })));
        }
      } catch { /* surfaced when picking a function */ }
    })();
    return () => { alive = false; };
  }, [id]);

  // Mirror the hook's bound surface into persisted item state so Invoke / Deploy
  // can read boundOntologyId + ontologyEntityTypes from the saved doc.
  useEffect(() => {
    if (!onto.surface) return;
    setState((p) => {
      const et = onto.surface!.classes.map((c) => c.name);
      if (p.boundOntologyId === onto.surface!.id
        && p.boundOntologyName === onto.surface!.displayName
        && Array.isArray(p.ontologyEntityTypes)
        && p.ontologyEntityTypes.length === et.length
        && p.ontologyEntityTypes.every((t, i) => t === et[i])) return p;
      return { ...p, boundOntologyId: onto.surface!.id, boundOntologyName: onto.surface!.displayName, ontologyEntityTypes: et };
    });
  }, [onto.surface, setState]);

  const addInput = useCallback(() => {
    const nm = inName.trim(); if (!/^[A-Za-z_][\w]*$/.test(nm)) return;
    const def: AipInputDef = { id: `in_${Date.now()}`, name: nm, type: inType };
    if (AIP_OBJECT.has(inType) && inObjType) def.objectType = inObjType;
    if (inDesc.trim()) def.description = inDesc.trim();
    if (inReq) def.required = true;
    setState((p) => ({ ...p, inputs: [...(Array.isArray(p.inputs) ? p.inputs : []), def] }));
    setInName(''); setInDesc(''); setInReq(false);
  }, [inName, inType, inObjType, inDesc, inReq, setState]);
  const removeInput = useCallback((iid: string) => setState((p) => ({ ...p, inputs: (Array.isArray(p.inputs) ? p.inputs : []).filter((x) => x.id !== iid) })), [setState]);

  // Coerce the raw invoke-form strings into typed values per the input schema.
  const buildTyped = useCallback(() => {
    const typed: Record<string, unknown> = {};
    for (const i of inputs) typed[i.name] = coerceAipValue(i.type, invokeVals[i.name] ?? '');
    return typed;
  }, [inputs, invokeVals]);

  // Run history — persisted to Cosmos through the existing item PATCH (state.runs).
  const persistRun = useCallback((rec: AipRunRecord) => {
    const prev = Array.isArray(state.runs) ? state.runs : [];
    const ns: AipState = { ...state, runs: [rec, ...prev].slice(0, 12) };
    setState(() => ns);
    void save(ns);
  }, [state, setState, save]);
  const loadRun = useCallback((rec: AipRunRecord) => {
    setInvokeOut(rec.output ?? '');
    setRunSteps(Array.isArray(rec.steps) ? rec.steps : []);
    setSourcesUsed(Array.isArray(rec.sources) ? rec.sources : []);
    setAgentMode(rec.mode === 'agent');
    setInvokeMsg(null);
  }, []);

  // ── Typed BLOCK GRAPH mutators ──
  const addBlock = useCallback((kind: AipBlockKind) => {
    setState((p) => {
      const bl = Array.isArray(p.blocks) ? p.blocks : [];
      const b: AipBlockDef = {
        id: `blk_${Date.now()}`, kind, name: AIP_BLOCK_META[kind].label,
        output: nextOutputName(kind, bl), outputType: kind === 'branch' ? 'boolean' : 'string',
        ...(kind === 'use-llm' ? { tools: [] } : {}),
      };
      return { ...p, blocks: [...bl, b] };
    });
  }, [setState]);
  const updateBlock = useCallback((bid: string, patch: Partial<AipBlockDef>) => {
    setState((p) => ({ ...p, blocks: (Array.isArray(p.blocks) ? p.blocks : []).map((b) => b.id === bid ? { ...b, ...patch } : b) }));
  }, [setState]);
  const removeBlock = useCallback((bid: string) => {
    setState((p) => ({ ...p, blocks: (Array.isArray(p.blocks) ? p.blocks : []).filter((b) => b.id !== bid) }));
  }, [setState]);
  const moveBlock = useCallback((bid: string, dir: -1 | 1) => {
    setState((p) => {
      const bl = [...(Array.isArray(p.blocks) ? p.blocks : [])];
      const i = bl.findIndex((b) => b.id === bid); const j = i + dir;
      if (i < 0 || j < 0 || j >= bl.length) return p;
      [bl[i], bl[j]] = [bl[j], bl[i]];
      return { ...p, blocks: bl };
    });
  }, [setState]);

  const invoke = useCallback(async () => {
    setInvokeBusy(true); setInvokeMsg(null); setInvokeOut(null); setRunSteps([]); setSourcesUsed([]);
    const typed = buildTyped();
    try {
      // The invoke route reads the block graph from Cosmos — persist edits first.
      if (dirty) {
        const ok = await save();
        if (!ok) { setInvokeMsg({ intent: 'error', text: 'Could not save the block graph before running.' }); return; }
      }
      const r = await clientFetch(`/api/items/aip-logic/${encodeURIComponent(id)}/invoke`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: typed, mode: agentMode ? 'agent' : 'logic' }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : '';
        if (Array.isArray(j?.steps)) setRunSteps(j.steps);
        setInvokeMsg({ intent: j?.gate ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setInvokeOut(String(j.output ?? ''));
      if (Array.isArray(j?.steps)) setRunSteps(j.steps);
      if (Array.isArray(j?.sourcesUsed)) setSourcesUsed(j.sourcesUsed);
      persistRun({
        id: `run_${Date.now()}`, ts: new Date().toISOString(), mode: agentMode ? 'agent' : 'logic',
        model: j.model, inputs: typed, output: String(j.output ?? '').slice(0, 4000),
        sources: Array.isArray(j.sourcesUsed) ? j.sourcesUsed : undefined,
        steps: Array.isArray(j.steps) ? (j.steps as RunStepLite[]).slice(0, 30).map(trimStep) : undefined,
        usage: (j.usage && typeof j.usage === 'object') ? j.usage : undefined, ok: true,
      });
    } catch (e: any) { setInvokeMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setInvokeBusy(false); }
  }, [id, buildTyped, agentMode, persistRun, dirty, save]);

  const deploy = useCallback(async () => {
    setDeployBusy(true); setDeployMsg(null);
    try {
      const r = await clientFetch(`/api/items/aip-logic/${encodeURIComponent(id)}/deploy`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : j?.hint ? ` ${j.hint}` : '';
        setDeployMsg({ intent: j?.gate || j?.deferred ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setState((p) => ({ ...p, foundryAgentId: j.agentId, foundryModel: j.model, lastDeployedAt: j.lastDeployedAt }));
      setDeployMsg({ intent: 'success', text: `Published Foundry agent "${j.agentId}" (model ${j.model}).` });
    } catch (e: any) { setDeployMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setDeployBusy(false); }
  }, [id, setState]);

  const runDeployedAgent = useCallback(async () => {
    setInvokeBusy(true); setInvokeMsg(null); setInvokeOut(null); setRunSteps([]);
    const typed = buildTyped();
    try {
      const r = await clientFetch(`/api/items/aip-logic/${encodeURIComponent(id)}/run-agent`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inputs: typed }),
      });
      const j = await r.json().catch(() => ({}));
      if (Array.isArray(j?.steps)) setRunSteps(j.steps);
      if (!j?.ok) {
        const gate = j?.gate ? ` ${j.gate.remediation || ''}` : '';
        setInvokeMsg({ intent: j?.gate || j?.deferred ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${gate}` });
        return;
      }
      setInvokeOut(String(j.answer ?? ''));
      persistRun({
        id: `run_${Date.now()}`, ts: new Date().toISOString(), mode: 'agent',
        model: j.model || state.foundryModel, inputs: typed, output: String(j.answer ?? '').slice(0, 4000),
        steps: Array.isArray(j.steps) ? (j.steps as RunStepLite[]).slice(0, 30).map(trimStep) : undefined,
        usage: (j.usage && typeof j.usage === 'object') ? j.usage : undefined, ok: true,
      });
    } catch (e: any) { setInvokeMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setInvokeBusy(false); }
  }, [id, buildTyped, persistRun, state.foundryModel]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Function', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || !dirty },
        { label: invokeBusy ? 'Running…' : 'Invoke', onClick: invoke, disabled: invokeBusy || blocks.length === 0 },
      ]},
      { label: 'Publish', actions: [
        { label: deployBusy ? 'Deploying…' : 'Deploy as agent', onClick: deploy, disabled: deployBusy || blocks.length === 0 },
      ]},
    ]},
  ], [save, saving, dirty, invoke, invokeBusy, blocks.length, deploy, deployBusy]);

  if (id === 'new') return <NewItemCreateGate item={item} createLabel="Create Spindle logic / agent" intro="Spindle Studio — author a no-code typed AI function or agent: typed inputs → a TYPED BLOCK GRAPH (create-variable, get-object-property, use-LLM with tools, execute-function, transform, branch) → typed output, grounded on the Weave ontology and runnable against Azure OpenAI / Synapse. No Fabric required." />;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info"><MessageBarBody>
          <MessageBarTitle>Spindle Studio (Palantir AIP Logic / AIP equivalent)</MessageBarTitle>
          Author typed inputs and a TYPED BLOCK GRAPH (dropdowns, no freeform JSON) — each block emits a named, typed output that later blocks reference. Ground on a Weave ontology, then invoke as logic (the deterministic block engine) or as a tool-calling agent against the live Azure OpenAI deployment. Optionally publish as an Azure AI Foundry agent. No Microsoft Fabric required.
        </MessageBarBody></MessageBar>

        <div className={s.section}>
          <SectionHead icon={<Link20Regular />} title="Ontology grounding" hint="Bind a Weave ontology — Spindle runs against its entity types and Lakehouse/Warehouse data bindings." />
          {!onto.loaded ? <div className={s.empty}><Spinner size="tiny" /></div> : onto.ontologies.length === 0 ? (
            <MessageBar intent="warning"><MessageBarBody>No ontologies found. Create an Ontology item first, then bind it here to ground this function on the Weave.</MessageBarBody></MessageBar>
          ) : (
            <div className={s.addBar}>
              <Field label="Bound ontology" className={s.fieldWide}>
                <Dropdown
                  value={state.boundOntologyName || (onto.boundOntologyId ? '(bound)' : 'None — runs ungrounded')}
                  selectedOptions={[String(onto.boundOntologyId || state.boundOntologyId || '')]}
                  disabled={onto.busy}
                  onOptionSelect={(_, d) => onto.bind(String(d.optionValue || ''))}>
                  <Option value="">None — runs ungrounded</Option>
                  {onto.ontologies.map((o) => <Option key={o.id} value={o.id} text={o.displayName}>{o.displayName}{typeof o.classCount === 'number' ? ` (${o.classCount} types)` : ''}</Option>)}
                </Dropdown>
              </Field>
              {onto.busy && <Spinner size="tiny" />}
            </div>
          )}
          {Array.isArray(state.ontologyEntityTypes) && state.ontologyEntityTypes.length > 0 && (
            <div className={s.row}><Caption1 className={s.hint}>Entity types:</Caption1>{state.ontologyEntityTypes.slice(0, 12).map((t) => <Badge key={t} appearance="tint">{t}</Badge>)}</div>
          )}
          {onto.msg && <MessageBar intent={onto.msg.intent}><MessageBarBody>{onto.msg.text}</MessageBarBody></MessageBar>}
        </div>

        <div className={s.grid2}>
          <div className={s.section}>
            <SectionHead icon={<Add20Regular />} title="Typed inputs" hint="Named parameters with an AIP Logic type — object types bind to the Weave ontology." />
            <div className={s.addBar}>
              <Field label="Name"><Input value={inName} onChange={(_, d) => setInName(d.value)} placeholder="customerId" /></Field>
              <Field label="Type" className={s.fieldMed}><Dropdown value={inType} selectedOptions={[inType]} onOptionSelect={(_, d) => { const v = String(d.optionValue || 'string'); setInType(v); if (!AIP_OBJECT.has(v)) setInObjType(''); }}>
                {AIP_INPUT_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
              </Dropdown></Field>
              {AIP_OBJECT.has(inType) && (
                <Field label="Object type" className={s.fieldMed}>
                  <Dropdown
                    value={inObjType || (state.ontologyEntityTypes && state.ontologyEntityTypes.length ? 'Pick entity type' : 'Bind an ontology first')}
                    selectedOptions={[inObjType]}
                    disabled={!(state.ontologyEntityTypes && state.ontologyEntityTypes.length)}
                    onOptionSelect={(_, d) => setInObjType(String(d.optionValue || ''))}>
                    {(state.ontologyEntityTypes || []).map((t) => <Option key={t} value={t}>{t}</Option>)}
                  </Dropdown>
                </Field>
              )}
              <Field label="Description" className={s.fieldStep}><Input value={inDesc} onChange={(_, d) => setInDesc(d.value)} placeholder="The customer to assess" /></Field>
              <Checkbox label="Required" checked={inReq} onChange={(_, d) => setInReq(!!d.checked)} />
              <Button appearance="primary" icon={<Add20Regular />} disabled={!/^[A-Za-z_][\w]*$/.test(inName.trim()) || (AIP_OBJECT.has(inType) && !inObjType)} onClick={addInput}>Add</Button>
            </div>
            {inputs.length === 0 ? <div className={s.empty}><Caption1>No inputs yet.</Caption1></div> : inputs.map((i) => (
              <div key={i.id} className={s.row}>
                <Body1><strong>{i.name}</strong></Body1>
                <Badge appearance="tint">{i.type}{i.objectType ? `: ${i.objectType}` : ''}</Badge>
                {i.required && <Badge appearance="outline" color="danger">required</Badge>}
                {i.description && <Caption1 className={s.hint}>{i.description}</Caption1>}
                <span className={s.spacer} />
                <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${i.name}`} onClick={() => removeInput(i.id)}>Remove</Button>
              </div>
            ))}
          </div>

          <div className={s.section}>
            <SectionHead icon={<Code20Regular />} title="Typed output" hint="The shape the function returns." />
            <Field label="Output type"><Dropdown value={String(state.outputType || 'string')} selectedOptions={[String(state.outputType || 'string')]} onOptionSelect={(_, d) => setState((p) => ({ ...p, outputType: d.optionValue || 'string' }))}>
              <Option value="string">string</Option><Option value="number">number</Option><Option value="boolean">boolean</Option><Option value="object">object (JSON)</Option>
            </Dropdown></Field>
            <Field label="Output description"><Input value={String(state.outputDescription || '')} onChange={(_, d) => setState((p) => ({ ...p, outputDescription: d.value }))} placeholder="A one-line risk summary" /></Field>
          </div>
        </div>

        <div className={s.section}>
          <SectionHead icon={<Flash20Regular />} title="Typed block graph" hint="Ordered typed blocks — each emits a named, typed output later blocks reference. Configured with dropdowns; every block runs a real Azure-native backend." />
          <div className={s.addBar}>
            <Field label="Add block" className={s.fieldMed}>
              <Dropdown
                value={AIP_BLOCK_META[addBlockKind].label}
                selectedOptions={[addBlockKind]}
                onOptionSelect={(_, d) => setAddBlockKind((d.optionValue as AipBlockKind) || 'use-llm')}>
                {(Object.keys(AIP_BLOCK_META) as AipBlockKind[]).map((k) => <Option key={k} value={k} text={AIP_BLOCK_META[k].label}>{AIP_BLOCK_META[k].label}</Option>)}
              </Dropdown>
            </Field>
            <Caption1 className={s.hint}>{AIP_BLOCK_META[addBlockKind].hint}</Caption1>
            <span className={s.spacer} />
            <Button appearance="primary" icon={<Add20Regular />} onClick={() => addBlock(addBlockKind)}>Add block</Button>
          </div>
          {blocks.length === 0 ? (
            <div className={s.empty}><Caption1>No blocks yet — add at least one (e.g. a Use-LLM block) to invoke.</Caption1></div>
          ) : blocks.map((b, n) => (
            <div key={b.id}>
              {n > 0 && <div className={s.blockConnector}><ChevronRight20Regular style={{ transform: 'rotate(90deg)' }} /></div>}
              <AipBlockCard
                block={b} index={n} total={blocks.length}
                priorRefs={[...inputs.map((i) => i.name), ...blocks.slice(0, n).map((x) => x.output)]}
                entityTypes={entityTypes} propsByType={propsByType} actionTypes={actionTypes} siblingFns={siblingFns}
                onChange={(patch) => updateBlock(b.id, patch)} onRemove={() => removeBlock(b.id)} onMove={(dir) => moveBlock(b.id, dir)} />
            </div>
          ))}
        </div>

        <div className={s.section}>
          <SectionHead icon={<Play20Regular />} title="Invoke" hint="Run against the live Azure OpenAI deployment — as typed logic or as a tool-calling agent over the bound ontology." />
          <div className={s.modeBar}>
            <Switch checked={agentMode} onChange={(_, d) => setAgentMode(!!d.checked)} label={agentMode ? 'Agent mode (multi-step, tool-calling)' : 'Logic mode (single grounded turn)'} />
            <span className={s.spacer} />
            <Badge appearance="tint" color={agentMode ? 'brand' : 'informative'} icon={agentMode ? <BrainCircuit20Regular /> : <Flash20Regular />}>{agentMode ? 'Agent' : 'Logic'}</Badge>
          </div>
          {inputs.length === 0 ? <Caption1 className={s.hint}>Add typed inputs to provide values.</Caption1> : inputs.map((i) => (
            <Field key={i.id} label={`${i.name} (${i.type}${i.objectType ? `: ${i.objectType}` : ''})${i.required ? ' *' : ''}`} hint={i.description || undefined}>
              <Input
                value={invokeVals[i.name] || ''}
                onChange={(_, d) => setInvokeVals((p) => ({ ...p, [i.name]: d.value }))}
                placeholder={AIP_JSON.has(i.type) ? (i.type === 'array' ? '["a","b"]' : '{"k":"v"}') : AIP_OBJECT.has(i.type) ? 'object id / primary key' : i.type === 'boolean' ? 'true / false' : ''} />
            </Field>
          ))}
          <Button appearance="primary" icon={<Play20Regular />} disabled={invokeBusy || blocks.length === 0} onClick={invoke}>{invokeBusy ? 'Running…' : agentMode ? 'Run agent' : 'Invoke function'}</Button>
          {invokeMsg && <MessageBar intent={invokeMsg.intent}><MessageBarBody>{invokeMsg.text}</MessageBarBody></MessageBar>}
          {sourcesUsed.length > 0 && <div className={s.row}><Caption1 className={s.hint}>Grounded sources:</Caption1>{sourcesUsed.map((src) => <Badge key={src} appearance="tint" color="brand">{src}</Badge>)}</div>}
          {invokeOut !== null && <CodeBlock ariaLabel="Function output" content={invokeOut} />}
          {runSteps.length > 0 && (
            <>
              <Divider />
              <div className={s.sectionHead}>
                <span className={s.sectionIcon}><Bug20Regular /></span>
                <div>
                  <Subtitle2>Debugger</Subtitle2>
                  <Caption1 as="p" block className={s.hint}>{runSteps.length} step{runSteps.length === 1 ? '' : 's'} — expand a card to inspect the prompt, tool calls, output, and timing.</Caption1>
                </div>
              </div>
              <Accordion multiple collapsible>
                {runSteps.map((st, n) => {
                  const label = st.kind || st.type || st.name || 'step';
                  const isErr = st.kind === 'error' || st.status === 'error' || !!st.error;
                  const isGate = st.status === 'gate' || !!st.gate;
                  const isFinal = st.kind === 'final';
                  const isBlock = !!st.output && (st.kind ? st.kind in AIP_BLOCK_META : false);
                  const head = isBlock ? (AIP_BLOCK_META[st.kind as AipBlockKind]?.label || label)
                    : st.kind === 'tool_call' ? `tool · ${st.name || ''}`
                    : st.kind === 'tool_result' ? `result · ${st.name || ''}`
                    : label;
                  const detail = st.error || st.gate?.remediation || st.content || st.prompt
                    || (st.result !== undefined ? JSON.stringify(st.result, null, 2) : '')
                    || st.name || '';
                  const key = st.callId || `${label}-${n}`;
                  const tone = isErr ? 'danger' : isGate ? 'warning' : isFinal ? 'success' : 'brand';
                  return (
                    <AccordionItem key={key} value={key}>
                      <AccordionHeader>
                        <div className={s.traceHead}>
                          <Badge appearance="filled" color={tone as any}>{n + 1}</Badge>
                          {isBlock && AIP_BLOCK_META[st.kind as AipBlockKind]?.icon}
                          <Badge appearance="tint" color={isErr ? 'danger' : isGate ? 'warning' : isFinal ? 'success' : 'informative'}>{head}</Badge>
                          {st.output && <span className={s.outPill}><Badge appearance="outline" color="brand">{st.output}: {st.outputType || 'string'}</Badge></span>}
                          {typeof st.elapsedMs === 'number' && <Caption1 className={s.hint}>{st.elapsedMs} ms</Caption1>}
                          {st.model && <Badge appearance="outline">{st.model}</Badge>}
                          {st.status && <Badge appearance="outline" color={isErr ? 'danger' : isGate ? 'warning' : undefined}>{st.status}</Badge>}
                        </div>
                      </AccordionHeader>
                      <AccordionPanel>
                        {isGate && st.gate && (
                          <MessageBar intent="warning"><MessageBarBody>
                            <MessageBarTitle>{st.gate.reason || 'Infrastructure required'}</MessageBarTitle>
                            {st.gate.remediation}
                          </MessageBarBody></MessageBar>
                        )}
                        {st.output && st.content !== undefined && st.content !== '' && (
                          <Caption1 className={s.hint}>Resolved output <strong>{st.output}</strong> = {String(st.content).slice(0, 200)}</Caption1>
                        )}
                        {Array.isArray(st.tools) && st.tools.length > 0 && (
                          <CodeBlock ariaLabel={`Step ${n + 1} tool calls`} content={JSON.stringify(st.tools, null, 2).slice(0, 4000)} />
                        )}
                        {detail ? <CodeBlock ariaLabel={`Step ${n + 1} detail`} content={String(detail).slice(0, 4000)} /> : <Caption1 className={s.hint}>No additional detail for this step.</Caption1>}
                      </AccordionPanel>
                    </AccordionItem>
                  );
                })}
              </Accordion>
            </>
          )}
        </div>

        <div className={s.section}>
          <SectionHead icon={<History20Regular />} title="Run history" hint="Recent invocations persisted to Cosmos with this function — open a run to rehydrate its output and debugger trace." />
          {runs.length === 0 ? <div className={s.empty}><Caption1>No runs yet — Invoke the function to record a run.</Caption1></div> : (
            <div className={s.tableWrap}>
              <Table aria-label="Run history" size="small">
                <TableHeader><TableRow>
                  <TableHeaderCell>When</TableHeaderCell>
                  <TableHeaderCell>Mode</TableHeaderCell>
                  <TableHeaderCell>Model</TableHeaderCell>
                  <TableHeaderCell>Tokens</TableHeaderCell>
                  <TableHeaderCell>Output</TableHeaderCell>
                  <TableHeaderCell aria-label="actions" />
                </TableRow></TableHeader>
                <TableBody>
                  {runs.map((rec) => (
                    <TableRow key={rec.id}>
                      <TableCell><Caption1>{new Date(rec.ts).toLocaleString()}</Caption1></TableCell>
                      <TableCell><Badge appearance="tint" color={rec.mode === 'agent' ? 'brand' : 'informative'}>{rec.mode}</Badge></TableCell>
                      <TableCell><Caption1 className={s.hint}>{rec.model || '—'}</Caption1></TableCell>
                      <TableCell><Caption1 className={s.hint}>{rec.usage?.totalTokens ?? '—'}</Caption1></TableCell>
                      <TableCell><Caption1 className={s.hint}>{String(rec.output || '').slice(0, 60) || '—'}</Caption1></TableCell>
                      <TableCell><Button size="small" appearance="subtle" icon={<Play20Regular />} onClick={() => loadRun(rec)}>Open</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <div className={s.section}>
          <SectionHead icon={<Rocket20Regular />} title="Publish as Azure AI Foundry agent" hint="Deploy this Spindle logic as a real Foundry Agent Service agent, then run + inspect its steps. Unsupported in Azure Government — use Invoke (Azure-native) there." />
          <div className={s.addBar}>
            <Button appearance="primary" icon={<Rocket20Regular />} disabled={deployBusy || blocks.length === 0} onClick={deploy}>{deployBusy ? 'Deploying…' : state.foundryAgentId ? 'Re-deploy agent' : 'Deploy as agent'}</Button>
            <Button appearance="secondary" icon={<Play20Regular />} disabled={invokeBusy || !state.foundryAgentId} onClick={runDeployedAgent}>Run deployed agent + inspect</Button>
            {state.foundryAgentId && <Badge appearance="tint" color="success">{state.foundryAgentId}</Badge>}
            {state.foundryModel && <Badge appearance="tint">model: {state.foundryModel}</Badge>}
          </div>
          {deployMsg && <MessageBar intent={deployMsg.intent}><MessageBarBody>{deployMsg.text}</MessageBarBody></MessageBar>}
        </div>

        <SaveStrip saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
      </div>
    } />
  );
}
