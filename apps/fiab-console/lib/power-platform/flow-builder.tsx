'use client';

/**
 * FlowBuilder — guided visual authoring surface for a Logic Apps / Power Automate
 * workflow definition (WDL).
 *
 * Props:
 *   definition  — full WDL object { $schema, contentVersion, parameters, triggers, actions, ... }
 *   onChange    — called with the rebuilt WDL whenever the user edits anything
 *
 * Design contract (round-trip safety):
 *   - parseDefinition extracts the single trigger + topologically-ordered linear action list.
 *   - If the flow is "complex" (branching, multiple triggers, nested scopes, Foreach/If/Until)
 *     the component signals complex=true and does NOT attempt to edit — the caller falls back
 *     to the raw JSON textarea.
 *   - buildDefinition reconstructs triggers + actions faithfully:
 *       * preserves $schema, contentVersion, parameters, and any extra top-level keys
 *       * custom-kind actions re-emit their original raw object verbatim
 *       * runAfter: first action → {}, each subsequent → { [prevName]: ['Succeeded'] }
 *   - parse(build(parse(def))) === parse(def) for any linear flow (modulo JSON key ordering).
 *   - For complex flows buildDefinition is never called — the JSON stays authoritative.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Caption1,
  Dropdown,
  Field,
  Input,
  Option,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Add20Regular,
  ArrowUp20Regular,
  ArrowDown20Regular,
  Delete20Regular,
  Flash20Regular,
  Globe20Regular,
  Code20Regular,
  BracesVariable20Regular as Variable20Regular,
  CheckmarkCircle20Regular,
  DismissCircle20Regular,
  Compose20Regular,
  QuestionCircle20Regular,
} from '@fluentui/react-icons';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriggerKind = 'manual' | 'recurrence' | 'http' | 'custom';
export type ActionKind =
  | 'http'
  | 'compose'
  | 'parseJson'
  | 'initVar'
  | 'setVar'
  | 'response'
  | 'terminate'
  | 'custom';

export interface TriggerNode {
  kind: TriggerKind;
  name: string;
  /** full raw trigger object — always kept in sync so custom round-trips cleanly */
  raw: Record<string, unknown>;
  // typed fields (only populated for known kinds):
  recurrenceFrequency?: string;
  recurrenceInterval?: number;
}

export interface ActionNode {
  kind: ActionKind;
  name: string;
  /** full raw action object — always kept in sync */
  raw: Record<string, unknown>;
  // typed fields (only populated for known kinds):
  httpMethod?: string;
  httpUri?: string;
  httpBody?: string;
  composeInputs?: string;
  parseJsonContent?: string;
  parseJsonSchema?: string;
  initVarName?: string;
  initVarType?: string;
  initVarValue?: string;
  setVarName?: string;
  setVarValue?: string;
  responseStatusCode?: string;
  responseBody?: string;
  terminateStatus?: string;
}

