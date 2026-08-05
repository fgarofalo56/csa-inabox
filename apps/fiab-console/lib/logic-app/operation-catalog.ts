/**
 * Logic Apps operation catalog — the designer's palette.
 *
 * Single source of truth for the WDL operations Loom's workflow designer can
 * add, what bucket they live in, the canvas accent category, the JSON template
 * stamped when a user drops one on the canvas, and the typed config fields the
 * inspector renders for it.
 *
 * Per `.claude/rules/no-vaporware.md` and the no-freeform-config standard,
 * every entry here is a REAL WDL operation type that Azure Logic Apps executes
 * on a Consumption workflow — each template is valid against the workflow
 * definition schema and is saved through the same ARM
 * `PUT Microsoft.Logic/workflows` the portal designer uses. Nothing in this
 * catalog is decorative, and the inspector renders typed controls for it rather
 * than asking the user to hand-write JSON.
 *
 * SCOPE — this is the built-in / control-flow tier of the Logic Apps operation
 * surface: the operations whose behaviour is defined entirely by the workflow
 * definition and therefore need no API connection resource. Managed connectors
 * (Office 365, SharePoint, Salesforce, …) are `ApiConnection`-type operations
 * that additionally require a `Microsoft.Web/connections` resource plus an
 * OAuth consent flow per connector; they are deliberately DEFERRED and tracked
 * in docs/fiab/parity/logic-app.md rather than faked here.
 *
 * Docs:
 *   https://learn.microsoft.com/azure/logic-apps/logic-apps-workflow-actions-triggers
 *   https://learn.microsoft.com/azure/logic-apps/logic-apps-control-flow-run-steps-group-scopes
 *   https://learn.microsoft.com/azure/connectors/built-in
 */

import type { CanvasNodeCategory } from '@/lib/components/canvas/canvas-node-kit';
import type { WdlOperation } from './wdl-model';

/** Palette buckets — mirror the Logic Apps designer's own grouping. */
export type OperationCategory = 'triggers' | 'http' | 'data' | 'control' | 'variables';

export const OPERATION_CATEGORY_ORDER: Array<{ id: OperationCategory; label: string }> = [
  { id: 'triggers', label: 'Triggers' },
  { id: 'http', label: 'HTTP & requests' },
  { id: 'data', label: 'Data operations' },
  { id: 'control', label: 'Control flow' },
  { id: 'variables', label: 'Variables' },
];

/** A typed inspector field. Mirrors the pipeline editor's ConfigField idiom. */
export interface OperationField {
  /** Dot-path into the operation, e.g. 'inputs.method' or 'recurrence.frequency'. */
  path: string;
  label: string;
  kind: 'text' | 'textarea' | 'select' | 'number' | 'json';
  options?: string[];
  placeholder?: string;
  help?: string;
  required?: boolean;
}

