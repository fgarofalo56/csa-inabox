/**
 * Pure code generators for the Palantir-class migration surfaces. Kept free of
 * React / Next so they can be unit-tested (see __tests__/palantir-codegen.test.ts)
 * and called from the BFF routes:
 *   - ontology-sdk/[id]/generate  → typed TS + Python client over an ontology
 *   - slate-app/[id]/generate     → an Azure Static Web Apps HTML/JS bundle
 *
 * Everything here is deterministic real output (no mocks): the SDK is generated
 * from the ontology's parsed object / link / action types, the DAB config is a
 * real dab-config.json shape, and the Slate + Workshop bundles are deployable
 * SWA apps (published through lib/azure/swa-publish.ts).
 */
import type { OntologyClass, OntologyEntityBinding } from './_family-utils';
import type { WorkshopWidget, WorkshopVariable, WorkshopPage } from './workshop/_workshop-model';

/** A declared write-back action type over an object type (subset of WeaveActionType). */
export interface SdkActionTypeInput {
  name: string;
  objectType: string;
  kind: 'create' | 'update' | 'delete';
  params?: string[];
}

/**
 * A single declared property of an object type, derived from the ontology's
 * entity bindings (key + writable columns) and action parameters.
 *
 * `tsType`/`pyType` are conservative: without a live `INFORMATION_SCHEMA.COLUMNS`
 * introspection of the bound Synapse/warehouse source, every declared column is
 * surfaced as a string (DAB REST returns JSON scalars; the Atelier write path
 * binds NVARCHAR(MAX) and lets T-SQL coerce). Precise scalar typing
 * (int/decimal/datetime/bool) is the P1 "typed properties" refinement.
 */
export interface OntologyPropertyDef {
  name: string;
  isKey?: boolean;
  tsType: string;
  pyType: string;
}

export interface SdkOntologyInput {
  displayName: string;
  classes: OntologyClass[];
  links: Array<{ from: string; to: string; kind: string }>;
  /**
   * Per-object-type declared properties (keyed by object-type name). When a type
   * has an entry here the generated interface emits real named members instead of
   * the untyped `[property: string]: unknown` bag. Optional for back-compat.
   */
  propertiesByType?: Record<string, OntologyPropertyDef[]>;
  /** Declared write-back action types (filtered to the included object types). */
  actionTypes?: SdkActionTypeInput[];
}