export interface ParsedFlow {
  complex: boolean;
  complexReason?: string;
  trigger: TriggerNode | null;
  actions: ActionNode[];
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

function detectTriggerKind(raw: Record<string, unknown>): TriggerKind {
  const type = (raw['type'] as string | undefined)?.toLowerCase() ?? '';
  const kind = (raw['kind'] as string | undefined)?.toLowerCase() ?? '';
  if (type === 'recurrence') return 'recurrence';
  if (type === 'request' && kind === 'button') return 'manual';
  if (type === 'request' && kind === 'http') return 'http';
  return 'custom';
}

function detectActionKind(raw: Record<string, unknown>): ActionKind {
  const type = (raw['type'] as string | undefined)?.toLowerCase() ?? '';
  switch (type) {
    case 'http': return 'http';
    case 'compose': return 'compose';
    case 'parsejson': return 'parseJson';
    case 'initializevariable': return 'initVar';
    case 'setvariable': return 'setVar';
    case 'response': return 'response';
    case 'terminate': return 'terminate';
    default: return 'custom';
  }
}

/** Topologically sort actions by runAfter into a linear chain.
 *  Returns null if the graph is not a single linear chain (has branching or cycles). */
function topoSortLinear(actions: Record<string, unknown>): ActionNode[] | null {
  const names = Object.keys(actions);
  if (names.length === 0) return [];

  // Build adjacency: name -> Set of names it depends on (runAfter keys)
  const deps: Map<string, string[]> = new Map();
  for (const name of names) {
    const raw = actions[name] as Record<string, unknown>;
    const runAfter = (raw['runAfter'] as Record<string, unknown> | undefined) ?? {};
    deps.set(name, Object.keys(runAfter));
  }

  // Find roots (no deps)
  const roots = names.filter((n) => (deps.get(n)?.length ?? 0) === 0);
  if (roots.length !== 1) return null; // multiple roots = branches

  // Walk the chain; each step must have exactly one successor
  const ordered: string[] = [];
  const visited = new Set<string>();
  let current = roots[0];

  while (current) {
    if (visited.has(current)) return null; // cycle
    visited.add(current);
    ordered.push(current);

    // Find all nodes whose ONLY dep is current
    const successors = names.filter((n) => {
      const d = deps.get(n) ?? [];
      return d.length === 1 && d[0] === current;
    });

    if (successors.length > 1) return null; // branching
    current = successors[0] ?? '';
    if (!current) break;
  }

  if (ordered.length !== names.length) return null; // disconnected or cycle remnants

  return ordered.map((name) => {
    const raw = actions[name] as Record<string, unknown>;
    return buildActionNode(name, raw);
  });
}

function buildTriggerNode(name: string, raw: Record<string, unknown>): TriggerNode {
  const kind = detectTriggerKind(raw);
  const node: TriggerNode = { kind, name, raw };
  if (kind === 'recurrence') {
    const rec = (raw['recurrence'] as Record<string, unknown> | undefined) ?? {};
    node.recurrenceFrequency = (rec['frequency'] as string | undefined) ?? 'Day';
    node.recurrenceInterval = (rec['interval'] as number | undefined) ?? 1;
  }
  return node;
}

function buildActionNode(name: string, raw: Record<string, unknown>): ActionNode {
  const kind = detectActionKind(raw);
  const node: ActionNode = { kind, name, raw };
  const inputs = (raw['inputs'] as Record<string, unknown> | undefined) ?? {};

  if (kind === 'http') {
    node.httpMethod = (inputs['method'] as string | undefined) ?? 'GET';
    node.httpUri = (inputs['uri'] as string | undefined) ?? '';
    node.httpBody = inputs['body'] !== undefined ? JSON.stringify(inputs['body'], null, 2) : '';
  } else if (kind === 'compose') {
    node.composeInputs = inputs['value'] !== undefined
      ? (typeof inputs['value'] === 'string' ? inputs['value'] : JSON.stringify(inputs['value'], null, 2))
      : (typeof raw['inputs'] === 'string' ? raw['inputs'] as string : JSON.stringify(raw['inputs'], null, 2));
  } else if (kind === 'parseJson') {
    node.parseJsonContent = (inputs['content'] as string | undefined) ?? '';
    node.parseJsonSchema = inputs['schema'] !== undefined ? JSON.stringify(inputs['schema'], null, 2) : '{}';
  } else if (kind === 'initVar') {
    const variables = (inputs['variables'] as Record<string, unknown>[] | undefined) ?? [];
    const v = variables[0] ?? {};
    node.initVarName = (v['name'] as string | undefined) ?? '';
    node.initVarType = (v['type'] as string | undefined) ?? 'String';
    node.initVarValue = v['value'] !== undefined
      ? (typeof v['value'] === 'string' ? v['value'] : JSON.stringify(v['value']))
      : '';
  } else if (kind === 'setVar') {
    node.setVarName = (inputs['name'] as string | undefined) ?? '';
    node.setVarValue = inputs['value'] !== undefined
      ? (typeof inputs['value'] === 'string' ? inputs['value'] : JSON.stringify(inputs['value']))
      : '';
  } else if (kind === 'response') {
    node.responseStatusCode = String(inputs['statusCode'] ?? '200');
    node.responseBody = inputs['body'] !== undefined
      ? (typeof inputs['body'] === 'string' ? inputs['body'] : JSON.stringify(inputs['body'], null, 2))
      : '';
  } else if (kind === 'terminate') {
    node.terminateStatus = (inputs['runStatus'] as string | undefined) ?? 'Succeeded';
  }
  return node;
}

/** Check for nested scopes/loops that make the flow complex. */
function hasNestedActions(raw: Record<string, unknown>): boolean {
  const type = (raw['type'] as string | undefined)?.toLowerCase() ?? '';
  return ['foreach', 'if', 'until', 'scope', 'switch'].includes(type);
}

// ---------------------------------------------------------------------------
// Public parse function
// ---------------------------------------------------------------------------

export function parseDefinition(def: Record<string, unknown>): ParsedFlow {
  const triggers = (def['triggers'] as Record<string, unknown> | undefined) ?? {};
  const actions = (def['actions'] as Record<string, unknown> | undefined) ?? {};

  const triggerKeys = Object.keys(triggers);
  if (triggerKeys.length > 1) {
    return { complex: true, complexReason: 'Flow has multiple triggers.', trigger: null, actions: [] };
  }

  // Check for nested action types
  for (const name of Object.keys(actions)) {
    const raw = actions[name] as Record<string, unknown>;
    if (hasNestedActions(raw)) {
      return {
        complex: true,
        complexReason: `Action "${name}" uses ${raw['type']} (branch/loop/scope) — not editable in the guided builder.`,
        trigger: null,
        actions: [],
      };
    }
  }

  const trigger = triggerKeys.length === 1
    ? buildTriggerNode(triggerKeys[0], triggers[triggerKeys[0]] as Record<string, unknown>)
    : null;

  const sortedActions = topoSortLinear(actions);
  if (sortedActions === null) {
    return {
      complex: true,
      complexReason: 'Actions have branching or non-linear runAfter dependencies.',
      trigger,
      actions: [],
    };
  }

  return { complex: false, trigger, actions: sortedActions };
}

// ---------------------------------------------------------------------------
// Build (serialize) helpers
// ---------------------------------------------------------------------------

function rebuildTriggerRaw(node: TriggerNode): Record<string, unknown> {
  if (node.kind === 'custom') return node.raw;
  if (node.kind === 'recurrence') {
    return {
      ...node.raw,
      type: 'Recurrence',
      recurrence: {
        ...((node.raw['recurrence'] as Record<string, unknown> | undefined) ?? {}),
        frequency: node.recurrenceFrequency ?? 'Day',
        interval: Number(node.recurrenceInterval ?? 1),
      },
    };
  }
  if (node.kind === 'manual') {
    return { ...node.raw, type: 'Request', kind: 'Button' };
  }
  if (node.kind === 'http') {
    return { ...node.raw, type: 'Request', kind: 'Http' };
  }
  return node.raw;
}

function safeParse(s: string | undefined): unknown {
  if (!s || !s.trim()) return undefined;
  try { return JSON.parse(s); } catch { return s; }
}

function rebuildActionRaw(node: ActionNode, prevName: string | null): Record<string, unknown> {
  const runAfter: Record<string, string[]> = prevName ? { [prevName]: ['Succeeded'] } : {};

  if (node.kind === 'custom') {
    // Preserve raw verbatim but update runAfter to match new position
    return { ...node.raw, runAfter };
  }

  const base = { ...node.raw, runAfter };

  if (node.kind === 'http') {
    const inputs: Record<string, unknown> = {
      ...((node.raw['inputs'] as Record<string, unknown> | undefined) ?? {}),
      method: node.httpMethod ?? 'GET',
      uri: node.httpUri ?? '',
    };
    if (node.httpBody && node.httpBody.trim()) {
      inputs['body'] = safeParse(node.httpBody);
    }
    return { ...base, type: 'Http', inputs };
  }

  if (node.kind === 'compose') {
    const val = safeParse(node.composeInputs);
    return { ...base, type: 'Compose', inputs: val };
  }

  if (node.kind === 'parseJson') {
    const schema = safeParse(node.parseJsonSchema) ?? {};
    return {
      ...base,
      type: 'ParseJson',
      inputs: {
        ...((node.raw['inputs'] as Record<string, unknown> | undefined) ?? {}),
        content: node.parseJsonContent ?? '',
        schema,
      },
    };
  }

  if (node.kind === 'initVar') {
    const val = safeParse(node.initVarValue);
    return {
      ...base,
      type: 'InitializeVariable',
      inputs: {
        variables: [{
          name: node.initVarName ?? '',
          type: node.initVarType ?? 'String',
          ...(val !== undefined ? { value: val } : {}),
        }],
      },
    };
  }

  if (node.kind === 'setVar') {
    return {
      ...base,
      type: 'SetVariable',
      inputs: {
        name: node.setVarName ?? '',
        value: safeParse(node.setVarValue),
      },
    };
  }

  if (node.kind === 'response') {
    const body = safeParse(node.responseBody);
    return {
      ...base,
      type: 'Response',
      inputs: {
        ...((node.raw['inputs'] as Record<string, unknown> | undefined) ?? {}),
        statusCode: Number(node.responseStatusCode ?? 200),
        ...(body !== undefined ? { body } : {}),
      },
    };
  }

  if (node.kind === 'terminate') {
    return {
      ...base,
      type: 'Terminate',
      inputs: {
        ...((node.raw['inputs'] as Record<string, unknown> | undefined) ?? {}),
        runStatus: node.terminateStatus ?? 'Succeeded',
      },
    };
  }

  return base;
}

// ---------------------------------------------------------------------------
// Public build function
// ---------------------------------------------------------------------------

export function buildDefinition(
  trigger: TriggerNode | null,
  actions: ActionNode[],
  base: Record<string, unknown>,
): Record<string, unknown> {
  const triggers: Record<string, unknown> = trigger
    ? { [trigger.name]: rebuildTriggerRaw(trigger) }
    : (base['triggers'] as Record<string, unknown> | undefined) ?? {};

  const builtActions: Record<string, unknown> = {};
  let prev: string | null = null;
  for (const node of actions) {
    builtActions[node.name] = rebuildActionRaw(node, prev);
    prev = node.name;
  }

  return {
    ...base,
    triggers,
    actions: builtActions,
  };
}

// ---------------------------------------------------------------------------
// Counter for unique new-action names
// ---------------------------------------------------------------------------

let _actionCounter = 0;
function uniqueActionName(kind: ActionKind, existingNames: string[]): string {
  const prefix = kind === 'http' ? 'HTTP'
    : kind === 'compose' ? 'Compose'
    : kind === 'parseJson' ? 'Parse_JSON'
    : kind === 'initVar' ? 'Initialize_variable'
    : kind === 'setVar' ? 'Set_variable'
    : kind === 'response' ? 'Response'
    : kind === 'terminate' ? 'Terminate'
    : 'Action';
  let name = `${prefix}_${++_actionCounter}`;
  while (existingNames.includes(name)) {
    name = `${prefix}_${++_actionCounter}`;
  }
  return name;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    // Fills the wrapping <ResizableCanvasRegion>, which now owns the definite
    // (user-resizable, persisted) pixel height; the flow list scrolls within it.
    height: '100%',
    minHeight: 0,
    overflowY: 'auto',
    // Small inset so card elevation + the bottom drag grip never clip the nodes.
    padding: tokens.spacingHorizontalS,
  },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    boxShadow: tokens.shadow4,
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  cardTitle: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
    flex: '1 1 auto',
  },
  kindBadge: {
    flexShrink: 0,
  },
  formGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
  },
  formGridFull: {
    gridColumn: '1 / -1',
  },
  actionRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  connectorLine: {
    display: 'flex',
    justifyContent: 'center',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    paddingBlock: tokens.spacingVerticalXS,
  },
  addBar: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  monoSmall: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '11px',
    minHeight: '72px',
  },
  customJson: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '11px',
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    background: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusSmall,
    padding: tokens.spacingVerticalXS,
    maxHeight: '120px',
    overflow: 'auto',
  },
  sectionLabel: {
    color: tokens.colorNeutralForeground2,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    marginBottom: tokens.spacingVerticalXS,
  },
  customEditBox: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '11px',
    minHeight: '96px',
  },
});

