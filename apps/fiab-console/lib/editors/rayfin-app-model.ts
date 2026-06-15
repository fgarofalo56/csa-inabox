/**
 * rayfin-app-model — pure, framework-free types + codegen/DAX helpers shared by
 * the RayfinAppEditor (client) and the rayfin-app BFF routes + model-binding lib
 * (server). No React, no Azure SDK imports here so the helpers are unit-testable
 * in a plain Node environment (vitest) and importable from both sides.
 *
 * Two concerns live here:
 *   1. The Rayfin **backend spec** (entities/services/auth) + its semantic-model
 *      binding — the faithful Microsoft Fabric-Apps "generate-artifact" surface
 *      (Loom emits the @microsoft/rayfin-core model + CLI commands; the CLI runs
 *      on the dev machine).
 *   2. The Loom-native **visual app definition** (pages → components → bindings)
 *      — the low-code app BUILDER. Each data component binds to a read view over
 *      the same Azure Analysis Services model the binding tab uses (no Fabric /
 *      Power BI dependency, per no-fabric-dependency.md). Loom runs this app
 *      definition for real via /api/items/rayfin-app/<id>/render (live AAS DAX).
 *
 * Decision (audit-T145 / audit-T84): the visual builder lives **standalone in
 * the Rayfin / Fabric-Apps surface**, NOT under Weave/Atelier. Rayfin mirrors
 * the real Fabric-Apps `--template dataapp` flow — itself a code-first + Copilot
 * codegen flow with no WYSIWYG Fabric canvas — so a Loom-hosted visual builder
 * with a real Azure runtime is the honest home. The two app-building tracks are
 * **distinct and aligned, not forked** (see docs/fiab/parity/rayfin-app.md):
 *   • Rayfin (`rayfin-app`, this surface) — read-oriented apps over a semantic
 *     model; write-back forms run in the *deployed* Rayfin app (AAS is read-only).
 *   • Atelier (`workshop-app`) — the Palantir-Workshop-equivalent that does
 *     **real in-Loom CRUD** over the ontology's bound Synapse warehouse
 *     (app/api/items/workshop-app/[id]/run-action). For write-back inside Loom,
 *     use Atelier; a future Atelier surface should reuse the helpers here rather
 *     than fork them.
 */

// ---------------------------------------------------------------------------
// Backend spec (generate-artifact surface)
// ---------------------------------------------------------------------------

export type FieldType = 'text' | 'boolean' | 'date' | 'number';
export interface EntityField { name: string; type: FieldType }
export interface RayfinEntity { name: string; fields: EntityField[] }

/** A bound semantic-model read view: which measures + group-by the app shows. */
export interface ModelBinding {
  /** AAS tabular database (semantic model) name; '' = not bound. */
  model: string;
  /** Selected measure names from the bound model. */
  measures: string[];
  /** Selected group-by columns encoded as "table|column". */
  groupBy: string[];
  /** Max rows the read view returns. */
  topN: number;
}

// ---------------------------------------------------------------------------
// Visual app definition (the low-code BUILDER)
// ---------------------------------------------------------------------------

export type ComponentKind = 'table' | 'metric' | 'chart' | 'form' | 'text';

/** A data component's read-view selection over the app's bound model. */
export interface ComponentBinding {
  measures: string[];
  /** "table|column" keys (same encoding as ModelBinding.groupBy). */
  groupBy: string[];
  topN: number;
}

export interface RayfinComponent {
  id: string;
  kind: ComponentKind;
  title: string;
  /** Data binding for table/metric/chart. */
  binding?: ComponentBinding;
  /** For 'form': the Rayfin entity name the generated app writes to. */
  entity?: string;
  /** For 'text': static markdown/plain content shown on the page. */
  text?: string;
}

export interface RayfinPage {
  id: string;
  name: string;
  components: RayfinComponent[];
}

export interface RayfinAppDefinition {
  /** The semantic model every data component reads from (mirrors spec.binding.model). */
  model: string;
  pages: RayfinPage[];
}

export interface RayfinSpec {
  appName: string;
  workspaceName: string;
  services: { database: boolean; storage: boolean };
  auth: 'fabric';
  staticHosting: boolean;
  entities: RayfinEntity[];
  /** Model binding (Build 2026 #28). Optional — the general Rayfin case omits it. */
  binding?: ModelBinding;
  /** Visual app definition (audit-T145 low-code builder). Optional. */
  app?: RayfinAppDefinition;
}