/** PascalCase a (possibly snake/space) class name for a TS interface name. */
export function pascal(name: string): string {
  return String(name || '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('') || 'Object';
}

/** The DAB REST primary-key column for an object type (default `id`). */
function keyColumnFor(typeName: string, props?: Record<string, OntologyPropertyDef[]>): string {
  const p = props?.[typeName]?.find((x) => x.isKey);
  return p?.name || 'id';
}

/**
 * Derive each object type's declared property list from the ontology's entity
 * bindings (`keyColumns` + `writableColumns`) and any action parameters. Pure +
 * deterministic + unit-testable — the real ontology metadata is the only input,
 * so this is not a mock. Object types with no binding/action metadata are omitted
 * from the result (the generator falls back to an untyped property bag for them).
 */
export function deriveObjectProperties(
  classes: OntologyClass[],
  bindings: OntologyEntityBinding[] | undefined,
  actionTypes: SdkActionTypeInput[] | undefined,
): Record<string, OntologyPropertyDef[]> {
  const out: Record<string, OntologyPropertyDef[]> = {};
  const binds = Array.isArray(bindings) ? bindings : [];
  const acts = Array.isArray(actionTypes) ? actionTypes : [];
  for (const c of Array.isArray(classes) ? classes : []) {
    const seen = new Set<string>();
    const props: OntologyPropertyDef[] = [];
    const push = (rawName: unknown, isKey = false) => {
      const name = String(rawName || '').trim();
      if (!name) return;
      const lc = name.toLowerCase();
      if (seen.has(lc)) {
        if (isKey) { const ex = props.find((p) => p.name.toLowerCase() === lc); if (ex) ex.isKey = true; }
        return;
      }
      seen.add(lc);
      props.push({ name, isKey, tsType: 'string', pyType: 'str' });
    };
    // 1. primary-key column(s) from any binding that materialises this type
    for (const b of binds) {
      if (!Array.isArray(b.entityTypes) || !b.entityTypes.includes(c.name)) continue;
      const key = b.keyColumns?.[c.name];
      if (key) push(key, true);
    }
    // 2. declared writable columns
    for (const b of binds) {
      if (!Array.isArray(b.entityTypes) || !b.entityTypes.includes(c.name)) continue;
      for (const col of b.writableColumns?.[c.name] || []) push(col);
    }
    // 3. action parameters targeting this type (covers props not in writableColumns)
    for (const a of acts) {
      if (a.objectType !== c.name) continue;
      for (const p of a.params || []) push(p);
    }
    if (props.length) out[c.name] = props;
  }
  return out;
}

/** Real dab-config.json entity map over the ontology's object types. */
export function generateDabConfig(input: SdkOntologyInput): Record<string, unknown> {
  const entities: Record<string, unknown> = {};
  const actionTypes = Array.isArray(input.actionTypes) ? input.actionTypes : [];
  for (const c of input.classes) {
    // Grant exactly the DAB actions the generated client can call: always read,
    // plus create/update/delete when the ontology declares a write-back action
    // type over this object type. Keeps the config and the client in lock-step
    // (no permission the client can't use; no client method the config blocks).
    const actions = new Set<string>(['read']);
    for (const a of actionTypes) if (a.objectType === c.name) actions.add(a.kind);
    entities[pascal(c.name)] = {
      source: { object: c.name, type: 'table' },
      rest: { enabled: true, path: `/${c.name.toLowerCase()}` },
      graphql: { enabled: true, type: { singular: pascal(c.name), plural: `${pascal(c.name)}s` } },
      permissions: [{ role: 'authenticated', actions: [...actions] }],
    };
  }
  return {
    $schema: 'https://github.com/Azure/data-api-builder/releases/latest/download/dab.draft.schema.json',
    'data-source': { 'database-type': 'mssql', 'connection-string': '@env(\'LOOM_OSDK_CONNECTION_STRING\')' },
    runtime: {
      rest: { enabled: true, path: '/api' },
      graphql: { enabled: true, path: '/graphql' },
      host: { mode: 'production', authentication: { provider: 'EntraID' } },
    },
    entities,
  };
}

/** Typed TypeScript OSDK source over the ontology object + link + action types. */
export function generateTypeScriptSdk(input: SdkOntologyInput): string {
  const props = input.propertiesByType || {};
  const actions = (Array.isArray(input.actionTypes) ? input.actionTypes : [])
    .filter((a) => input.classes.some((c) => c.name === a.objectType));
  const hasActions = actions.length > 0;
  // Object types that get a typed *Input interface (those targeted by a write action).
  const writeTargets = Array.from(new Set(actions.filter((a) => a.kind !== 'delete').map((a) => a.objectType)));

  const lines: string[] = [];
  lines.push(`// Generated Ontology SDK for "${input.displayName}" — do not edit by hand.`);
  lines.push(`// Backed by Microsoft Data API Builder (REST). Azure-native; no Fabric.`);
  lines.push('');
  for (const c of input.classes) {
    const parentLinks = input.links.filter((l) => l.from === c.name);
    const typed = props[c.name];
    if (c.description) lines.push(`/** ${c.description} */`);
    lines.push(`export interface ${pascal(c.name)} {`);
    if (typed && typed.length) {
      // Real named members from the ontology's declared key + writable columns.
      for (const p of typed) {
        if (p.isKey) { lines.push(`  /** Primary key. */`); lines.push(`  ${p.name}: ${p.tsType};`); }
        else lines.push(`  ${p.name}?: ${p.tsType};`);
      }
    } else {
      // No binding metadata for this type — fall back to an untyped property bag.
      lines.push('  id: string;');
      lines.push('  [property: string]: unknown;');
    }
    for (const l of parentLinks) lines.push(`  ${l.kind.toLowerCase()}_${l.to.toLowerCase()}?: ${pascal(l.to)};`);
    lines.push('}');
    lines.push('');
  }
  // Typed input shapes for the write actions (optional named members; key omitted).
  for (const t of writeTargets) {
    const writable = (props[t] || []).filter((p) => !p.isKey);
    lines.push(`export interface ${pascal(t)}Input {`);
    if (writable.length) for (const p of writable) lines.push(`  ${p.name}?: ${p.tsType};`);
    else lines.push('  [property: string]: unknown;');
    lines.push('}');
    lines.push('');
  }
  lines.push('export class OntologyClient {');
  lines.push('  constructor(private baseUrl: string, private token: string) {}');
  lines.push('  private async req<T>(path: string): Promise<T> {');
  lines.push('    const r = await fetch(`${this.baseUrl}/api${path}`, { headers: { authorization: `Bearer ${this.token}` } });');
  lines.push('    if (!r.ok) throw new Error(`OSDK ${r.status}: ${await r.text()}`);');
  lines.push('    return (await r.json()).value as T;');
  lines.push('  }');
  if (hasActions) {
    // Write helper — DAB REST mutations (POST/PATCH/DELETE) on the same runtime.
    lines.push('  private async write<T>(method: string, path: string, body?: unknown): Promise<T> {');
    lines.push('    const r = await fetch(`${this.baseUrl}/api${path}`, {');
    lines.push('      method,');
    lines.push('      headers: { authorization: `Bearer ${this.token}`, \'content-type\': \'application/json\' },');
    lines.push('      ...(body === undefined ? {} : { body: JSON.stringify(body) }),');
    lines.push('    });');
    lines.push('    if (!r.ok) throw new Error(`OSDK ${r.status}: ${await r.text()}`);');
    lines.push('    if (method === \'DELETE\' || r.status === 204) return undefined as T;');
    lines.push('    const j = await r.json().catch(() => ({}));');
    lines.push('    return (Array.isArray(j.value) ? j.value[0] : (j.value ?? j)) as T;');
    lines.push('  }');
  }
  for (const c of input.classes) {
    const t = pascal(c.name);
    const path = `/${c.name.toLowerCase()}`;
    const key = keyColumnFor(c.name, props);
    lines.push(`  list${t}s() { return this.req<${t}[]>('${path}'); }`);
    lines.push(`  async get${t}(id: string): Promise<${t} | undefined> { return (await this.req<${t}[]>(\`${path}/${key}/\${id}\`))[0]; }`);
  }
  // Typed write-back action methods (applyCreate*/applyUpdate*/applyDelete*).
  for (const a of actions) {
    const t = pascal(a.objectType);
    const path = `/${a.objectType.toLowerCase()}`;
    const key = keyColumnFor(a.objectType, props);
    const method = `apply${pascal(a.name)}`;
    if (a.kind === 'create') {
      lines.push(`  ${method}(input: ${t}Input): Promise<${t}> { return this.write<${t}>('POST', '${path}', input); }`);
    } else if (a.kind === 'update') {
      lines.push(`  ${method}(id: string, input: ${t}Input): Promise<${t}> { return this.write<${t}>('PATCH', \`${path}/${key}/\${id}\`, input); }`);
    } else {
      lines.push(`  ${method}(id: string): Promise<void> { return this.write<void>('DELETE', \`${path}/${key}/\${id}\`); }`);
    }
  }
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

/** Typed Python OSDK source over the ontology object + action types. */
export function generatePythonSdk(input: SdkOntologyInput): string {
  const props = input.propertiesByType || {};
  const actions = (Array.isArray(input.actionTypes) ? input.actionTypes : [])
    .filter((a) => input.classes.some((c) => c.name === a.objectType));
  const hasActions = actions.length > 0;

  const lines: string[] = [];
  lines.push(`"""Generated Ontology SDK for '${input.displayName}'. Azure-native (DAB REST); no Fabric."""`);
  lines.push('from dataclasses import dataclass, field');
  lines.push('from typing import Any, Dict, List, Optional');
  lines.push('import requests');
  lines.push('');
  for (const c of input.classes) {
    const typed = props[c.name];
    lines.push('@dataclass');
    lines.push(`class ${pascal(c.name)}:`);
    if (c.description) lines.push(`    """${c.description}"""`);
    if (typed && typed.length) {
      // Real named fields from the ontology's declared columns (all optional so
      // partial DAB projections deserialize cleanly).
      for (const p of typed) lines.push(`    ${p.name}: Optional[${p.pyType}] = None`);
    } else {
      lines.push('    id: str = ""');
      lines.push('    properties: Dict[str, Any] = field(default_factory=dict)');
    }
    lines.push('');
  }
  lines.push('class OntologyClient:');
  lines.push('    def __init__(self, base_url: str, token: str):');
  lines.push('        self.base_url = base_url.rstrip("/")');
  lines.push('        self.token = token');
  lines.push('    def _headers(self) -> Dict[str, str]:');
  lines.push('        return {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}');
  lines.push('    def _get(self, path: str):');
  lines.push('        r = requests.get(f"{self.base_url}/api{path}", headers=self._headers())');
  lines.push('        r.raise_for_status()');
  lines.push('        return r.json()["value"]');
  if (hasActions) {
    lines.push('    def _write(self, method: str, path: str, body: Optional[Dict[str, Any]] = None):');
    lines.push('        r = requests.request(method, f"{self.base_url}/api{path}", headers=self._headers(), json=body)');
    lines.push('        r.raise_for_status()');
    lines.push('        if method == "DELETE" or r.status_code == 204:');
    lines.push('            return None');
    lines.push('        data = r.json()');
    lines.push('        value = data.get("value")');
    lines.push('        return value[0] if isinstance(value, list) and value else (value if value is not None else data)');
  }
  for (const c of input.classes) {
    const name = c.name.toLowerCase();
    const key = keyColumnFor(c.name, props);
    lines.push(`    def list_${name}(self) -> List[Dict[str, Any]]:`);
    lines.push(`        return self._get("/${name}")`);
    lines.push(`    def get_${name}(self, id: str) -> Optional[Dict[str, Any]]:`);
    lines.push(`        rows = self._get(f"/${name}/${key}/{id}")`);
    lines.push('        return rows[0] if rows else None');
  }
  for (const a of actions) {
    const name = a.objectType.toLowerCase();
    const key = keyColumnFor(a.objectType, props);
    const method = `apply_${snakeAction(a.name)}`;
    if (a.kind === 'create') {
      lines.push(`    def ${method}(self, input: Dict[str, Any]) -> Dict[str, Any]:`);
      lines.push(`        return self._write("POST", "/${name}", input)`);
    } else if (a.kind === 'update') {
      lines.push(`    def ${method}(self, id: str, input: Dict[str, Any]) -> Dict[str, Any]:`);
      lines.push(`        return self._write("PATCH", f"/${name}/${key}/{id}", input)`);
    } else {
      lines.push(`    def ${method}(self, id: str) -> None:`);
      lines.push(`        self._write("DELETE", f"/${name}/${key}/{id}")`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** snake_case a Python method name from a (camel/Pascal/space) action name. */
function snakeAction(name: string): string {
  const s = String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return s || 'action';
}

/**
 * Generated typed-action reference (the editor's "Actions" tab). A self-contained
 * TypeScript reference listing each declared write-back action — its kind, target
 * object type, typed input shape, and a copy-paste usage snippet against the
 * generated `OntologyClient`. Returns '' when the ontology declares no actions.
 */
export function generateActionReference(input: SdkOntologyInput): string {
  const props = input.propertiesByType || {};
  const actions = (Array.isArray(input.actionTypes) ? input.actionTypes : [])
    .filter((a) => input.classes.some((c) => c.name === a.objectType));
  if (!actions.length) return '';
  const lines: string[] = [];
  lines.push(`// Action reference for "${input.displayName}" — typed write-back over the DAB`);
  lines.push('// REST mutation surface (POST / PATCH / DELETE) on Azure Container Apps. No Fabric.');
  lines.push('//');
  lines.push('// const client = new OntologyClient(BASE_URL, token);');
  lines.push('');
  for (const a of actions) {
    const t = pascal(a.objectType);
    const method = `apply${pascal(a.name)}`;
    const writable = (props[a.objectType] || []).filter((p) => !p.isKey).map((p) => p.name);
    const shape = writable.length ? `{ ${writable.map((n) => `${n}?`).join(', ')} }` : '{ … }';
    lines.push(`// ${a.name} — ${a.kind} on ${t}`);
    if (a.kind === 'create') {
      lines.push(`//   const created = await client.${method}(${shape} as ${t}Input);`);
    } else if (a.kind === 'update') {
      lines.push(`//   const updated = await client.${method}(id, ${shape} as ${t}Input);`);
    } else {
      lines.push(`//   await client.${method}(id);`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export interface SlateWidget {
  id: string;
  title: string;
  kind: 'table' | 'chart' | 'metric';
  query: string;
}
export interface SlateAppSpec {
  displayName: string;
  apiBaseUrl: string;
  widgets: SlateWidget[];
}
export interface GeneratedFile { name: string; content: string }

/** Real Azure Static Web Apps bundle (index.html + app.js + config) from the spec. */
export function generateSlateBundle(spec: SlateAppSpec): GeneratedFile[] {
  const widgetsJson = JSON.stringify(
    spec.widgets.map((w) => ({ id: w.id, title: w.title, kind: w.kind, query: w.query })),
    null, 2,
  );
  const title = spec.displayName || 'Slate app';
  const html = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `  <title>${title}</title>`,
    '  <style>body{font-family:Segoe UI,system-ui,sans-serif;margin:0;background:#faf9f8}',
    '  header{background:#5b2e91;color:#fff;padding:16px 24px}.grid{display:grid;gap:16px;padding:24px;',
    '  grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}.card{background:#fff;border:1px solid #e1dfdd;',
    '  border-radius:8px;padding:16px}.metric{font-size:32px;font-weight:600}table{width:100%;border-collapse:collapse}',
    '  th,td{text-align:left;padding:6px;border-bottom:1px solid #edebe9;font-size:13px}</style>',
    '</head>',
    '<body>',
    `  <header><h1>${title}</h1></header>`,
    '  <div class="grid" id="app"></div>',
    '  <script src="./app.js"></script>',
    '</body>',
    '</html>',
  ].join('\n');
  const appJs = [
    `// ${title} — generated Slate app over the Ontology Data API (Azure-native).`,
    `const API_BASE = ${JSON.stringify(spec.apiBaseUrl || '/api')};`,
    `const WIDGETS = ${widgetsJson};`,
    'async function runQuery(q) {',
    '  const r = await fetch(`${API_BASE}/${q}`, { credentials: "include" });',
    '  if (!r.ok) throw new Error(`HTTP ${r.status}`);',
    '  const j = await r.json();',
    '  return Array.isArray(j.value) ? j.value : (Array.isArray(j) ? j : []);',
    '}',
    'function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }',
    'async function render() {',
    '  const app = document.getElementById("app");',
    '  for (const w of WIDGETS) {',
    '    const card = el(`<div class="card"><h3>${w.title}</h3><div class="body">Loading…</div></div>`);',
    '    app.appendChild(card);',
    '    const body = card.querySelector(".body");',
    '    try {',
    '      const rows = await runQuery(w.query);',
    '      if (w.kind === "metric") { body.innerHTML = `<div class="metric">${rows.length}</div>`; }',
    '      else { const cols = rows.length ? Object.keys(rows[0]) : [];',
    '        body.innerHTML = `<table><thead><tr>${cols.map(c=>`<th>${c}</th>`).join("")}</tr></thead>` +',
    '          `<tbody>${rows.slice(0,50).map(r=>`<tr>${cols.map(c=>`<td>${r[c]??""}</td>`).join("")}</tr>`).join("")}</tbody></table>`; }',
    '    } catch (e) { body.textContent = "Query failed: " + e.message; }',
    '  }',
    '}',
    'render();',
  ].join('\n');
  const config = JSON.stringify({
    navigationFallback: { rewrite: '/index.html' },
    routes: [{ route: '/api/*', allowedRoles: ['authenticated'] }],
  }, null, 2);
  return [
    { name: 'index.html', content: html },
    { name: 'app.js', content: appJs },
    { name: 'staticwebapp.config.json', content: config },
  ];
}

// ── Workshop bundle codegen (mirrors generateSlateBundle above) ──

const DEFAULT_SIZE: Record<string, { w: number; h: number }> = {
  table: { w: 448, h: 288 }, chart: { w: 400, h: 272 }, metric: { w: 224, h: 144 },
  filter: { w: 288, h: 128 }, form: { w: 384, h: 320 }, button: { w: 224, h: 96 }, text: { w: 336, h: 160 },
};

/** Pick only the persisted-widget fields the generated runtime needs. */
function bundleWidget(w: WorkshopWidget, y: number): Record<string, unknown> {
  const size = DEFAULT_SIZE[w.kind] || DEFAULT_SIZE.table;
  return {
    id: w.id, title: w.title, kind: w.kind,
    layout: w.layout || { x: 16, y, w: size.w, h: size.h },
    ...(w.pageId ? { pageId: w.pageId } : {}),
    ...(w.visibleWhen ? { visibleWhen: w.visibleWhen } : {}),
    ...(w.entityType ? { entityType: w.entityType } : {}),
    ...(w.appliesVariableIds?.length ? { appliesVariableIds: w.appliesVariableIds } : {}),
    ...(w.kind === 'chart' ? { chartType: w.chartType, groupBy: w.groupBy, aggFn: w.aggFn, aggColumn: w.aggColumn } : {}),
    ...(w.kind === 'metric' ? { metricFn: w.metricFn, metricColumn: w.metricColumn } : {}),
    ...(w.kind === 'filter' ? { filterColumn: w.filterColumn, filterOp: w.filterOp, targetVariableId: w.targetVariableId, filterControl: w.filterControl } : {}),
    ...(w.kind === 'form' ? { formKind: w.formKind } : {}),
    ...(w.kind === 'text' ? { text: w.text } : {}),
    ...(w.kind === 'map' ? { geoColumn: w.geoColumn } : {}),
    ...(w.kind === 'pivot' ? { pivotRowField: w.pivotRowField, pivotColField: w.pivotColField, pivotAggFn: w.pivotAggFn, pivotAggColumn: w.pivotAggColumn } : {}),
    ...(w.kind === 'timeline' ? { timeColumn: w.timeColumn, labelColumn: w.labelColumn } : {}),
    ...(w.events?.length ? { events: w.events } : {}),
  };
}

/**
 * Real Azure Static Web Apps bundle (index.html + app.js + config) rendering
 * the Workshop canvas: widgets at their persisted { x, y, w, h } positions,
 * data widgets bound live to the ontology's Synapse rows via the console's
 * run-action route, filters/buttons/forms functional.
 */
export function generateWorkshopBundle(spec: {
  displayName: string; runActionUrl: string; widgets: WorkshopWidget[]; variables: WorkshopVariable[];
  /** WS-4.5 multi-page: app pages + drawer/modal overlays. Undefined → single default page. */
  pages?: WorkshopPage[];
  /** Published-app read-only data token (embedded; reads only, revocable server-side). */
  appReadToken?: string;
}): GeneratedFile[] {
  const title = spec.displayName || 'Workshop app';
  let autoY = 16;
  const widgetsJson = JSON.stringify(spec.widgets.map((w) => {
    const b = bundleWidget(w, autoY);
    if (!w.layout) autoY += (DEFAULT_SIZE[w.kind]?.h || 200) + 16;
    return b;
  }), null, 2);
  const variablesJson = JSON.stringify(spec.variables.map((v) => ({
    id: v.id, name: v.name, type: v.type,
    ...(v.entityType ? { entityType: v.entityType } : {}),
    ...(v.defaultValue !== undefined ? { defaultValue: v.defaultValue } : {}),
  })), null, 2);
  // Always emit a non-empty page list (a synthesized default page keeps the nav
  // + per-page widget grouping working for pre-multi-page apps).
  const resolvedPages = (Array.isArray(spec.pages) && spec.pages.some((p) => p.kind === 'page'))
    ? spec.pages
    : [{ id: 'page-1', name: 'Page 1', kind: 'page' as const }, ...(spec.pages || [])];
  const pagesJson = JSON.stringify(resolvedPages.map((p) => ({ id: p.id, name: p.name, kind: p.kind, ...(p.overlayStyle ? { overlayStyle: p.overlayStyle } : {}) })), null, 2);

  const html = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `  <title>${title}</title>`,
    '  <style>',
    '  body{font-family:Segoe UI,system-ui,sans-serif;margin:0;background:#faf9f8;color:#242424}',
    '  header{background:#5b2e91;color:#fff;padding:16px 24px}header h1{margin:0;font-size:22px}',
    '  header p{margin:4px 0 0;font-size:12px;opacity:.85}',
    '  .canvas{position:relative;margin:24px;min-height:320px}',
    '  .widget{position:absolute;display:flex;flex-direction:column;background:#fff;border:1px solid #e1dfdd;',
    '  border-radius:8px;overflow:hidden;box-shadow:0 1.6px 3.6px rgba(0,0,0,.08)}',
    '  .w-head{padding:6px 10px;font-size:13px;font-weight:600;border-bottom:1px solid #edebe9;',
    '  background:linear-gradient(135deg,#ece3f7,#fff)}',
    '  .body{flex:1;min-height:0;overflow:auto;padding:8px}',
    '  table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:5px 6px;border-bottom:1px solid #edebe9;font-size:12.5px}',
    '  .metric{font-size:32px;font-weight:600;color:#5b2e91}',
    '  .muted{color:#616161;font-size:12px;margin:4px 0}.err{color:#a4262c;font-size:12px}',
    '  .bars{display:flex;flex-direction:column;gap:4px}.bar-row{display:flex;align-items:center;gap:6px;font-size:12px}',
    '  .bar-label{flex:0 0 96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '  .bar{display:inline-block;height:12px;background:#5b2e91;border-radius:3px;flex:0 1 auto}',
    '  .bar-val{color:#616161}',
    '  .btn{background:#5b2e91;color:#fff;border:none;border-radius:6px;padding:8px 14px;font-size:13px;cursor:pointer}',
    '  .btn:hover{background:#4a2578}',
    '  select,input{font:inherit;padding:5px 8px;border:1px solid #c8c6c4;border-radius:4px;max-width:100%;box-sizing:border-box}',
    '  form.crud{display:flex;flex-direction:column;gap:6px}form.crud label{font-size:12px;color:#616161}',
    '  nav#nav{display:flex;gap:8px;flex-wrap:wrap;padding:10px 24px;background:#fff;border-bottom:1px solid #e1dfdd}',
    '  .nav-btn{background:transparent;border:1px solid transparent;border-radius:6px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer;color:#242424}',
    '  .nav-btn:hover{background:#f3f2f1}.nav-btn.active{background:#ece3f7;border-color:#5b2e91;color:#5b2e91;font-weight:600}',
    '  .page{display:none}',
    '  .gate{background:#fff4ce;border:1px solid #f2c811;border-radius:6px;padding:8px 10px;font-size:12.5px;color:#605e5c}',
    '  .tl{display:flex;flex-direction:column;gap:8px;padding-left:16px;position:relative}',
    '  .tl-row{position:relative}.tl-dot{position:absolute;left:-16px;top:4px;width:9px;height:9px;border-radius:50%;background:#5b2e91;border:2px solid #fff}',
    '  .ov-host{display:none;position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:50}',
    '  .ov-drawer{justify-content:flex-end}.ov-modal{align-items:center;justify-content:center}',
    '  #overlay-inner{background:#faf9f8;box-shadow:-4px 0 16px rgba(0,0,0,.2);overflow:auto}',
    '  .ov-drawer #overlay-inner{width:min(520px,92vw);height:100%}.ov-modal #overlay-inner{width:min(720px,92vw);max-height:88vh;border-radius:10px}',
    '  .ov-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #e1dfdd;font-weight:600}',
    '  </style>',
    '</head>',
    '<body>',
    '  <header>',
    `    <h1>${title}</h1>`,
    '    <p>Live data via the CSA Loom run-action API (Synapse behind the bound ontology) — sign in to CSA Loom in this browser for authenticated reads.</p>',
    '  </header>',
    '  <nav id="nav"></nav>',
    '  <div id="pages"></div>',
    '  <div class="ov-host" id="overlay-host"><div id="overlay-inner"></div></div>',
    '  <script src="./app.js"></script>',
    '</body>',
    '</html>',
  ].join('\n');

  const appJs = [
    `// ${title} — generated Workshop app over the CSA Loom ontology run-action API (Azure-native, no Fabric).`,
    `const RUN_ACTION_URL = ${JSON.stringify(spec.runActionUrl)};`,
    `const APP_READ_TOKEN = ${JSON.stringify(spec.appReadToken || '')};`,
    `const WIDGETS = ${widgetsJson};`,
    `const VARIABLES = ${variablesJson};`,
    `const PAGES = ${pagesJson};`,
    'const NAV_PAGES = PAGES.filter((p) => p.kind === "page");',
    'const DEFAULT_PAGE_ID = (NAV_PAGES[0] || PAGES[0] || { id: "page-1" }).id;',
    'let curPage = DEFAULT_PAGE_ID;',
    'function pageOf(w) { return PAGES.some((p) => p.id === w.pageId) ? w.pageId : DEFAULT_PAGE_ID; }',
    '// Conditional visibility — hide a widget unless its rule holds over live state.',
    'function visValue(raw) { if (Array.isArray(raw)) return { s: raw.length ? "x" : "", e: raw.length === 0 }; if (raw === null || raw === undefined) return { s: "", e: true }; return { s: String(raw), e: String(raw) === "" }; }',
    'function truthy(v) { if (v.e) return false; const l = v.s.trim().toLowerCase(); return l !== "false" && l !== "0" && l !== "no" && l !== "off"; }',
    'function isVisible(w) { const r = w.visibleWhen; if (!r || !r.variableId) return true; const v = visValue(rt[r.variableId]); switch (r.op) { case "empty": return v.e; case "notEmpty": return !v.e; case "truthy": return truthy(v); case "falsy": return !truthy(v); case "ne": return v.s !== String(r.value || ""); default: return v.s === String(r.value || ""); } }',
    '// Runtime variable values: object-set-filter → predicate[], scalars → string.',
    'const rt = {};',
    'for (const v of VARIABLES) rt[v.id] = v.type === "object-set-filter" ? [] : (v.defaultValue || "");',
    'function applyEffect(e, rowValue) {',
    '  const v = VARIABLES.find((x) => x.id === e.targetVariableId);',
    '  if (!v) return;',
    '  if (e.effect === "clear-variable") { rt[v.id] = v.type === "object-set-filter" ? [] : ""; return; }',
    '  if (e.effect !== "set-variable") return;',
    '  if (v.type === "object-set-filter") {',
    '    const val = rowValue !== undefined ? rowValue : (e.value || "");',
    '    rt[v.id] = e.filterColumn && val !== "" ? [{ column: e.filterColumn, op: e.filterOp || "eq", value: String(val) }] : [];',
    '  } else { rt[v.id] = e.value || ""; }',
    '}',
    'for (const w of WIDGETS) if (w.kind === "button") (w.events || []).forEach((e) => { if (e.trigger === "page-load") applyEffect(e); });',
    'function filtersFor(w) {',
    '  const out = [];',
    '  for (const vid of (w.appliesVariableIds || [])) {',
    '    const v = VARIABLES.find((x) => x.id === vid);',
    '    if (!v || v.type !== "object-set-filter") continue;',
    '    if (v.entityType && w.entityType && v.entityType !== w.entityType) continue;',
    '    const rv = rt[vid];',
    '    if (Array.isArray(rv)) out.push.apply(out, rv);',
    '  }',
    '  return out;',
    '}',
    'async function runAction(body) {',
    '  const headers = { "content-type": "application/json" };',
    '  if (APP_READ_TOKEN) headers["authorization"] = "Bearer " + APP_READ_TOKEN;',
    '  const r = await fetch(RUN_ACTION_URL, { method: "POST", headers, body: JSON.stringify(body) });',
    '  const j = await r.json().catch(() => ({}));',
    '  if (!j.ok) throw new Error((j.error || "HTTP " + r.status) + (j.gate && j.gate.remediation ? " — " + j.gate.remediation : ""));',
    '  return j;',
    '}',
    'function esc(v) { const d = document.createElement("div"); d.textContent = v === null || v === undefined ? "" : String(v); return d.innerHTML; }',
    'function bodyOf(w) { const el = document.getElementById("w-" + w.id); return el ? el.querySelector(".body") : null; }',
    'function tableHtml(cols, rows) {',
    '  return "<table><thead><tr>" + cols.map((c) => "<th>" + esc(c) + "</th>").join("") + "</tr></thead><tbody>" +',
    '    rows.slice(0, 100).map((r) => "<tr>" + r.map((c) => "<td>" + esc(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table>";',
    '}',
    'function barsHtml(rows) {',
    '  const two = rows.length && rows[0].length > 1;',
    '  const vals = rows.map((r) => Number(two ? r[1] : r[0]) || 0);',
    '  const max = Math.max.apply(null, vals.concat([1]));',
    '  return \'<div class="bars">\' + rows.slice(0, 24).map((r, i) =>',
    '    \'<div class="bar-row"><span class="bar-label">\' + esc(two ? r[0] : "value") + \'</span>\' +',
    '    \'<span class="bar" style="width:\' + Math.max(2, Math.round(60 * vals[i] / max)) + \'%"></span>\' +',
    '    \'<span class="bar-val">\' + esc(two ? r[1] : r[0]) + "</span></div>").join("") + "</div>";',
    '}',
    'function interp(text) {',
    '  return (text || "").replace(/\\{\\{([^}]+)\\}\\}/g, (m, n) => {',
    '    const v = VARIABLES.find((x) => x.name === n.trim());',
    '    if (!v) return m;',
    '    const rv = rt[v.id];',
    '    if (Array.isArray(rv)) return rv.map((p) => p.column + " " + p.op + " " + p.value).join(", ") || "(no filter)";',
    '    return String(rv || "");',
    '  });',
    '}',
    'function textHtml(text) {',
    '  return interp(text).split("\\n").map((l) => /^#{1,3}\\s/.test(l) ? "<h3>" + esc(l.replace(/^#+\\s/, "")) + "</h3>" : "<p>" + esc(l) + "</p>").join("");',
    '}',
    'async function renderData(w) {',
    '  const body = bodyOf(w); if (!body) return;',
    '  body.innerHTML = \'<p class="muted">Loading…</p>\';',
    '  try {',
    '    if (w.kind === "table") {',
    '      const j = await runAction({ entityType: w.entityType, op: "list", top: 200, filters: filtersFor(w) });',
    '      body.innerHTML = (j.rows || []).length ? tableHtml(j.columns || [], j.rows) : \'<p class="muted">No rows.</p>\';',
    '    } else if (w.kind === "chart") {',
    '      const j = await runAction({ entityType: w.entityType, op: "aggregate", groupBy: w.groupBy, aggFn: w.aggFn || "count", aggColumn: w.aggColumn, filters: filtersFor(w), top: 50 });',
    '      body.innerHTML = (j.rows || []).length ? barsHtml(j.rows) : \'<p class="muted">No rows.</p>\';',
    '    } else if (w.kind === "metric") {',
    '      const j = await runAction({ entityType: w.entityType, op: "aggregate", aggFn: w.metricFn || "count", aggColumn: w.metricColumn, filters: filtersFor(w), top: 1 });',
    '      const v = Number(j.rows && j.rows[0] && j.rows[0][0]);',
    '      body.innerHTML = \'<div class="metric">\' + esc(Number.isFinite(v) ? v.toLocaleString() : "—") + \'</div><p class="muted">\' + esc((w.metricFn || "count") + " · " + w.entityType) + "</p>";',
    '    } else if (w.kind === "map") {',
    '      const j = await runAction({ entityType: w.entityType, op: "list", top: 500, filters: filtersFor(w) });',
    '      body.innerHTML = mapHtml(j.columns || [], j.rows || [], w.geoColumn);',
    '    } else if (w.kind === "pivot") {',
    '      const j = await runAction({ entityType: w.entityType, op: "list", top: 500, filters: filtersFor(w) });',
    '      body.innerHTML = pivotHtml(j.columns || [], j.rows || [], w);',
    '    } else if (w.kind === "timeline") {',
    '      const j = await runAction({ entityType: w.entityType, op: "list", top: 500, filters: filtersFor(w) });',
    '      body.innerHTML = timelineHtml(j.columns || [], j.rows || [], w);',
    '    }',
    '  } catch (e) { body.innerHTML = \'<p class="err">\' + esc(e.message) + "</p>"; }',
    '}',
    '// pivot / timeline / map — real client-side shaping over run-action rows.',
    'function toMs(v) { if (v === null || v === undefined || v === "") return null; if (typeof v === "number") return isFinite(v) ? v : null; const s = String(v).trim(); if (/^\\d{10,13}$/.test(s)) { const n = Number(s); return s.length <= 10 ? n * 1000 : n; } const t = Date.parse(s); return isFinite(t) ? t : null; }',
    'function pivotHtml(cols, rows, w) {',
    '  const ri = cols.indexOf(w.pivotRowField), ci = cols.indexOf(w.pivotColField), ai = w.pivotAggColumn ? cols.indexOf(w.pivotAggColumn) : -1;',
    '  if (ri < 0 || ci < 0) return \'<p class="muted">Set the pivot row + column fields.</p>\';',
    '  const fn = w.pivotAggFn || "count"; const rk = [], ck = [], vals = {}, cnt = {};',
    '  rows.forEach((r) => { const a = r[ri] == null ? "" : String(r[ri]), b = r[ci] == null ? "" : String(r[ci]); if (rk.indexOf(a) < 0) rk.push(a); if (ck.indexOf(b) < 0) ck.push(b); vals[a] = vals[a] || {}; cnt[a] = cnt[a] || {}; vals[a][b] = vals[a][b] || []; cnt[a][b] = (cnt[a][b] || 0) + 1; if (ai >= 0) { const n = Number(r[ai]); if (isFinite(n)) vals[a][b].push(n); } });',
    '  rk.sort(); ck.sort();',
    '  const agg = (arr, c) => { if (fn === "count") return c; if (!arr.length) return 0; if (fn === "sum") return arr.reduce((x, y) => x + y, 0); if (fn === "avg") return arr.reduce((x, y) => x + y, 0) / arr.length; if (fn === "min") return Math.min.apply(null, arr); if (fn === "max") return Math.max.apply(null, arr); return 0; };',
    '  let h = "<table><thead><tr><th>" + esc(w.pivotRowField) + "</th>" + ck.map((c) => "<th>" + esc(c || "—") + "</th>").join("") + "</tr></thead><tbody>";',
    '  rk.forEach((a) => { h += "<tr><td><strong>" + esc(a || "—") + "</strong></td>" + ck.map((b) => "<td>" + esc(agg(vals[a][b] || [], cnt[a][b] || 0)) + "</td>").join("") + "</tr>"; });',
    '  return rk.length ? h + "</tbody></table>" : \'<p class="muted">No rows to pivot.</p>\';',
    '}',
    'function timelineHtml(cols, rows, w) {',
    '  const ti = cols.indexOf(w.timeColumn); if (ti < 0) return \'<p class="muted">Set the time column.</p>\';',
    '  const li = w.labelColumn ? cols.indexOf(w.labelColumn) : cols.findIndex((_, i) => i !== ti);',
    '  const ev = []; rows.forEach((r) => { const ms = toMs(r[ti]); if (ms === null) return; ev.push({ ms: ms, label: li >= 0 && r[li] != null ? String(r[li]) : String(r[ti]) }); });',
    '  ev.sort((a, b) => a.ms - b.ms);',
    '  return ev.length ? \'<div class="tl">\' + ev.slice(0, 200).map((e) => \'<div class="tl-row"><span class="tl-dot"></span><span class="muted">\' + esc(new Date(e.ms).toLocaleString()) + "</span><div>" + esc(e.label) + "</div></div>").join("") + "</div>" : \'<p class="muted">No rows have a parseable date.</p>\';',
    '}',
    'function mapHtml(cols, rows, geoCol) {',
    '  const gi = geoCol ? cols.indexOf(geoCol) : -1;',
    '  const pts = [];',
    '  rows.forEach((r) => { const idxs = gi >= 0 ? [gi] : cols.map((_, i) => i); for (const i of idxs) { const p = parseLatLon(r[i]); if (p) { pts.push({ name: r[0] == null ? "" : String(r[0]), lat: p[0], lon: p[1] }); break; } } });',
    '  return pts.length ? \'<p class="muted">\' + pts.length + " located row(s):</p><table><thead><tr><th>Row</th><th>Lat</th><th>Lon</th></tr></thead><tbody>" + pts.slice(0, 100).map((p) => "<tr><td>" + esc(p.name) + "</td><td>" + esc(p.lat) + "</td><td>" + esc(p.lon) + "</td></tr>").join("") + "</tbody></table>" : \'<p class="muted">No location data in these rows.</p>\';',
    '}',
    'function parseLatLon(v) { if (v == null) return null; const s = String(v).trim(); if (s[0] === "{") { try { const o = JSON.parse(s); const la = Number(o.lat != null ? o.lat : o.latitude), lo = Number(o.lon != null ? o.lon : (o.lng != null ? o.lng : o.longitude)); if (isFinite(la) && isFinite(lo)) return [la, lo]; } catch (e) {} return null; } const parts = s.split(",").map((x) => Number(x.trim())); if (parts.length === 2 && parts.every(isFinite)) { return Math.abs(parts[0]) > 90 && Math.abs(parts[1]) <= 90 ? [parts[1], parts[0]] : [parts[0], parts[1]]; } return null; }',
    'function noteHtml(msg) { return \'<div class="gate">\' + esc(msg) + "</div>"; }',
    'function refreshData() { WIDGETS.forEach((w) => { if (["table", "chart", "metric", "map", "pivot", "timeline"].indexOf(w.kind) >= 0 && w.entityType) renderData(w); }); applyVisibility(); }',
    'function applyFilter(w, value) {',
    '  if (!w.targetVariableId || !w.filterColumn) return;',
    '  rt[w.targetVariableId] = value !== "" ? [{ column: w.filterColumn, op: w.filterOp || "eq", value: value }] : [];',
    '  refreshData();',
    '}',
    'async function renderFilter(w) {',
    '  const body = bodyOf(w); if (!body) return;',
    '  body.innerHTML = \'<p class="muted">\' + esc((w.filterColumn || "column") + " " + (w.filterOp || "eq")) + "</p>";',
    '  let control;',
    '  if ((w.filterControl || "dropdown") === "dropdown" && w.entityType && w.filterColumn) {',
    '    control = document.createElement("select");',
    '    control.innerHTML = \'<option value="">Any</option>\';',
    '    try {',
    '      const j = await runAction({ entityType: w.entityType, op: "distinct", column: w.filterColumn, top: 200 });',
    '      (j.rows || []).forEach((r) => { const o = document.createElement("option"); o.value = String(r[0] === null || r[0] === undefined ? "" : r[0]); o.textContent = o.value; if (o.value) control.appendChild(o); });',
    '    } catch (e) { /* keep the Any option; reads may need sign-in */ }',
    '    control.onchange = () => applyFilter(w, control.value);',
    '  } else {',
    '    control = document.createElement("input");',
    '    control.placeholder = "Filter value";',
    '    control.onchange = () => applyFilter(w, control.value);',
    '  }',
    '  body.appendChild(control);',
    '}',
    'function renderButton(w) {',
    '  const body = bodyOf(w);',
    '  const b = document.createElement("button");',
    '  b.className = "btn"; b.textContent = w.title || "Run";',
    '  b.onclick = () => {',
    '    (w.events || []).forEach((e) => {',
    '      if (e.trigger !== "click") return;',
    '      if (e.effect === "set-variable" || e.effect === "clear-variable") applyEffect(e);',
    '      else if (e.effect === "open-overlay" && e.targetPageId) openOverlay(e.targetPageId);',
    '      else if (e.effect === "close-overlay") closeOverlay();',
    '    });',
    '    refreshData();',
    '  };',
    '  body.appendChild(b);',
    '}',
    'async function renderForm(w) {',
    '  const body = bodyOf(w); if (!body) return;',
    '  const kind = w.formKind || "create";',
    '  let cols = [];',
    '  try { const j = await runAction({ entityType: w.entityType, op: "list", top: 1 }); cols = j.columns || []; }',
    '  catch (e) { body.innerHTML = \'<p class="err">\' + esc(e.message) + "</p>"; return; }',
    '  const form = document.createElement("form"); form.className = "crud";',
    '  const valueInputs = {}; let keyColSel = null; let keyInput = null;',
    '  if (kind === "update" || kind === "delete") {',
    '    keyColSel = document.createElement("select");',
    '    cols.forEach((c) => { const o = document.createElement("option"); o.value = c; o.textContent = "Key: " + c; keyColSel.appendChild(o); });',
    '    keyInput = document.createElement("input"); keyInput.placeholder = "Key value";',
    '    form.appendChild(keyColSel); form.appendChild(keyInput);',
    '  }',
    '  if (kind === "create" || kind === "update") {',
    '    cols.forEach((c) => {',
    '      const lab = document.createElement("label"); lab.textContent = c;',
    '      const inp = document.createElement("input"); inp.placeholder = c;',
    '      valueInputs[c] = inp; form.appendChild(lab); form.appendChild(inp);',
    '    });',
    '  }',
    '  const submit = document.createElement("button"); submit.className = "btn"; submit.type = "submit"; submit.textContent = "Run " + kind;',
    '  const msg = document.createElement("p"); msg.className = "muted";',
    '  form.appendChild(submit); form.appendChild(msg);',
    '  form.onsubmit = async (ev) => {',
    '    ev.preventDefault(); msg.className = "muted"; msg.textContent = "Running…";',
    '    const req = { entityType: w.entityType, op: kind };',
    '    if (kind === "create" || kind === "update") {',
    '      const values = {};',
    '      for (const c of Object.keys(valueInputs)) if (valueInputs[c].value !== "") values[c] = valueInputs[c].value;',
    '      req.values = values;',
    '    }',
    '    if (keyColSel) { req.keyColumn = keyColSel.value; req.key = keyInput.value; }',
    '    try { const j = await runAction(req); msg.textContent = kind + " succeeded — " + (j.recordsAffected || 0) + " row(s) affected."; refreshData(); }',
    '    catch (e) { msg.className = "err"; msg.textContent = e.message; }',
    '  };',
    '  body.innerHTML = ""; body.appendChild(form);',
    '}',
    'function pageWidgets(pid) { return WIDGETS.filter((w) => pageOf(w) === pid); }',
    'function widgetEl(w, canvas) {',
    '  const l = w.layout || { x: 16, y: 16, w: 320, h: 200 };',
    '  const el = document.createElement("div"); el.className = "widget"; el.id = "w-" + w.id;',
    '  el.style.left = l.x + "px"; el.style.top = l.y + "px"; el.style.width = l.w + "px"; el.style.height = l.h + "px";',
    '  el.innerHTML = \'<div class="w-head">\' + esc(w.title || w.kind) + \'</div><div class="body"></div>\';',
    '  canvas.appendChild(el); return l.y + l.h;',
    '}',
    'function renderBody(w) {',
    '  if (w.kind === "text") { const b = bodyOf(w); if (b) b.innerHTML = textHtml(w.text); }',
    '  else if (w.kind === "button") renderButton(w);',
    '  else if (w.kind === "filter") renderFilter(w);',
    '  else if (w.kind === "form") renderForm(w);',
    '  else if (w.kind === "object-view") { const b = bodyOf(w); if (b) b.innerHTML = noteHtml("Open this app inside CSA Loom (sign in) to drill into the selected object — Object View needs an authenticated ontology session."); }',
    '  else if (w.kind === "links") { const b = bodyOf(w); if (b) b.innerHTML = noteHtml("Open this app inside CSA Loom (sign in) to traverse linked objects — needs an authenticated ontology session."); }',
    '  else if (w.kind === "aip-copilot") { const b = bodyOf(w); if (b) b.innerHTML = noteHtml("Open this app inside CSA Loom to chat with the per-surface AIP Copilot."); }',
    '}',
    'function buildPage(p) {',
    '  const wrap = document.createElement("div"); wrap.className = "page"; wrap.id = "pg-" + p.id;',
    '  const canvas = document.createElement("div"); canvas.className = "canvas"; wrap.appendChild(canvas);',
    '  let maxB = 0; pageWidgets(p.id).forEach((w) => { maxB = Math.max(maxB, widgetEl(w, canvas)); });',
    '  canvas.style.height = (maxB + 24) + "px"; return wrap;',
    '}',
    'function showPage(pid) { curPage = pid; document.querySelectorAll(".page").forEach((el) => { el.style.display = el.id === "pg-" + pid ? "block" : "none"; }); document.querySelectorAll(".nav-btn").forEach((b) => { b.className = "nav-btn" + (b.getAttribute("data-pid") === pid ? " active" : ""); }); }',
    'function openOverlay(pid) {',
    '  const p = PAGES.find((x) => x.id === pid); if (!p) return;',
    '  const host = document.getElementById("overlay-host"); const inner = document.getElementById("overlay-inner"); inner.innerHTML = "";',
    '  const head = document.createElement("div"); head.className = "ov-head"; head.innerHTML = "<span>" + esc(p.name) + "</span>";',
    '  const close = document.createElement("button"); close.className = "btn"; close.textContent = "Close"; close.onclick = closeOverlay; head.appendChild(close); inner.appendChild(head);',
    '  const canvas = document.createElement("div"); canvas.className = "canvas"; let maxB = 0; pageWidgets(pid).forEach((w) => { maxB = Math.max(maxB, widgetEl(w, canvas)); }); canvas.style.height = (maxB + 24) + "px"; inner.appendChild(canvas);',
    '  pageWidgets(pid).forEach(renderBody);',
    '  host.className = "ov-host " + (p.overlayStyle === "modal" ? "ov-modal" : "ov-drawer"); host.style.display = "flex"; refreshData();',
    '}',
    'function closeOverlay() { const host = document.getElementById("overlay-host"); host.style.display = "none"; document.getElementById("overlay-inner").innerHTML = ""; }',
    'function applyVisibility() { WIDGETS.forEach((w) => { const el = document.getElementById("w-" + w.id); if (el) el.style.display = isVisible(w) ? "flex" : "none"; }); }',
    'function boot() {',
    '  const nav = document.getElementById("nav");',
    '  NAV_PAGES.forEach((p) => { const b = document.createElement("button"); b.className = "nav-btn"; b.setAttribute("data-pid", p.id); b.textContent = p.name; b.onclick = () => showPage(p.id); nav.appendChild(b); });',
    '  if (NAV_PAGES.length <= 1) nav.style.display = "none";',
    '  const pagesHost = document.getElementById("pages");',
    '  NAV_PAGES.forEach((p) => pagesHost.appendChild(buildPage(p)));',
    '  NAV_PAGES.forEach((p) => pageWidgets(p.id).forEach(renderBody));',
    '  document.getElementById("overlay-host").addEventListener("click", (e) => { if (e.target.id === "overlay-host") closeOverlay(); });',
    '  showPage(DEFAULT_PAGE_ID);',
    '  refreshData();',
    '}',
    'boot();',
  ].join('\n');

  const config = JSON.stringify({
    navigationFallback: { rewrite: '/index.html' },
  }, null, 2);

  return [
    { name: 'index.html', content: html },
    { name: 'app.js', content: appJs },
    { name: 'staticwebapp.config.json', content: config },
  ];
}

/**
 * APP-W3 visual→code "eject": turn a Workshop app's canvas into a runnable
 * loom-app-runtime source tree (userFiles shape: path → content). Reuses the
 * SWA bundle emitter for the front-end, adds an Express server that statically
 * serves it and PROXIES /run-action to the Console's workshop run-action API
 * with a scoped API token (PAT) — the deployed container has no browser
 * session, so the proxy is the honest data path (run-action accepts PATs via
 * getApiSession). Missing env → precise 503, never a silent dead widget.
 */
export function generateWorkshopCodeApp(spec: {
  displayName: string; workshopAppId: string;
  widgets: WorkshopWidget[]; variables: WorkshopVariable[]; pages?: WorkshopPage[];
}): Record<string, string> {
  // Relative URL — app.js calls same-origin /run-action; server.js forwards.
  const bundle = generateWorkshopBundle({
    displayName: spec.displayName,
    runActionUrl: '/run-action',
    widgets: spec.widgets,
    variables: spec.variables,
    pages: spec.pages,
  });
  const byName = new Map(bundle.map((f) => [f.name, f.content]));

  const serverJs = [
    `// ${spec.displayName} — ejected from the Workshop visual builder (APP-W3 visual→code).`,
    '// Serves the generated canvas from ./public and proxies /run-action to the',
    '// CSA Loom console with a scoped API token. Wire on the Bindings tab:',
    '//   LOOM_CONSOLE_URL — the console base URL (pre-seeded by the eject)',
    '//   LOOM_API_TOKEN   — a scoped API token (Profile → API tokens); store it',
    '//                      as a Key Vault secretRef binding, never a plain value.',
    "const express = require('express');",
    'const app = express();',
    'app.use(express.json());',
    "app.use(express.static('public'));",
    '',
    "const CONSOLE = (process.env.LOOM_CONSOLE_URL || '').replace(/\\/+$/, '');",
    "const TOKEN = process.env.LOOM_API_TOKEN || '';",
    `const RUN_ACTION_PATH = '/api/items/workshop-app/${spec.workshopAppId}/run-action';`,
    '',
    "app.post('/run-action', async (req, res) => {",
    '  if (!CONSOLE || !TOKEN) {',
    '    res.status(503).json({ ok: false, error:',
    "      'Not wired to CSA Loom yet — set LOOM_CONSOLE_URL (console base URL) and LOOM_API_TOKEN (a scoped API token from Profile → API tokens, stored as a Key Vault secretRef binding) on this app, then Deploy.' });",
    '    return;',
    '  }',
    '  try {',
    '    const r = await fetch(CONSOLE + RUN_ACTION_PATH, {',
    "      method: 'POST',",
    "      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },",
    '      body: JSON.stringify(req.body || {}),',
    '    });',
    "    res.status(r.status).type('application/json').send(await r.text());",
    '  } catch (e) {',
    '    res.status(502).json({ ok: false, error: String((e && e.message) || e) });',
    '  }',
    '});',
    '',
    "app.get('/health', (_req, res) => res.json({ ok: true }));",
    'const port = process.env.PORT || 3000;',
    "app.listen(port, () => console.log('workshop code app listening on :' + port));",
    '',
  ].join('\n');

  const pkg = JSON.stringify({
    name: 'workshop-code-app',
    version: '1.0.0',
    private: true,
    scripts: { start: 'node server.js' },
    dependencies: { express: '^4.21.2' },
  }, null, 2) + '\n';

  return {
    'server.js': serverJs,
    'package.json': pkg,
    'public/index.html': byName.get('index.html') || '',
    'public/app.js': byName.get('app.js') || '',
  };
}
