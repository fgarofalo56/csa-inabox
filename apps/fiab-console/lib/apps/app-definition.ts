/**
 * app-definition — the shared low-code app schema for CSA Loom's visual app
 * builders.
 *
 * DECISION (audit-T145, grounded in the real product shape):
 *   - The visual, multi-page low-code BUILDER lives in **Atelier**
 *     (item type `workshop-app`, audit-T51) — pages, a component palette,
 *     field-level data bindings, and write-back actions, running on a real
 *     Azure-native backend (Synapse dedicated SQL pool for ontology-bound
 *     entities; Azure Analysis Services for semantic-model-bound pages).
 *   - **Rayfin** (`rayfin-app`) stays **code-first**, matching Microsoft's real
 *     Fabric Apps / Rayfin preview, which has NO visual page/component designer
 *     (it is `npm create @microsoft/rayfin` + a coding agent). Forcing a canvas
 *     onto Rayfin would be vaporware that contradicts the product.
 *   - ALIGNMENT: both builders share THIS one schema + store (the Cosmos item's
 *     `state.appDef`). A Rayfin model binding can be lifted into an Atelier page
 *     (`appDefFromRayfinBinding`), and an Atelier `aas-model` page reads from the
 *     same Azure Analysis Services model a Rayfin app binds — one semantic layer,
 *     two front doors.
 *
 * This module is PURE + dependency-free (no React / Fluent / Azure SDK) so the
 * schema, migration, and codegen are vitest-coverable without the editor bundle.
 * Per .claude/rules/no-fabric-dependency.md every binding here is Azure-native by
 * default (Synapse / AAS); nothing requires a Fabric or Power BI workspace.
 */

/** What a component renders. */
export type ComponentKind = 'table' | 'metric' | 'text';

/** Where a component reads its data. Both are Azure-native (no Fabric). */
export type BindingSource = 'ontology-entity' | 'aas-model';

/**
 * Read an ontology entity type's rows from its bound Synapse warehouse table
 * (the `/api/items/workshop-app/[id]/data` route, op `list` / `aggregate`).
 */
export interface OntologyEntityBindingRef {
  source: 'ontology-entity';
  /** Ontology object type (== warehouse table name). */
  entity: string;
  /** Optional projected columns; empty = all. */
  columns?: string[];
  /** Max rows for a list view (1..1000). */
  top?: number;
  /** When set, render an aggregate (COUNT(*) grouped by these columns). */
  groupBy?: string[];
}

/**
 * Read from an Azure Analysis Services semantic model via DAX — the SAME
 * Azure-native model a Rayfin app binds (the `/api/items/rayfin-app/preview`
 * route). `groupBy` keys are encoded "table|column".
 */
export interface AasModelBindingRef {
  source: 'aas-model';
  /** AAS tabular database (semantic model) name. */
  model: string;
  /** Selected measure names. */
  measures: string[];
  /** Group-by columns encoded "table|column". */
  groupBy: string[];
  /** Max rows (1..1000). */
  topN: number;
}

export type ComponentBinding = OntologyEntityBindingRef | AasModelBindingRef;

/** A single component on a page. */
export interface AppComponent {
  id: string;
  kind: ComponentKind;
  title: string;
  /** Data binding (table / metric). Absent for a `text` component. */
  binding?: ComponentBinding;
  /** Static copy for a `text` component. */
  text?: string;
}

/** A page in the app. */
export interface AppPage {
  id: string;
  name: string;
  components: AppComponent[];
}

/** A write-back action over an ontology entity type (real INSERT/UPDATE). */
export interface AppAction {
  id: string;
  label: string;
  kind: 'create' | 'update';
  entity: string;
}

/** The full app definition persisted on the Cosmos item's `state.appDef`. */
export interface AppDefinition {
  /** Schema version for forward migration. */
  version: 1;
  pages: AppPage[];
  actions: AppAction[];
}

export const APP_DEF_VERSION = 1 as const;

export const EMPTY_APP_DEF: AppDefinition = { version: APP_DEF_VERSION, pages: [], actions: [] };

/** Monotonic-ish id generator for builder-created entities (UI only). */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const COMPONENT_KINDS: ComponentKind[] = ['table', 'metric', 'text'];

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}
function clampTop(v: unknown, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.round(n), 1), 1000);
}

/** Coerce a persisted/unknown binding into a clean ComponentBinding, or undefined. */
export function normalizeBinding(raw: unknown): ComponentBinding | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const b = raw as Record<string, unknown>;
  if (b.source === 'aas-model') {
    const model = asString(b.model);
    if (!model) return undefined;
    return {
      source: 'aas-model',
      model,
      measures: asStringArray(b.measures),
      groupBy: asStringArray(b.groupBy),
      topN: clampTop(b.topN, 100),
    };
  }
  // default → ontology-entity
  const entity = asString(b.entity);
  if (!entity) return undefined;
  const out: OntologyEntityBindingRef = { source: 'ontology-entity', entity };
  const cols = asStringArray(b.columns);
  if (cols.length) out.columns = cols;
  const groupBy = asStringArray(b.groupBy);
  if (groupBy.length) out.groupBy = groupBy;
  out.top = clampTop(b.top, 50);
  return out;
}