export const DEFAULT_BINDING: ModelBinding = { model: '', measures: [], groupBy: [], topN: 100 };

export const DEFAULT_APP: RayfinAppDefinition = { model: '', pages: [] };

export const DEFAULT_SPEC: RayfinSpec = {
  appName: 'my-app',
  workspaceName: '',
  services: { database: true, storage: false },
  auth: 'fabric',
  staticHosting: true,
  entities: [{ name: 'Todo', fields: [{ name: 'title', type: 'text' }, { name: 'done', type: 'boolean' }, { name: 'dueDate', type: 'date' }] }],
  binding: { ...DEFAULT_BINDING },
};

export const COMPONENT_KINDS: readonly ComponentKind[] = ['table', 'metric', 'chart', 'form', 'text'];

/** True when a component reads from the bound model (vs. form/text). */
export function isDataComponent(kind: ComponentKind): boolean {
  return kind === 'table' || kind === 'metric' || kind === 'chart';
}

// ---------------------------------------------------------------------------
// DAX helpers (shared by editor preview + BFF execution)
// ---------------------------------------------------------------------------

/** Decode the "table|column" group-by key. */
export function gbParse(key: string): { table: string; column: string } {
  const i = key.indexOf('|');
  return i < 0 ? { table: '', column: key } : { table: key.slice(0, i), column: key.slice(i + 1) };
}
export function gbKey(table: string, column: string): string { return `${table}|${column}`; }

/** Build the DAX read-view query for a measures + group-by selection. */
export function buildBindingDax(b: Pick<ModelBinding, 'measures' | 'groupBy' | 'topN'>): string {
  const groupRefs = (b.groupBy || []).map((k) => { const { table, column } = gbParse(k); return `'${table.replace(/'/g, "''")}'[${column.replace(/]/g, '')}]`; });
  const measureProj = (b.measures || []).map((m) => `"${m.replace(/"/g, '""')}", [${m.replace(/]/g, '')}]`);
  if (groupRefs.length === 0 && measureProj.length === 0) return '// select measures or group-by fields to bind';
  if (groupRefs.length === 0) return `EVALUATE\nROW(${measureProj.join(', ')})`;
  const topN = b.topN > 0 ? Math.min(b.topN, 1000) : 100;
  const inner = measureProj.length
    ? `SUMMARIZECOLUMNS(\n  ${groupRefs.join(',\n  ')},\n  ${measureProj.join(',\n  ')}\n)`
    : `SUMMARIZECOLUMNS(\n  ${groupRefs.join(',\n  ')}\n)`;
  return `EVALUATE\nTOPN(\n  ${topN},\n  ${inner}\n)`;
}

/** Build the DAX for one visual component (table/metric/chart). */
export function buildComponentDax(c: RayfinComponent): string {
  if (!isDataComponent(c.kind) || !c.binding) return '// non-data component (no query)';
  return buildBindingDax(c.binding);
}

// ---------------------------------------------------------------------------
// @microsoft/rayfin-core model + CLI codegen (generate-artifact surface)
// ---------------------------------------------------------------------------

const DECO: Record<FieldType, string> = { text: 'text', boolean: 'boolean', date: 'date', number: 'number' };
const TS_TYPE: Record<FieldType, string> = { text: 'string', boolean: 'boolean', date: 'Date', number: 'number' };
export { DECO, TS_TYPE };

export function pascal(s: string): string {
  return (s || 'Entity').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('') || 'Entity';
}

export function generateModel(spec: RayfinSpec): string {
  const used = Array.from(new Set(spec.entities.flatMap((e) => e.fields.map((f) => DECO[f.type])))).sort();
  const imports = ['entity', ...used].join(', ');
  const blocks = spec.entities.map((e) => {
    const cls = pascal(e.name);
    const props = e.fields.map((f) => `  @${DECO[f.type]}() ${f.name || 'field'}!: ${TS_TYPE[f.type]};`).join('\n');
    return `@entity()\nexport class ${cls} {\n${props || '  // add fields'}\n}`;
  }).join('\n\n');
  return `// rayfin/model.ts — generated by CSA Loom (verify against the current @microsoft/rayfin-core API)\nimport { ${imports} } from '@microsoft/rayfin-core';\n\n${blocks}\n`;
}

/**
 * Generate the model-bound data connector: a typed service the deployed app
 * calls to read from the bound semantic model. It issues the exact DAX the
 * preview validated, over the same Azure Analysis Services data-plane endpoint
 * Loom queries (no Fabric/Power BI dependency).
 */