// ---------------------------------------------------------------------------
// Trigger card
// ---------------------------------------------------------------------------

interface TriggerCardProps {
  trigger: TriggerNode;
  onChange: (t: TriggerNode) => void;
}

function TriggerCard({ trigger, onChange }: TriggerCardProps) {
  const s = useStyles();

  const kindLabel: Record<TriggerKind, string> = {
    manual: 'Manual / Button',
    recurrence: 'Recurrence',
    http: 'HTTP Request',
    custom: 'Custom',
  };

  return (
    <div className={s.card}>
      <div className={s.cardHeader}>
        <Flash20Regular style={{ color: tokens.colorBrandForeground1 }} />
        <span className={s.cardTitle}>Trigger — {trigger.name}</span>
        <Badge className={s.kindBadge} appearance="tint" color="brand">{kindLabel[trigger.kind]}</Badge>
      </div>

      <Field label="Trigger kind">
        <Dropdown
          value={kindLabel[trigger.kind]}
          onOptionSelect={(_, d) => {
            const k = d.optionValue as TriggerKind;
            const updated: TriggerNode = { ...trigger, kind: k };
            if (k === 'recurrence' && !updated.recurrenceFrequency) {
              updated.recurrenceFrequency = 'Day';
              updated.recurrenceInterval = 1;
            }
            onChange(updated);
          }}
        >
          {(Object.keys(kindLabel) as TriggerKind[]).map((k) => (
            <Option key={k} value={k}>{kindLabel[k]}</Option>
          ))}
        </Dropdown>
      </Field>

      {trigger.kind === 'recurrence' && (
        <div className={s.formGrid}>
          <Field label="Frequency">
            <Dropdown
              value={trigger.recurrenceFrequency ?? 'Day'}
              onOptionSelect={(_, d) => onChange({ ...trigger, recurrenceFrequency: d.optionValue as string })}
            >
              {['Second', 'Minute', 'Hour', 'Day', 'Week', 'Month'].map((f) => (
                <Option key={f} value={f}>{f}</Option>
              ))}
            </Dropdown>
          </Field>
          <Field label="Interval">
            <Input
              type="number"
              value={String(trigger.recurrenceInterval ?? 1)}
              onChange={(_, d) => onChange({ ...trigger, recurrenceInterval: parseInt(d.value, 10) || 1 })}
            />
          </Field>
        </div>
      )}

      {trigger.kind === 'custom' && (
        <div>
          <div className={s.sectionLabel}>Raw trigger definition (inputs preserved)</div>
          <div className={s.customJson}>{JSON.stringify(trigger.raw, null, 2)}</div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action card
// ---------------------------------------------------------------------------

interface ActionCardProps {
  action: ActionNode;
  index: number;
  total: number;
  onChange: (a: ActionNode) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}

function ActionCard({ action, index, total, onChange, onMoveUp, onMoveDown, onRemove }: ActionCardProps) {
  const s = useStyles();
  const [customEditText, setCustomEditText] = useState('');
  const [customEditOpen, setCustomEditOpen] = useState(false);

  const kindLabel: Record<ActionKind, string> = {
    http: 'HTTP',
    compose: 'Compose',
    parseJson: 'Parse JSON',
    initVar: 'Init Variable',
    setVar: 'Set Variable',
    response: 'Response',
    terminate: 'Terminate',
    custom: 'Custom',
  };

  const kindIcon: Record<ActionKind, React.ReactNode> = {
    http: <Globe20Regular />,
    compose: <Compose20Regular />,
    parseJson: <Code20Regular />,
    initVar: <Variable20Regular />,
    setVar: <Variable20Regular />,
    response: <CheckmarkCircle20Regular />,
    terminate: <DismissCircle20Regular />,
    custom: <QuestionCircle20Regular />,
  };

  return (
    <div className={s.card}>
      <div className={s.cardHeader}>
        <span style={{ color: tokens.colorBrandForeground1 }}>{kindIcon[action.kind]}</span>
        <span className={s.cardTitle}>{action.name}</span>
        <Badge className={s.kindBadge} appearance="tint" color="informative">{kindLabel[action.kind]}</Badge>
        <div className={s.actionRow}>
          <Button
            size="small"
            appearance="subtle"
            icon={<ArrowUp20Regular />}
            disabled={index === 0}
            onClick={onMoveUp}
            title="Move up"
          />
          <Button
            size="small"
            appearance="subtle"
            icon={<ArrowDown20Regular />}
            disabled={index === total - 1}
            onClick={onMoveDown}
            title="Move down"
          />
          <Button
            size="small"
            appearance="subtle"
            icon={<Delete20Regular />}
            onClick={onRemove}
            title="Remove action"
          />
        </div>
      </div>

      {/* Kind selector */}
      <Field label="Action type">
        <Dropdown
          value={kindLabel[action.kind]}
          onOptionSelect={(_, d) => {
            const k = d.optionValue as ActionKind;
            // When switching kind, reset typed fields but keep name + raw for safety
            const updated: ActionNode = { ...action, kind: k };
            onChange(updated);
          }}
        >
          {(Object.keys(kindLabel) as ActionKind[]).map((k) => (
            <Option key={k} value={k}>{kindLabel[k]}</Option>
          ))}
        </Dropdown>
      </Field>

      {/* Per-kind forms */}
      {action.kind === 'http' && (
        <div className={s.formGrid}>
          <Field label="Method">
            <Dropdown
              value={action.httpMethod ?? 'GET'}
              onOptionSelect={(_, d) => onChange({ ...action, httpMethod: d.optionValue as string })}
            >
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                <Option key={m} value={m}>{m}</Option>
              ))}
            </Dropdown>
          </Field>
          <Field label="URI">
            <Input
              value={action.httpUri ?? ''}
              onChange={(_, d) => onChange({ ...action, httpUri: d.value })}
              placeholder="https://..."
            />
          </Field>
          <div className={s.formGridFull}>
            <Field label="Body (JSON or plain text)">
              <Textarea
                className={s.monoSmall}
                value={action.httpBody ?? ''}
                onChange={(_, d) => onChange({ ...action, httpBody: d.value })}
                resize="vertical"
                placeholder='{ "key": "value" }'
              />
            </Field>
          </div>
        </div>
      )}

      {action.kind === 'compose' && (
        <Field label="Inputs (expression, string, or JSON)">
          <Textarea
            className={s.monoSmall}
            value={action.composeInputs ?? ''}
            onChange={(_, d) => onChange({ ...action, composeInputs: d.value })}
            resize="vertical"
            placeholder='@triggerBody()'
          />
        </Field>
      )}

      {action.kind === 'parseJson' && (
        <div className={s.formGrid}>
          <div className={s.formGridFull}>
            <Field label="Content (expression)">
              <Input
                value={action.parseJsonContent ?? ''}
                onChange={(_, d) => onChange({ ...action, parseJsonContent: d.value })}
                placeholder='@body("HTTP")'
              />
            </Field>
          </div>
          <div className={s.formGridFull}>
            <Field label="Schema (JSON Schema)">
              <Textarea
                className={s.monoSmall}
                value={action.parseJsonSchema ?? '{}'}
                onChange={(_, d) => onChange({ ...action, parseJsonSchema: d.value })}
                resize="vertical"
                placeholder='{ "type": "object", "properties": { ... } }'
              />
            </Field>
          </div>
        </div>
      )}

      {action.kind === 'initVar' && (
        <div className={s.formGrid}>
          <Field label="Variable name">
            <Input
              value={action.initVarName ?? ''}
              onChange={(_, d) => onChange({ ...action, initVarName: d.value })}
              placeholder="myVar"
            />
          </Field>
          <Field label="Type">
            <Dropdown
              value={action.initVarType ?? 'String'}
              onOptionSelect={(_, d) => onChange({ ...action, initVarType: d.optionValue as string })}
            >
              {['String', 'Integer', 'Float', 'Boolean', 'Array', 'Object'].map((t) => (
                <Option key={t} value={t}>{t}</Option>
              ))}
            </Dropdown>
          </Field>
          <div className={s.formGridFull}>
            <Field label="Initial value (optional)">
              <Input
                value={action.initVarValue ?? ''}
                onChange={(_, d) => onChange({ ...action, initVarValue: d.value })}
                placeholder='""'
              />
            </Field>
          </div>
        </div>
      )}

      {action.kind === 'setVar' && (
        <div className={s.formGrid}>
          <Field label="Variable name">
            <Input
              value={action.setVarName ?? ''}
              onChange={(_, d) => onChange({ ...action, setVarName: d.value })}
              placeholder="myVar"
            />
          </Field>
          <div className={s.formGridFull}>
            <Field label="Value (expression or literal)">
              <Input
                value={action.setVarValue ?? ''}
                onChange={(_, d) => onChange({ ...action, setVarValue: d.value })}
                placeholder='@outputs("Compose")'
              />
            </Field>
          </div>
        </div>
      )}

      {action.kind === 'response' && (
        <div className={s.formGrid}>
          <Field label="Status code">
            <Input
              value={action.responseStatusCode ?? '200'}
              onChange={(_, d) => onChange({ ...action, responseStatusCode: d.value })}
              placeholder="200"
            />
          </Field>
          <div className={s.formGridFull}>
            <Field label="Body (JSON or plain text)">
              <Textarea
                className={s.monoSmall}
                value={action.responseBody ?? ''}
                onChange={(_, d) => onChange({ ...action, responseBody: d.value })}
                resize="vertical"
                placeholder='{ "result": "ok" }'
              />
            </Field>
          </div>
        </div>
      )}

      {action.kind === 'terminate' && (
        <Field label="Run status">
          <Dropdown
            value={action.terminateStatus ?? 'Succeeded'}
            onOptionSelect={(_, d) => onChange({ ...action, terminateStatus: d.optionValue as string })}
          >
            {['Succeeded', 'Failed', 'Cancelled'].map((st) => (
              <Option key={st} value={st}>{st}</Option>
            ))}
          </Dropdown>
        </Field>
      )}

      {action.kind === 'custom' && (
        <div>
          <div className={s.sectionLabel}>Raw action definition (preserved verbatim)</div>
          <div className={s.customJson}>{JSON.stringify(action.raw, null, 2)}</div>
          <Button
            size="small"
            appearance="subtle"
            style={{ marginTop: tokens.spacingVerticalXS }}
            onClick={() => {
              if (!customEditOpen) {
                setCustomEditText(JSON.stringify(action.raw, null, 2));
              }
              setCustomEditOpen((v) => !v);
            }}
          >
            {customEditOpen ? 'Close JSON editor' : 'Edit raw JSON'}
          </Button>
          {customEditOpen && (
            <Field label="Edit action JSON (type + inputs + any extra fields)" style={{ marginTop: tokens.spacingVerticalS }}>
              <Textarea
                className={s.customEditBox}
                value={customEditText}
                onChange={(_, d) => setCustomEditText(d.value)}
                resize="vertical"
              />
              <Button
                size="small"
                appearance="primary"
                style={{ marginTop: tokens.spacingVerticalXS }}
                onClick={() => {
                  try {
                    const parsed = JSON.parse(customEditText);
                    const updated = buildActionNode(action.name, parsed as Record<string, unknown>);
                    onChange(updated);
                    setCustomEditOpen(false);
                  } catch {
                    // leave open; bad JSON
                  }
                }}
              >
                Apply JSON
              </Button>
            </Field>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add action palette
// ---------------------------------------------------------------------------

interface AddActionPaletteProps {
  existingNames: string[];
  onAdd: (node: ActionNode) => void;
}

function AddActionPalette({ existingNames, onAdd }: AddActionPaletteProps) {
  const s = useStyles();

  const templates: { kind: ActionKind; label: string; icon: React.ReactNode }[] = [
    { kind: 'http', label: 'HTTP', icon: <Globe20Regular /> },
    { kind: 'compose', label: 'Compose', icon: <Compose20Regular /> },
    { kind: 'parseJson', label: 'Parse JSON', icon: <Code20Regular /> },
    { kind: 'initVar', label: 'Init Variable', icon: <Variable20Regular /> },
    { kind: 'setVar', label: 'Set Variable', icon: <Variable20Regular /> },
    { kind: 'response', label: 'Response', icon: <CheckmarkCircle20Regular /> },
    { kind: 'terminate', label: 'Terminate', icon: <DismissCircle20Regular /> },
  ];

  return (
    <div className={s.addBar}>
      <Caption1 style={{ color: tokens.colorNeutralForeground2, alignSelf: 'center' }}>Add action:</Caption1>
      {templates.map(({ kind, label, icon }) => (
        <Button
          key={kind}
          size="small"
          appearance="outline"
          icon={icon}
          onClick={() => {
            const name = uniqueActionName(kind, existingNames);
            const raw: Record<string, unknown> = { type: kind === 'http' ? 'Http' : kind === 'compose' ? 'Compose' : kind === 'parseJson' ? 'ParseJson' : kind === 'initVar' ? 'InitializeVariable' : kind === 'setVar' ? 'SetVariable' : kind === 'response' ? 'Response' : 'Terminate', inputs: {}, runAfter: {} };
            const node = buildActionNode(name, raw);
            onAdd(node);
          }}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main exported component
// ---------------------------------------------------------------------------

export interface FlowBuilderProps {
  definition: Record<string, unknown>;
  onChange: (nextDefinition: Record<string, unknown>) => void;
}

export function FlowBuilder({ definition, onChange }: FlowBuilderProps) {
  const s = useStyles();

  const [parsed, setParsed] = useState<ParsedFlow>(() => parseDefinition(definition));
  const [trigger, setTrigger] = useState<TriggerNode | null>(() => parsed.trigger);
  const [actions, setActions] = useState<ActionNode[]>(() => parsed.actions);

  // Guard against re-parse loops: we track the serialized JSON of the last
  // definition we emitted or loaded. If the parent feeds back a definition that
  // serializes identically to what we just emitted, we skip the re-parse.
  const [lastEmittedJson, setLastEmittedJson] = useState<string>(
    () => JSON.stringify(definition),
  );

  useEffect(() => {
    const incoming = JSON.stringify(definition);
    if (incoming === lastEmittedJson) return; // our own echo — ignore
    const p = parseDefinition(definition);
    setParsed(p);
    setTrigger(p.trigger);
    setActions(p.actions);
    setLastEmittedJson(incoming);
  }, [definition, lastEmittedJson]);

  const emit = useCallback(
    (t: TriggerNode | null, a: ActionNode[]) => {
      const next = buildDefinition(t, a, definition);
      setLastEmittedJson(JSON.stringify(next)); // prevent re-parse echo
      onChange(next);
    },
    [definition, onChange],
  );

  const handleTriggerChange = useCallback(
    (t: TriggerNode) => {
      setTrigger(t);
      emit(t, actions);
    },
    [actions, emit],
  );

  const handleActionChange = useCallback(
    (i: number, a: ActionNode) => {
      const next = actions.map((x, idx) => (idx === i ? a : x));
      setActions(next);
      emit(trigger, next);
    },
    [actions, trigger, emit],
  );

  const handleMoveUp = useCallback(
    (i: number) => {
      if (i === 0) return;
      const next = [...actions];
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      setActions(next);
      emit(trigger, next);
    },
    [actions, trigger, emit],
  );

  const handleMoveDown = useCallback(
    (i: number) => {
      if (i >= actions.length - 1) return;
      const next = [...actions];
      [next[i], next[i + 1]] = [next[i + 1], next[i]];
      setActions(next);
      emit(trigger, next);
    },
    [actions, trigger, emit],
  );

  const handleRemove = useCallback(
    (i: number) => {
      const next = actions.filter((_, idx) => idx !== i);
      setActions(next);
      emit(trigger, next);
    },
    [actions, trigger, emit],
  );

  const handleAdd = useCallback(
    (node: ActionNode) => {
      const next = [...actions, node];
      setActions(next);
      emit(trigger, next);
    },
    [actions, trigger, emit],
  );

  // Complex flows: do not render the builder
  if (parsed.complex) {
    return null; // caller handles the fallback
  }

  return (
    // The flow canvas (trigger + linear action nodes + add palette) lives in a
    // user-resizable, persisted region. Canvas behaviour / nodes / edges are
    // unchanged — only the region height becomes drag/keyboard controllable.
    <ResizableCanvasRegion
      storageKey="power-automate-flow"
      defaultPx={420}
      minPx={280}
      ariaLabel="Resize flow canvas height"
    >
      <div className={s.root} data-testid="flow-builder">
        {/* Trigger */}
      {trigger ? (
        <TriggerCard trigger={trigger} onChange={handleTriggerChange} />
      ) : (
        <div className={s.card}>
          <div className={s.cardHeader}>
            <Flash20Regular style={{ color: tokens.colorNeutralForeground3 }} />
            <span className={s.cardTitle}>No trigger defined</span>
          </div>
          <Caption1>Add a trigger by editing the JSON directly or creating a new flow skeleton.</Caption1>
        </div>
      )}

      {/* Connector + actions */}
      {actions.map((action, i) => (
        <div key={action.name}>
          <div className={s.connectorLine}>
            <ArrowDown20Regular />
          </div>
          <ActionCard
            action={action}
            index={i}
            total={actions.length}
            onChange={(a) => handleActionChange(i, a)}
            onMoveUp={() => handleMoveUp(i)}
            onMoveDown={() => handleMoveDown(i)}
            onRemove={() => handleRemove(i)}
          />
        </div>
      ))}

      {/* Add action palette */}
      <div className={s.connectorLine}>
        <Add20Regular />
      </div>
      <AddActionPalette
        existingNames={actions.map((a) => a.name)}
        onAdd={handleAdd}
      />
      </div>
    </ResizableCanvasRegion>
  );
}