function normalizeComponent(raw: unknown, i: number): AppComponent | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const kind: ComponentKind = COMPONENT_KINDS.includes(c.kind as ComponentKind) ? (c.kind as ComponentKind) : 'table';
  const comp: AppComponent = {
    id: asString(c.id) || newId('cmp'),
    kind,
    title: asString(c.title) || `Component ${i + 1}`,
  };
  if (kind === 'text') {
    comp.text = asString(c.text);
  } else {
    const binding = normalizeBinding(c.binding);
    if (binding) comp.binding = binding;
  }
  return comp;
}

function normalizePage(raw: unknown, i: number): AppPage | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const components = (Array.isArray(p.components) ? p.components : [])
    .map((c, ci) => normalizeComponent(c, ci))
    .filter((c): c is AppComponent => c !== null);
  return { id: asString(p.id) || newId('pg'), name: asString(p.name) || `Page ${i + 1}`, components };
}

function normalizeAction(raw: unknown): AppAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const entity = asString(a.entity);
  const label = asString(a.label);
  if (!entity || !label) return null;
  return { id: asString(a.id) || newId('act'), label, kind: a.kind === 'update' ? 'update' : 'create', entity };
}

/** Coerce any persisted `appDef` value into a clean AppDefinition. */
export function normalizeAppDef(raw: unknown): AppDefinition {
  if (!raw || typeof raw !== 'object') return { version: APP_DEF_VERSION, pages: [], actions: [] };
  const d = raw as Record<string, unknown>;
  const pages = (Array.isArray(d.pages) ? d.pages : [])
    .map((p, i) => normalizePage(p, i))
    .filter((p): p is AppPage => p !== null);
  const actions = (Array.isArray(d.actions) ? d.actions : [])
    .map((a) => normalizeAction(a))
    .filter((a): a is AppAction => a !== null);
  return { version: APP_DEF_VERSION, pages, actions };
}

/**
 * Forward-migrate a workshop-app's persisted `state` to an AppDefinition.
 *
 * - If `state.appDef` exists, normalize and return it (the new format).
 * - Otherwise build one from the legacy v0 shape: each `state.objectViews[]`
 *   entry → a page with a single `table` component bound to that ontology
 *   entity; `state.actions[]` → the app's write-back actions. This preserves
 *   every existing Atelier app on first open with zero data loss.
 */
export function migrateWorkshopState(state: Record<string, unknown> | undefined | null): AppDefinition {
  const s = state || {};
  if (s.appDef && typeof s.appDef === 'object') return normalizeAppDef(s.appDef);

  const objectViews = asStringArray((s as Record<string, unknown>).objectViews);
  const pages: AppPage[] = objectViews.map((entity, i) => ({
    id: newId('pg'),
    name: entity || `Page ${i + 1}`,
    components: [
      { id: newId('cmp'), kind: 'table', title: `${entity} list`, binding: { source: 'ontology-entity', entity, top: 50 } },
    ],
  }));
  const actions = (Array.isArray((s as Record<string, unknown>).actions) ? (s as Record<string, unknown>).actions as unknown[] : [])
    .map((a) => normalizeAction(a))
    .filter((a): a is AppAction => a !== null);
  return { version: APP_DEF_VERSION, pages, actions };
}

/** The shape Rayfin's model-binding panel persists on its spec. */
export interface RayfinModelBinding {
  model: string;
  measures: string[];
  /** group-by columns encoded "table|column". */
  groupBy: string[];
  topN: number;
}

/**
 * Lift a Rayfin semantic-model binding into an Atelier AppDefinition page — the
 * concrete alignment between the code-first (Rayfin) and visual (Atelier)
 * builders. The generated page has a `metric` card for a pure measures
 * selection, otherwise a `table` bound to the same AAS model + DAX selection.
 * Returns null when nothing is selected (no measures and no group-by).
 */
export function appDefFromRayfinBinding(binding: RayfinModelBinding | undefined | null, appName?: string): AppDefinition | null {
  if (!binding || !binding.model) return null;
  const measures = asStringArray(binding.measures);
  const groupBy = asStringArray(binding.groupBy);
  if (measures.length === 0 && groupBy.length === 0) return null;
  const kind: ComponentKind = groupBy.length === 0 ? 'metric' : 'table';
  const title = appName?.trim() ? `${appName.trim()} — ${binding.model}` : binding.model;
  const component: AppComponent = {
    id: newId('cmp'),
    kind,
    title,
    binding: { source: 'aas-model', model: binding.model, measures, groupBy, topN: clampTop(binding.topN, 100) },
  };
  return {
    version: APP_DEF_VERSION,
    pages: [{ id: newId('pg'), name: binding.model, components: [component] }],
    actions: [],
  };
}

/** Lightweight counts for the editor header / summaries. */
export function summarizeAppDef(def: AppDefinition): { pages: number; components: number; actions: number } {
  return {
    pages: def.pages.length,
    components: def.pages.reduce((n, p) => n + p.components.length, 0),
    actions: def.actions.length,
  };
}