export function generateConnector(spec: RayfinSpec): string {
  const b = spec.binding;
  if (!b || !b.model) {
    return '// No semantic model bound — bind one in the "Model binding" panel to generate this connector.';
  }
  const dax = buildBindingDax(b);
  const daxLiteral = dax.split('\n').map((l) => `  ${JSON.stringify(l)}`).join(',\n');
  return [
    `// rayfin/data/model-view.ts — generated by CSA Loom`,
    `// Reads from the bound semantic model "${b.model}" via DAX (Azure Analysis`,
    `// Services data-plane; AAS_SERVER = "<region>.asazure.windows.net/<server>").`,
    `// Auth: the app's managed identity / Entra SSO (server admin on the AAS server).`,
    `import { aasExecuteDax } from './aas-xmla'; // thin XMLA-over-HTTP helper (mirrors Loom's lib/azure/aas-xmla)`,
    ``,
    `export const BOUND_MODEL = ${JSON.stringify(b.model)};`,
    ``,
    `// The exact DAX validated in CSA Loom's live preview for this read view.`,
    `export const MODEL_VIEW_DAX = [`,
    daxLiteral,
    `].join('\\n');`,
    ``,
    `/** Returns the read view's rows ({ column: value }[]) from the bound model. */`,
    `export async function readModelView(): Promise<Record<string, unknown>[]> {`,
    `  const { columns, rows } = await aasExecuteDax(process.env.AAS_SERVER!, BOUND_MODEL, MODEL_VIEW_DAX);`,
    `  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));`,
    `}`,
    ``,
  ].join('\n');
}

export function generateCommands(spec: RayfinSpec): string {
  const services = [spec.services.database ? 'db' : '', spec.services.storage ? 'storage' : ''].filter(Boolean).join(',') || 'db';
  const ws = spec.workspaceName?.trim();
  const bound = spec.binding?.model;
  const lines = [
    '# 1) Scaffold a Rayfin app (creates the project + Fabric workspace binding)',
    `npm create @microsoft/rayfin@latest ${spec.appName}${ws ? ` --workspace "${ws}"` : ''}`,
    `cd ${spec.appName}`,
    '',
    '# 2) (or, in an existing project) initialize Rayfin with the services above',
    `npx rayfin init ${spec.appName} --services ${services} --auth-methods ${spec.auth}${spec.staticHosting ? ' --static-hosting' : ''}`,
    '',
    '# 3) Paste the generated entities into rayfin/model.ts',
  ];
  if (bound) {
    lines.push(
      '',
      '# 4) Add the model-bound read view (paste rayfin/data/model-view.ts) and set the',
      `#    AAS data-plane address for the bound model "${bound}":`,
      'export AAS_SERVER="<region>.asazure.windows.net/<server>"   # the same model CSA Loom queried',
      '',
      '# 5) Deploy to Fabric',
      'npx rayfin up',
    );
  } else {
    lines.push('', '# 4) Deploy to Fabric', 'npx rayfin up');
  }
  return lines.join('\n');
}

/**
 * Generate a typed `rayfin/app.config.ts` artifact from the visual app
 * definition: a deterministic serialization of pages → components → bindings
 * that the deployed Rayfin app's UI layer consumes. Mirrors the deploy-planner
 * "emit bicep" pattern — a real artifact, not a stub.
 */
