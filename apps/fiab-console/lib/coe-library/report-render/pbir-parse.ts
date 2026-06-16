/**
 * PBIR (Power BI Enhanced Report) parser for the CoE template viewer.
 *
 * Pure, dependency-free function that turns the real PBIP `files[]` of a CoE
 * template into a render-ready {@link ReportModel}: pages (ordered) each with
 * their visuals (ordered by z), every visual reduced to its type, position,
 * resolved title and the projected fields per visual role.
 *
 * The PBIR shape is the real Fabric "definition" format:
 *   <Name>.Report/definition/pages/pages.json        → page order + active page
 *   <Name>.Report/definition/pages/<page>/page.json  → name/displayName/w/h
 *   .../pages/<page>/visuals/<id>/visual.json        → one visual container
 *
 * A visual container carries `visual.visualType`, `visual.query.queryState.<role>`
 * (each with `projections[].field.{Column|Measure}` → SourceRef.Entity + Property)
 * and an optional `visual.objects.title[0].properties.text.expr.Literal.Value`.
 *
 * This parser is defensive: a single malformed visual.json is skipped (never
 * throws), and missing `objects`/`title`/`position` degrade gracefully so the
 * report still renders. No Microsoft Fabric / Power BI service is contacted.
 */

export type FieldKind = 'column' | 'measure';

export interface Field {
  /** Source table (PBIR `SourceRef.Entity`). */
  entity: string;
  /** Column or measure name (PBIR `Property`). */
  property: string;
  kind: FieldKind;
  /** PBIR `queryRef`, e.g. "Cost.Total Cost". */
  queryRef: string;
}

export interface Visual {
  id: string;
  /** PBIR `visualType`, e.g. card / clusteredColumnChart / lineChart / tableEx. */
  type: string;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  /** Resolved title (literal text, quotes stripped) or a humanized default. */
  title: string;
  /** Projected fields keyed by query role (Values / Category / Y / …). */
  roles: Record<string, Field[]>;
}

export interface Page {
  /** Stable page name (folder name). */
  name: string;
  displayName: string;
  width: number;
  height: number;
  /** Visuals sorted by z (back to front). */
  visuals: Visual[];
}

export interface ReportModel {
  pages: Page[];
}

export interface TemplateFile {
  path: string;
  content: string;
}

function safeJson<T = any>(content: string): T | null {
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/** Humanize a camelCase / PascalCase visual type into a readable fallback title. */
function humanizeType(type: string): string {
  if (!type) return 'Visual';
  const spaced = type
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/Chart$/i, ' chart')
    .replace(/\s+/g, ' ')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Strip the single/double quotes Power BI wraps around a literal title value. */
function stripLiteralQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) {
    return v.slice(1, -1);
  }
  return v;
}

function resolveTitle(visual: any, roles: Record<string, Field[]>): string {
  const literal = visual?.objects?.title?.[0]?.properties?.text?.expr?.Literal?.Value;
  if (typeof literal === 'string' && literal.trim()) return stripLiteralQuotes(literal);
  // Fall back to the first projected field's property, else the humanized type.
  for (const role of Object.keys(roles)) {
    const f = roles[role]?.[0];
    if (f?.property) return f.property;
  }
  return humanizeType(visual?.visualType || '');
}

function parseProjections(projections: any[]): Field[] {
  const out: Field[] = [];
  if (!Array.isArray(projections)) return out;
  for (const p of projections) {
    const field = p?.field;
    if (!field) continue;
    const colOrMeasure = field.Column ? 'column' : field.Measure ? 'measure' : null;
    if (!colOrMeasure) continue;
    const node = field.Column || field.Measure;
    const entity = node?.Expression?.SourceRef?.Entity;
    const property = node?.Property;
    if (!entity || !property) continue;
    out.push({
      entity: String(entity),
      property: String(property),
      kind: colOrMeasure as FieldKind,
      queryRef: typeof p.queryRef === 'string' ? p.queryRef : `${entity}.${property}`,
    });
  }
  return out;
}

function parseVisual(id: string, content: string): Visual | null {
  const json = safeJson(content);
  if (!json || !json.visual) return null;
  const v = json.visual;
  const pos = json.position || {};
  const queryState = v?.query?.queryState || {};
  const roles: Record<string, Field[]> = {};
  for (const role of Object.keys(queryState)) {
    const fields = parseProjections(queryState[role]?.projections);
    if (fields.length) roles[role] = fields;
  }
  return {
    id,
    type: String(v.visualType || 'unknown'),
    x: Number(pos.x) || 0,
    y: Number(pos.y) || 0,
    z: Number(pos.z) || 0,
    w: Number(pos.width) || 0,
    h: Number(pos.height) || 0,
    title: resolveTitle(v, roles),
    roles,
  };
}

// Match the page folder + visual id out of a visual.json path.
const VISUAL_RE = /\/pages\/([^/]+)\/visuals\/([^/]+)\/visual\.json$/;
const PAGE_RE = /\/pages\/([^/]+)\/page\.json$/;
const PAGES_META_RE = /\/pages\/pages\.json$/;

/**
 * Parse the bundled PBIP `files[]` into a render-ready {@link ReportModel}.
 * Pages are returned in `pageOrder` (when pages.json is present), each with its
 * visuals sorted by z. Never throws — malformed visuals are skipped.
 */
export function parseReportModel(files: TemplateFile[]): ReportModel {
  const pageMeta = new Map<string, { displayName: string; width: number; height: number }>();
  const visualsByPage = new Map<string, Visual[]>();
  let pageOrder: string[] = [];

  for (const f of files || []) {
    if (!f || typeof f.path !== 'string') continue;

    if (PAGES_META_RE.test(f.path)) {
      const meta = safeJson(f.content);
      if (Array.isArray(meta?.pageOrder)) pageOrder = meta.pageOrder.map(String);
      continue;
    }

    const pageMatch = f.path.match(PAGE_RE);
    if (pageMatch) {
      const page = safeJson(f.content);
      const name = String(page?.name || pageMatch[1]);
      pageMeta.set(name, {
        displayName: String(page?.displayName || name),
        width: Number(page?.width) || 1280,
        height: Number(page?.height) || 720,
      });
      continue;
    }

    const vMatch = f.path.match(VISUAL_RE);
    if (vMatch) {
      const [, pageName, visualId] = vMatch;
      const visual = parseVisual(visualId, f.content);
      if (!visual) continue;
      const arr = visualsByPage.get(pageName) || [];
      arr.push(visual);
      visualsByPage.set(pageName, arr);
    }
  }

  // Order pages: declared pageOrder first, then any pages only seen via files.
  const seen = new Set<string>();
  const orderedNames: string[] = [];
  for (const n of pageOrder) {
    if (pageMeta.has(n) || visualsByPage.has(n)) {
      orderedNames.push(n);
      seen.add(n);
    }
  }
  for (const n of pageMeta.keys()) if (!seen.has(n)) { orderedNames.push(n); seen.add(n); }
  for (const n of visualsByPage.keys()) if (!seen.has(n)) { orderedNames.push(n); seen.add(n); }

  const pages: Page[] = orderedNames.map((name) => {
    const meta = pageMeta.get(name) || { displayName: name, width: 1280, height: 720 };
    const visuals = (visualsByPage.get(name) || []).slice().sort((a, b) => a.z - b.z);
    return { name, displayName: meta.displayName, width: meta.width, height: meta.height, visuals };
  });

  return { pages };
}