export interface OperationDef {
  /** Palette id — stable, used as the DnD payload. */
  id: string;
  label: string;
  /** WDL `type`. */
  type: string;
  /** WDL `kind` discriminator, when the type needs one (e.g. Request/Http). */
  operationKind?: string;
  category: OperationCategory;
  /** Canvas accent category from the shared node kit. */
  canvasCategory: CanvasNodeCategory;
  description: string;
  /** True for trigger operations (they go in `definition.triggers`). */
  isTrigger?: boolean;
  /** True when the operation nests child actions (If/Foreach/Until/Scope/Switch). */
  isScope?: boolean;
  /** The operation body stamped on drop (minus runAfter, which the graph owns). */
  template: () => WdlOperation;
  fields: OperationField[];
  learnMore: string;
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

export const OPERATION_CATALOG: OperationDef[] = [
  // ── Triggers ──────────────────────────────────────────────────────────────
  {
    id: 'trigger-recurrence',
    label: 'Recurrence',
    type: 'Recurrence',
    category: 'triggers',
    canvasCategory: 'control',
    description: 'Run the workflow on a schedule.',
    isTrigger: true,
    template: () => ({
      type: 'Recurrence',
      recurrence: { frequency: 'Day', interval: 1, timeZone: 'UTC' },
    }),
    fields: [
      { path: 'recurrence.frequency', label: 'Frequency', kind: 'select', options: ['Second', 'Minute', 'Hour', 'Day', 'Week', 'Month'], required: true },
      { path: 'recurrence.interval', label: 'Interval', kind: 'number', required: true, help: 'How many frequency units between runs.' },
      { path: 'recurrence.timeZone', label: 'Time zone', kind: 'text', placeholder: 'UTC' },
      { path: 'recurrence.startTime', label: 'Start time', kind: 'text', placeholder: '2026-01-01T00:00:00Z' },
    ],
    learnMore: 'https://learn.microsoft.com/azure/connectors/connectors-native-recurrence',
  },
  {
    id: 'trigger-request',
    label: 'When an HTTP request is received',
    type: 'Request',
    operationKind: 'Http',
    category: 'triggers',
    canvasCategory: 'external',
    description: 'Expose a callable HTTPS endpoint that starts the workflow.',
    isTrigger: true,
    template: () => ({
      type: 'Request',
      kind: 'Http',
      inputs: { schema: {} },
    }),
    fields: [
      { path: 'inputs.method', label: 'Method', kind: 'select', options: HTTP_METHODS, help: 'Leave blank to accept any method.' },
      { path: 'inputs.relativePath', label: 'Relative path', kind: 'text', placeholder: 'orders/{id}' },
      { path: 'inputs.schema', label: 'Request body JSON schema', kind: 'json', help: 'Drives the dynamic content picker for downstream steps.' },
    ],
    learnMore: 'https://learn.microsoft.com/azure/connectors/connectors-native-reqres',
  },

  // ── HTTP & requests ───────────────────────────────────────────────────────
  {
    id: 'action-http',
    label: 'HTTP',
    type: 'Http',
    category: 'http',
    canvasCategory: 'external',
    description: 'Call any HTTPS endpoint.',
    template: () => ({
      type: 'Http',
      inputs: { method: 'GET', uri: 'https://example.com/api' },
    }),
    fields: [
      { path: 'inputs.method', label: 'Method', kind: 'select', options: HTTP_METHODS, required: true },
      { path: 'inputs.uri', label: 'URI', kind: 'text', required: true, placeholder: 'https://api.contoso.com/orders' },
      { path: 'inputs.headers', label: 'Headers', kind: 'json', placeholder: '{ "content-type": "application/json" }' },
      { path: 'inputs.body', label: 'Body', kind: 'json' },
      { path: 'inputs.queries', label: 'Queries', kind: 'json' },
    ],
    learnMore: 'https://learn.microsoft.com/azure/connectors/connectors-native-http',
  },
  {
    id: 'action-response',
    label: 'Response',
    type: 'Response',
    operationKind: 'Http',
    category: 'http',
    canvasCategory: 'external',
    description: 'Reply to the caller of a Request trigger.',
    template: () => ({
      type: 'Response',
      kind: 'Http',
      inputs: { statusCode: 200, body: {} },
    }),
    fields: [
      { path: 'inputs.statusCode', label: 'Status code', kind: 'number', required: true },
      { path: 'inputs.headers', label: 'Headers', kind: 'json' },
      { path: 'inputs.body', label: 'Body', kind: 'json' },
    ],
    learnMore: 'https://learn.microsoft.com/azure/connectors/connectors-native-reqres',
  },

  // ── Data operations ───────────────────────────────────────────────────────
  {
    id: 'action-compose',
    label: 'Compose',
    type: 'Compose',
    category: 'data',
    canvasCategory: 'transform',
    description: 'Build a value from expressions and reuse it downstream.',
    template: () => ({ type: 'Compose', inputs: {} }),
    fields: [{ path: 'inputs', label: 'Inputs', kind: 'json', required: true }],
    learnMore: 'https://learn.microsoft.com/azure/logic-apps/logic-apps-perform-data-operations#compose-action',
  },
  {
    id: 'action-parsejson',
    label: 'Parse JSON',
    type: 'ParseJson',
    category: 'data',
    canvasCategory: 'transform',
    description: 'Turn a JSON string into typed, pickable properties.',
    template: () => ({ type: 'ParseJson', inputs: { content: '', schema: {} } }),
    fields: [
      { path: 'inputs.content', label: 'Content', kind: 'textarea', required: true, placeholder: "@triggerBody()" },
      { path: 'inputs.schema', label: 'Schema', kind: 'json', required: true },
    ],
    learnMore: 'https://learn.microsoft.com/azure/logic-apps/logic-apps-perform-data-operations#parse-json-action',
  },
  {
    id: 'action-select',
    label: 'Select',
    type: 'Select',
    category: 'data',
    canvasCategory: 'transform',
    description: 'Reshape every item of an array.',
    template: () => ({ type: 'Select', inputs: { from: '', select: {} } }),
    fields: [
      { path: 'inputs.from', label: 'From', kind: 'text', required: true, placeholder: '@body(\'Parse_JSON\')' },
      { path: 'inputs.select', label: 'Map', kind: 'json', required: true },
    ],
    learnMore: 'https://learn.microsoft.com/azure/logic-apps/logic-apps-perform-data-operations#select-action',
  },
  {
    id: 'action-query',
    label: 'Filter array',
    type: 'Query',
    category: 'data',
    canvasCategory: 'transform',
    description: 'Keep only the array items matching a condition.',
    template: () => ({ type: 'Query', inputs: { from: '', where: '' } }),
    fields: [
      { path: 'inputs.from', label: 'From', kind: 'text', required: true },
      { path: 'inputs.where', label: 'Where', kind: 'text', required: true, placeholder: "@greater(item()?['total'], 100)" },
    ],
    learnMore: 'https://learn.microsoft.com/azure/logic-apps/logic-apps-perform-data-operations#filter-array-action',
  },
  {
    id: 'action-join',
    label: 'Join',
    type: 'Join',
    category: 'data',
    canvasCategory: 'transform',
    description: 'Concatenate array items into a delimited string.',
    template: () => ({ type: 'Join', inputs: { from: '', joinWith: ',' } }),
    fields: [
      { path: 'inputs.from', label: 'From', kind: 'text', required: true },
      { path: 'inputs.joinWith', label: 'Join with', kind: 'text', required: true },
    ],
    learnMore: 'https://learn.microsoft.com/azure/logic-apps/logic-apps-perform-data-operations#join-action',
  },
  {
    id: 'action-table',
    label: 'Create CSV table',
    type: 'Table',
    category: 'data',
    canvasCategory: 'transform',
    description: 'Render an array as a CSV or HTML table.',
    template: () => ({ type: 'Table', inputs: { from: '', format: 'CSV' } }),
    fields: [
      { path: 'inputs.from', label: 'From', kind: 'text', required: true },
      { path: 'inputs.format', label: 'Format', kind: 'select', options: ['CSV', 'HTML'], required: true },
    ],
    learnMore: 'https://learn.microsoft.com/azure/logic-apps/logic-apps-perform-data-operations#create-csv-table-action',
  },

  // ── Control flow ──────────────────────────────────────────────────────────
  {
    id: 'action-if',
    label: 'Condition',
    type: 'If',
    category: 'control',
    canvasCategory: 'control',
    description: 'Branch on a condition — run one set of steps or another.',
    isScope: true,
    template: () => ({
      type: 'If',
      expression: { and: [{ equals: ['', ''] }] },
      actions: {},
      else: { actions: {} },
    }),
    fields: [{ path: 'expression', label: 'Condition', kind: 'json', required: true }],
    learnMore: 'https://learn.microsoft.com/azure/logic-apps/logic-apps-control-flow-conditional-statement',
  },
  {
    id: 'action-switch',
    label: 'Switch',
    type: 'Switch',
    category: 'control',
    canvasCategory: 'control',
    description: 'Pick a branch by matching a value against cases.',
    isScope: true,
    template: () => ({
      type: 'Switch',
      expression: '',
      cases: {},
      default: { actions: {} },
    }),
    fields: [{ path: 'expression', label: 'Switch on', kind: 'text', required: true }],
    learnMore: 'https://learn.microsoft.com/azure/logic-apps/logic-apps-control-flow-switch-statement',
  },
  {
    id: 'action-foreach',
    label: 'For each',
    type: 'Foreach',
    category: 'control',
    canvasCategory: 'iteration',
    description: 'Repeat steps for every item in an array.',
    isScope: true,
    template: () => ({ type: 'Foreach', foreach: '', actions: {} }),
    fields: [{ path: 'foreach', label: 'Select an output from previous steps', kind: 'text', required: true }],
    learnMore: 'https://learn.microsoft.com/azure/logic-apps/logic-apps-control-flow-loops',
  },
  {
    id: 'action-until',
    label: 'Until',
    type: 'Until',
    category: 'control',
    canvasCategory: 'iteration',
    description: 'Repeat steps until a condition becomes true.',
    isScope: true,
    template: () => ({
      type: 'Until',
      expression: '',
      limit: { count: 60, timeout: 'PT1H' },
      actions: {},
    }),
    fields: [
      { path: 'expression', label: 'Loop until', kind: 'text', required: true },
      { path: 'limit.count', label: 'Count limit', kind: 'number' },
      { path: 'limit.timeout', label: 'Timeout (ISO 8601)', kind: 'text', placeholder: 'PT1H' },
    ],
    learnMore: 'https://learn.microsoft.com/azure/logic-apps/logic-apps-control-flow-loops#until-loop',
  },
  {
    id: 'action-scope',
    label: 'Scope',
    type: 'Scope',
    category: 'control',
    canvasCategory: 'control',
    description: 'Group steps so they succeed or fail together.',
    isScope: true,
    template: () => ({ type: 'Scope', actions: {} }),
    fields: [],
    learnMore: 'https://learn.microsoft.com/azure/logic-apps/logic-apps-control-flow-run-steps-group-scopes',
  },
  {
    id: 'action-wait',
    label: 'Delay',
    type: 'Wait',
    category: 'control',
    canvasCategory: 'control',
    description: 'Pause the workflow for an interval.',
    template: () => ({ type: 'Wait', inputs: { interval: { count: 1, unit: 'Minute' } } }),
    fields: [
      { path: 'inputs.interval.count', label: 'Count', kind: 'number', required: true },
      { path: 'inputs.interval.unit', label: 'Unit', kind: 'select', options: ['Second', 'Minute', 'Hour', 'Day'], required: true },
    ],
    learnMore: 'https://learn.microsoft.com/azure/connectors/connectors-native-delay',
  },
  {
    id: 'action-terminate',
    label: 'Terminate',
    type: 'Terminate',
    category: 'control',
    canvasCategory: 'control',
    description: 'Stop the run and set its final status.',
    template: () => ({ type: 'Terminate', inputs: { runStatus: 'Succeeded' } }),
    fields: [
      { path: 'inputs.runStatus', label: 'Status', kind: 'select', options: ['Succeeded', 'Failed', 'Cancelled'], required: true },
      { path: 'inputs.runError.message', label: 'Error message', kind: 'text', help: 'Used when status is Failed.' },
    ],
    learnMore: 'https://learn.microsoft.com/azure/logic-apps/logic-apps-workflow-actions-triggers#terminate-action',
  },

  // ── Variables ─────────────────────────────────────────────────────────────
  {
    id: 'action-initvariable',
    label: 'Initialize variable',
    type: 'InitializeVariable',
    category: 'variables',
    canvasCategory: 'transform',
    description: 'Declare a workflow variable.',
    template: () => ({
      type: 'InitializeVariable',
      inputs: { variables: [{ name: 'counter', type: 'Integer', value: 0 }] },
    }),
    fields: [{ path: 'inputs.variables', label: 'Variables', kind: 'json', required: true }],
    learnMore: 'https://learn.microsoft.com/azure/logic-apps/logic-apps-create-variables-store-values',
  },
  {
    id: 'action-setvariable',
    label: 'Set variable',
    type: 'SetVariable',
    category: 'variables',
    canvasCategory: 'transform',
    description: 'Assign a new value to an existing variable.',
    template: () => ({ type: 'SetVariable', inputs: { name: '', value: '' } }),
    fields: [
      { path: 'inputs.name', label: 'Name', kind: 'text', required: true },
      { path: 'inputs.value', label: 'Value', kind: 'text', required: true },
    ],
    learnMore: 'https://learn.microsoft.com/azure/logic-apps/logic-apps-create-variables-store-values#set-variable-action',
  },
  {
    id: 'action-appendarray',
    label: 'Append to array variable',
    type: 'AppendToArrayVariable',
    category: 'variables',
    canvasCategory: 'transform',
    description: 'Push a value onto an array variable.',
    template: () => ({ type: 'AppendToArrayVariable', inputs: { name: '', value: '' } }),
    fields: [
      { path: 'inputs.name', label: 'Name', kind: 'text', required: true },
      { path: 'inputs.value', label: 'Value', kind: 'text', required: true },
    ],
    learnMore: 'https://learn.microsoft.com/azure/logic-apps/logic-apps-create-variables-store-values#append-to-array-variable-action',
  },
  {
    id: 'action-incrementvariable',
    label: 'Increment variable',
    type: 'IncrementVariable',
    category: 'variables',
    canvasCategory: 'transform',
    description: 'Add to a numeric variable.',
    template: () => ({ type: 'IncrementVariable', inputs: { name: '', value: 1 } }),
    fields: [
      { path: 'inputs.name', label: 'Name', kind: 'text', required: true },
      { path: 'inputs.value', label: 'Increment by', kind: 'number', required: true },
    ],
    learnMore: 'https://learn.microsoft.com/azure/logic-apps/logic-apps-create-variables-store-values#increment-variable-action',
  },
];

const BY_TYPE = new Map<string, OperationDef>();
for (const op of OPERATION_CATALOG) {
  // Key on `type` + `kind` so Request/Http and Response/Http stay distinct from
  // any future same-typed operation with a different kind.
  BY_TYPE.set(operationKey(op.type, op.operationKind), op);
  if (!BY_TYPE.has(op.type)) BY_TYPE.set(op.type, op);
}

export function operationKey(type: string | undefined, kind?: string): string {
  return kind ? `${type || ''}::${kind}` : String(type || '');
}

/** Look up the catalog entry for a WDL operation type (+ optional kind). */
export function findOperation(type: string | undefined, kind?: string): OperationDef | undefined {
  if (!type) return undefined;
  return BY_TYPE.get(operationKey(type, kind)) || BY_TYPE.get(type);
}

export function findOperationById(id: string): OperationDef | undefined {
  return OPERATION_CATALOG.find((o) => o.id === id);
}

/**
 * Canvas accent category for a WDL operation type. Unknown types (a workflow
 * authored in the Azure portal using a managed connector, say) fall back to
 * 'external' so they still render as a proper node instead of breaking the
 * canvas — the designer shows them read-only with a "configure in code view"
 * affordance rather than pretending it can edit them.
 */
export function canvasCategoryForType(type: string | undefined, kind?: string): CanvasNodeCategory {
  return findOperation(type, kind)?.canvasCategory ?? 'external';
}

/** True when Loom's inspector can render typed controls for this operation. */
export function isKnownOperation(type: string | undefined, kind?: string): boolean {
  return !!findOperation(type, kind);
}

// ── dot-path get/set over an operation body (used by the inspector) ─────────

export function getPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** Immutably set a dot-path, creating intermediate objects as needed. */
export function setPath<T extends Record<string, unknown>>(obj: T, path: string, value: unknown): T {
  const segs = path.split('.');
  const clone: any = Array.isArray(obj) ? [...(obj as unknown as unknown[])] : { ...(obj || {}) };
  let cur = clone;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    const nextRaw = cur[seg];
    cur[seg] =
      nextRaw && typeof nextRaw === 'object'
        ? Array.isArray(nextRaw)
          ? [...nextRaw]
          : { ...nextRaw }
        : {};
    cur = cur[seg];
  }
  const last = segs[segs.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = value;
  return clone as T;
}