export function generateAppConfig(app: RayfinAppDefinition | undefined): string {
  if (!app || app.pages.length === 0) {
    return '// No pages yet — add a page + components in the App builder tab to generate this config.';
  }
  const pages = app.pages.map((p) => {
    const comps = p.components.map((c) => {
      const base: Record<string, unknown> = { id: c.id, kind: c.kind, title: c.title };
      if (isDataComponent(c.kind) && c.binding) {
        base.dax = buildComponentDax(c);
        base.binding = { measures: c.binding.measures, groupBy: c.binding.groupBy, topN: c.binding.topN };
      }
      if (c.kind === 'form') base.entity = c.entity || '';
      if (c.kind === 'text') base.text = c.text || '';
      return base;
    });
    return { id: p.id, name: p.name, components: comps };
  });
  const json = JSON.stringify({ model: app.model, pages }, null, 2);
  return [
    `// rayfin/app.config.ts — generated by CSA Loom (audit-T145 visual builder).`,
    `// Data components read from the bound semantic model "${app.model || '(unbound)'}" via the`,
    `// DAX in each component's "dax" field (Azure Analysis Services data-plane).`,
    `export interface RayfinAppConfig {`,
    `  model: string;`,
    `  pages: {`,
    `    id: string; name: string;`,
    `    components: { id: string; kind: string; title: string; dax?: string; binding?: unknown; entity?: string; text?: string }[];`,
    `  }[];`,
    `}`,
    ``,
    `export const APP_CONFIG: RayfinAppConfig = ${json};`,
    ``,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// App-definition construction + validation
// ---------------------------------------------------------------------------

let _seq = 0;
/** Stable-ish id generator for client-built components/pages. */
export function newId(prefix: string): string {
  _seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

export function emptyComponent(kind: ComponentKind, entityName = ''): RayfinComponent {
  const titles: Record<ComponentKind, string> = {
    table: 'Table', metric: 'Metric', chart: 'Chart', form: 'Form', text: 'Text',
  };
  const c: RayfinComponent = { id: newId('cmp'), kind, title: titles[kind] };
  if (isDataComponent(kind)) c.binding = { measures: [], groupBy: [], topN: kind === 'metric' ? 1 : 50 };
  if (kind === 'form') c.entity = entityName;
  if (kind === 'text') c.text = 'Describe this page…';
  return c;
}

export function emptyPage(name = 'Page 1'): RayfinPage {
  return { id: newId('page'), name, components: [] };
}

/**
 * Scaffold a starter app definition from a bound model + its first measure /
 * group-by — used by the create wizard so a new app is non-empty and renders
 * live data immediately.
 */
export function scaffoldAppDefinition(model: string, firstMeasure?: string, firstGroupBy?: string): RayfinAppDefinition {
  const page = emptyPage('Overview');
  const measures = firstMeasure ? [firstMeasure] : [];
  const groupBy = firstGroupBy ? [firstGroupBy] : [];
  const metric = emptyComponent('metric');
  metric.title = firstMeasure || 'Metric';
  metric.binding = { measures, groupBy: [], topN: 1 };
  const table = emptyComponent('table');
  table.title = 'Details';
  table.binding = { measures, groupBy, topN: 50 };
  page.components = [metric, table];
  if (groupBy.length && measures.length) {
    const chart = emptyComponent('chart');
    chart.title = `${firstMeasure} by ${gbParse(firstGroupBy!).column}`;
    chart.binding = { measures, groupBy, topN: 20 };
    page.components.push(chart);
  }
  return { model, pages: [page] };
}

// ---------------------------------------------------------------------------
// Wizard templates (audit-T145) — the low-code builder ships several page
// wizards, not just the Overview scaffold. Each template builds ONE page that
// the editor appends to the current app definition (so an operator can stack a
// KPI dashboard, a drill page, and an entity form into a multi-page app).
// ---------------------------------------------------------------------------

export type WizardTemplateId = 'overview' | 'kpi-dashboard' | 'detail-drill' | 'entity-form';

export interface WizardTemplate {
  id: WizardTemplateId;
  name: string;
  description: string;
  /** Which inputs this template collects from the operator. */
  needs: { measure?: boolean; measures?: boolean; groupBy?: boolean; entity?: boolean };
}

export const WIZARD_TEMPLATES: readonly WizardTemplate[] = [
  { id: 'overview', name: 'Overview page', description: 'A metric, a details table, and a chart from one measure + category.', needs: { measure: true, groupBy: true } },
  { id: 'kpi-dashboard', name: 'KPI dashboard', description: 'One metric tile per selected measure — an at-a-glance scorecard.', needs: { measures: true } },
  { id: 'detail-drill', name: 'Detail + drill', description: 'A category chart over a detail table for drill-down analysis.', needs: { measure: true, groupBy: true } },
  { id: 'entity-form', name: 'Entity form', description: 'A heading + a create/edit form bound to one of your entities.', needs: { entity: true } },
];

/** Inputs a wizard collects; only the fields a template `needs` are read. */
export interface WizardInput {
  template: WizardTemplateId;
  model: string;
  /** Single measure (overview / detail-drill). */
  measure?: string;
  /** Multiple measures (kpi-dashboard). */
  measures?: string[];
  /** Category group-by key "table|column" (overview / detail-drill). */
  groupBy?: string;
  /** Entity name (entity-form). */
  entity?: string;
  /** Optional explicit page name. */
  pageName?: string;
}

/**
 * Build a single page from a wizard template. Pure + deterministic so the editor
 * can append it and the unit tests can assert its shape. Every data component is
 * a typed `RayfinComponent` with a real binding — no freeform JSON
 * (loom-no-freeform-config).
 */
export function buildTemplatePage(input: WizardInput): RayfinPage {
  switch (input.template) {
    case 'kpi-dashboard': {
      const page = emptyPage(input.pageName || 'KPI dashboard');
      const measures = (input.measures && input.measures.length ? input.measures : (input.measure ? [input.measure] : []));
      page.components = measures.map((m) => {
        const c = emptyComponent('metric');
        c.title = m;
        c.binding = { measures: [m], groupBy: [], topN: 1 };
        return c;
      });
      return page;
    }
    case 'detail-drill': {
      const page = emptyPage(input.pageName || 'Details');
      const measures = input.measure ? [input.measure] : [];
      const groupBy = input.groupBy ? [input.groupBy] : [];
      const chart = emptyComponent('chart');
      chart.title = input.measure && input.groupBy ? `${input.measure} by ${gbParse(input.groupBy).column}` : 'Chart';
      chart.binding = { measures, groupBy, topN: 20 };
      const table = emptyComponent('table');
      table.title = 'Detail rows';
      table.binding = { measures, groupBy, topN: 100 };
      page.components = [chart, table];
      return page;
    }
    case 'entity-form': {
      const page = emptyPage(input.pageName || (input.entity ? `${input.entity} form` : 'Form'));
      const heading = emptyComponent('text');
      heading.title = 'Heading';
      heading.text = input.entity ? `Create or edit a ${input.entity} record.` : 'Describe this form…';
      const form = emptyComponent('form', input.entity || '');
      form.title = input.entity ? `${input.entity} form` : 'Form';
      page.components = [heading, form];
      return page;
    }
    case 'overview':
    default:
      // Reuse the canonical Overview scaffold's first page.
      return scaffoldAppDefinition(input.model, input.measure, input.groupBy).pages[0];
  }
}

/** Build a brand-new single-page app definition from a wizard template. */
export function scaffoldFromTemplate(input: WizardInput): RayfinAppDefinition {
  return { model: input.model, pages: [buildTemplatePage(input)] };
}

/**
 * Append a template page to an existing app definition (or create the app when
 * none exists). The model is taken from the bound model so every data component
 * resolves against the same semantic model.
 */
export function appendTemplatePage(
  existing: RayfinAppDefinition | undefined,
  input: WizardInput,
): RayfinAppDefinition {
  const page = buildTemplatePage(input);
  const pages = existing && Array.isArray(existing.pages) ? existing.pages : [];
  return { model: input.model, pages: [...pages, page] };
}

export interface AppDefIssue { level: 'error' | 'warn'; message: string }

/** Validate an app definition; returns issues (errors block a clean render). */
export function validateAppDefinition(app: RayfinAppDefinition | undefined): AppDefIssue[] {
  const issues: AppDefIssue[] = [];
  if (!app || app.pages.length === 0) {
    issues.push({ level: 'warn', message: 'No pages yet — add a page to build your app.' });
    return issues;
  }
  if (!app.model) issues.push({ level: 'warn', message: 'No semantic model bound — data components will have no source.' });
  const ids = new Set<string>();
  for (const p of app.pages) {
    if (!p.name.trim()) issues.push({ level: 'warn', message: 'A page has no name.' });
    if (p.components.length === 0) issues.push({ level: 'warn', message: `Page "${p.name}" has no components.` });
    for (const c of p.components) {
      if (ids.has(c.id)) issues.push({ level: 'error', message: `Duplicate component id "${c.id}".` });
      ids.add(c.id);
      if (isDataComponent(c.kind)) {
        const b = c.binding;
        if (!b || (b.measures.length === 0 && b.groupBy.length === 0)) {
          issues.push({ level: 'warn', message: `"${c.title}" has no measures or group-by selected.` });
        }
        if (c.kind === 'chart' && b && (b.measures.length === 0 || b.groupBy.length === 0)) {
          issues.push({ level: 'warn', message: `Chart "${c.title}" needs at least one measure and one group-by (category).` });
        }
      }
      if (c.kind === 'form' && !c.entity) issues.push({ level: 'warn', message: `Form "${c.title}" is not bound to an entity.` });
    }
  }
  return issues;
}
