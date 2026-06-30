/**
 * Pure code generators for the Palantir-class migration surfaces. Kept free of
 * React / Next so they can be unit-tested (see __tests__/palantir-codegen.test.ts)
 * and called from the BFF routes:
 *   - ontology-sdk/[id]/generate  → typed TS + Python client over an ontology
 *   - slate-app/[id]/generate     → an Azure Static Web Apps HTML/JS bundle
 *
 * Everything here is deterministic real output (no mocks): the SDK is generated
 * from the ontology's parsed object / link / action types, the DAB config is a
 * real dab-config.json shape, and the Slate bundle is a deployable SWA app.
 */
import type { OntologyClass, OntologyEntityBinding } from './_family-utils';

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
