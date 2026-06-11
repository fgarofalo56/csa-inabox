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
import type { OntologyClass } from './_family-utils';

export interface SdkOntologyInput {
  displayName: string;
  classes: OntologyClass[];
  links: Array<{ from: string; to: string; kind: string }>;
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

/** Real dab-config.json entity map over the ontology's object types. */
export function generateDabConfig(input: SdkOntologyInput): Record<string, unknown> {
  const entities: Record<string, unknown> = {};
  for (const c of input.classes) {
    entities[pascal(c.name)] = {
      source: { object: c.name, type: 'table' },
      rest: { enabled: true, path: `/${c.name.toLowerCase()}` },
      graphql: { enabled: true, type: { singular: pascal(c.name), plural: `${pascal(c.name)}s` } },
      permissions: [{ role: 'authenticated', actions: ['read'] }],
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

/** Typed TypeScript OSDK source over the ontology object + link types. */
export function generateTypeScriptSdk(input: SdkOntologyInput): string {
  const lines: string[] = [];
  lines.push(`// Generated Ontology SDK for "${input.displayName}" — do not edit by hand.`);
  lines.push(`// Backed by Microsoft Data API Builder (REST). Azure-native; no Fabric.`);
  lines.push('');
  for (const c of input.classes) {
    const parentLinks = input.links.filter((l) => l.from === c.name);
    lines.push(`export interface ${pascal(c.name)} {`);
    lines.push('  id: string;');
    if (c.description) lines.push(`  /** ${c.description} */`);
    lines.push('  [property: string]: unknown;');
    for (const l of parentLinks) lines.push(`  ${l.kind.toLowerCase()}_${l.to.toLowerCase()}?: ${pascal(l.to)};`);
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
  for (const c of input.classes) {
    const t = pascal(c.name);
    lines.push(`  list${t}s() { return this.req<${t}[]>('/${c.name.toLowerCase()}'); }`);
    lines.push(`  get${t}(id: string) { return this.req<${t}>(\`/${c.name.toLowerCase()}/id/\${id}\`); }`);
  }
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

/** Typed Python OSDK source over the ontology object types. */
export function generatePythonSdk(input: SdkOntologyInput): string {
  const lines: string[] = [];
  lines.push(`"""Generated Ontology SDK for '${input.displayName}'. Azure-native (DAB REST); no Fabric."""`);
  lines.push('from dataclasses import dataclass');
  lines.push('from typing import Any, Dict, List');
  lines.push('import requests');
  lines.push('');
  for (const c of input.classes) {
    lines.push('@dataclass');
    lines.push(`class ${pascal(c.name)}:`);
    if (c.description) lines.push(`    """${c.description}"""`);
    lines.push('    id: str');
    lines.push('    properties: Dict[str, Any]');
    lines.push('');
  }
  lines.push('class OntologyClient:');
  lines.push('    def __init__(self, base_url: str, token: str):');
  lines.push('        self.base_url = base_url.rstrip("/")');
  lines.push('        self.token = token');
  lines.push('    def _get(self, path: str):');
  lines.push('        r = requests.get(f"{self.base_url}/api{path}", headers={"Authorization": f"Bearer {self.token}"})');
  lines.push('        r.raise_for_status()');
  lines.push('        return r.json()["value"]');
  for (const c of input.classes) {
    lines.push(`    def list_${c.name.toLowerCase()}(self) -> List[Dict[str, Any]]:`);
    lines.push(`        return self._get("/${c.name.toLowerCase()}")`);
  }
  lines.push('');
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
