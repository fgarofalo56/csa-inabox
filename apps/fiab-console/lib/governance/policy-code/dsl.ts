/**
 * Governance-as-Code — the `policy-as-code` DSL (WS-10.2 / BTB-8).
 *
 * A typed, backend-neutral policy set: principals (Entra groups/users) ×
 * resources (a backend + a fully-qualified object) × actions (read/write/admin/
 * deny) × conditions (row filter, column masks, sensitivity marking). It is a
 * DATA artifact — authored via the `admin/policy-code` wizard and stored/edited
 * as JSON (rendered as YAML for review). It is NOT a freeform config surface:
 * every field is a typed enum/list the wizard populates (per
 * `.claude/rules/*` no-freeform-config), so the DSL itself being a data document
 * is allowed.
 *
 * One `PolicyCodeSet` compiles to EVERY applicable backend in one pass
 * (`compile.ts`) and drives the reconcile loop (`reconcile.ts`). No Azure /
 * network imports here — this module is pure and unit-tested.
 */

export const POLICY_CODE_API_VERSION = 'loom.governance/v1';

// ── Backends the DSL compiles to ──────────────────────────────────────────────
export type PolicyBackend = 'synapse' | 'unity-catalog' | 'adx' | 'purview' | 'api-scope';

export const POLICY_BACKENDS: readonly PolicyBackend[] = [
  'synapse',
  'unity-catalog',
  'adx',
  'purview',
  'api-scope',
] as const;

export const BACKEND_LABELS: Record<PolicyBackend, string> = {
  synapse: 'Synapse SQL (DENY / RLS)',
  'unity-catalog': 'Unity Catalog (Databricks + OSS-UC)',
  adx: 'Azure Data Explorer (RBAC + RLS)',
  purview: 'Microsoft Purview (classification / marking)',
  'api-scope': 'API scope gates',
};

// ── Principals ────────────────────────────────────────────────────────────────
export type PolicyPrincipalKind = 'group' | 'user';

export interface PolicyPrincipal {
  kind: PolicyPrincipalKind;
  /** Entra object id — group id for groups, user OID for users. */
  id: string;
  /** Display name / UPN / group name (the SQL/UC grantable principal name). */
  name?: string;
}

// ── Actions ───────────────────────────────────────────────────────────────────
export type PolicyAction = 'read' | 'write' | 'admin' | 'deny';
export const POLICY_ACTIONS: readonly PolicyAction[] = ['read', 'write', 'admin', 'deny'] as const;

// ── Conditions (row/column filters + markings) ────────────────────────────────
export interface PolicyCondition {
  /**
   * A DAX boolean filter (same subset the RLS compiler understands, e.g.
   * `[Region] = USERPRINCIPALNAME()`), compiled per backend into a row
   * predicate. Empty = no row filter.
   */
  rowFilter?: string;
  /** Columns to hide/null-out for the statement's principals. */
  maskColumns?: string[];
  /** A sensitivity marking / label to apply (Purview classification). */
  marking?: string;
}

// ── Resource (a backend + a fully-qualified object) ───────────────────────────
export interface PolicyResource {
  backend: PolicyBackend;
  /**
   * Fully-qualified object, per backend:
   *   synapse        `schema.table`
   *   unity-catalog  `catalog.schema.table`
   *   adx            `database/table` or just `database`
   *   purview        asset qualifiedName / collection name
   *   api-scope      a route glob, e.g. `/api/items/warehouse/*`
   */
  object: string;
}

export interface PolicyStatement {
  id: string;
  description?: string;
  principals: PolicyPrincipal[];
  resources: PolicyResource[];
  actions: PolicyAction[];
  condition?: PolicyCondition;
}

export interface PolicyCodeSet {
  apiVersion: string;
  name: string;
  description?: string;
  statements: PolicyStatement[];
  updatedAt?: string;
  updatedBy?: string;
}

// ── Constructors ──────────────────────────────────────────────────────────────
export function emptyPolicyCodeSet(name = 'Untitled policy set'): PolicyCodeSet {
  return { apiVersion: POLICY_CODE_API_VERSION, name, statements: [] };
}

// ── Normalize (defensive read of arbitrary stored/imported JSON) ──────────────
function str(x: unknown): string {
  return typeof x === 'string' ? x.trim() : '';
}
function strList(x: unknown): string[] {
  return Array.isArray(x) ? x.map(str).filter(Boolean) : [];
}

function normalizePrincipal(x: any): PolicyPrincipal | null {
  const id = str(x?.id);
  if (!id) return null;
  const kind: PolicyPrincipalKind = x?.kind === 'user' ? 'user' : 'group';
  const name = str(x?.name) || undefined;
  return { kind, id, name };
}

function normalizeResource(x: any): PolicyResource | null {
  const object = str(x?.object);
  if (!object) return null;
  const backend = POLICY_BACKENDS.includes(x?.backend) ? (x.backend as PolicyBackend) : null;
  if (!backend) return null;
  return { backend, object };
}

function normalizeCondition(x: any): PolicyCondition | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const rowFilter = str(x.rowFilter) || undefined;
  const maskColumns = strList(x.maskColumns);
  const marking = str(x.marking) || undefined;
  if (!rowFilter && maskColumns.length === 0 && !marking) return undefined;
  return {
    ...(rowFilter ? { rowFilter } : {}),
    ...(maskColumns.length ? { maskColumns } : {}),
    ...(marking ? { marking } : {}),
  };
}

function normalizeStatement(x: any, idx: number): PolicyStatement {
  const principals = Array.isArray(x?.principals)
    ? x.principals.map(normalizePrincipal).filter((p: PolicyPrincipal | null): p is PolicyPrincipal => !!p)
    : [];
  const resources = Array.isArray(x?.resources)
    ? x.resources.map(normalizeResource).filter((r: PolicyResource | null): r is PolicyResource => !!r)
    : [];
  const actions = Array.isArray(x?.actions)
    ? (x.actions.filter((a: unknown): a is PolicyAction => POLICY_ACTIONS.includes(a as PolicyAction)) as PolicyAction[])
    : [];
  return {
    id: str(x?.id) || `stmt-${idx + 1}`,
    description: str(x?.description) || undefined,
    principals,
    resources,
    actions,
    condition: normalizeCondition(x?.condition),
  };
}

/** Coerce arbitrary JSON (stored doc or imported file) into a well-formed set. */
export function normalizePolicyCodeSet(raw: unknown): PolicyCodeSet {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const statements = Array.isArray(p.statements) ? p.statements.map(normalizeStatement) : [];
  return {
    apiVersion: str(p.apiVersion) || POLICY_CODE_API_VERSION,
    name: str(p.name) || 'Untitled policy set',
    description: str(p.description) || undefined,
    statements,
    updatedAt: str(p.updatedAt) || undefined,
    updatedBy: str(p.updatedBy) || undefined,
  };
}

// ── Validation ────────────────────────────────────────────────────────────────
export interface PolicyValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Structural validation — catches empty/dangling statements, unknown enums, and
 * conditions on the wrong backend, BEFORE compilation. Pure.
 */
export function validatePolicyCodeSet(set: PolicyCodeSet): PolicyValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!set.name) errors.push('Policy set needs a name.');
  if (set.apiVersion !== POLICY_CODE_API_VERSION) {
    warnings.push(`apiVersion "${set.apiVersion}" is not "${POLICY_CODE_API_VERSION}"; compiling on a best-effort basis.`);
  }
  if (!set.statements.length) errors.push('Policy set has no statements.');

  const seen = new Set<string>();
  for (const s of set.statements) {
    const tag = `statement "${s.id}"`;
    if (seen.has(s.id)) errors.push(`Duplicate statement id "${s.id}".`);
    seen.add(s.id);
    if (!s.principals.length) errors.push(`${tag}: no principals.`);
    if (!s.resources.length) errors.push(`${tag}: no resources.`);
    if (!s.actions.length) errors.push(`${tag}: no actions.`);

    const backends = new Set(s.resources.map((r) => r.backend));
    // Row filter / column mask only apply where the engine can enforce them.
    if (s.condition?.rowFilter || s.condition?.maskColumns?.length) {
      const enforceable: PolicyBackend[] = ['synapse', 'unity-catalog', 'adx'];
      const canEnforce = [...backends].some((b) => enforceable.includes(b));
      if (!canEnforce) {
        warnings.push(
          `${tag}: a row filter / column mask is set but no resource targets a backend that enforces it ` +
            `(synapse / unity-catalog / adx); it will be ignored.`,
        );
      }
    }
    if (s.condition?.marking && !backends.has('purview')) {
      warnings.push(`${tag}: a marking "${s.condition.marking}" is set but no resource targets the purview backend.`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Parse a DSL document from a JSON string, a YAML-ish string, or an object. */
export function parsePolicyCodeSet(input: string | object): PolicyCodeSet {
  if (typeof input === 'object') return normalizePolicyCodeSet(input);
  const text = String(input).trim();
  if (!text) return emptyPolicyCodeSet();
  // JSON first (the canonical wizard artifact).
  try {
    return normalizePolicyCodeSet(JSON.parse(text));
  } catch {
    // Fall through to the minimal YAML reader.
  }
  return normalizePolicyCodeSet(fromYaml(text));
}

/** Backends that actually appear in the set (drives the "≥4 backends" claim). */
export function backendsInSet(set: PolicyCodeSet): PolicyBackend[] {
  const out = new Set<PolicyBackend>();
  for (const s of set.statements) for (const r of s.resources) out.add(r.backend);
  // A marking implies the purview backend even if no purview resource is named.
  if (set.statements.some((s) => s.condition?.marking)) out.add('purview');
  return POLICY_BACKENDS.filter((b) => out.has(b));
}

// ── Minimal YAML render/read (no dependency; for review + import) ─────────────
/**
 * Render a policy set as YAML for the review pane. Deterministic, dependency-
 * free, and round-trippable by {@link fromYaml} for the shapes this DSL emits.
 */
export function toYaml(set: PolicyCodeSet): string {
  const lines: string[] = [];
  const scalar = (v: unknown): string => {
    const s = String(v);
    return /[:#\-?{}[\],&*!|>'"%@`]|^\s|\s$|^$/.test(s) ? JSON.stringify(s) : s;
  };
  lines.push(`apiVersion: ${scalar(set.apiVersion)}`);
  lines.push(`name: ${scalar(set.name)}`);
  if (set.description) lines.push(`description: ${scalar(set.description)}`);
  lines.push('statements:');
  for (const s of set.statements) {
    lines.push(`  - id: ${scalar(s.id)}`);
    if (s.description) lines.push(`    description: ${scalar(s.description)}`);
    lines.push('    principals:');
    for (const p of s.principals) {
      lines.push(`      - kind: ${p.kind}`);
      lines.push(`        id: ${scalar(p.id)}`);
      if (p.name) lines.push(`        name: ${scalar(p.name)}`);
    }
    lines.push('    resources:');
    for (const r of s.resources) {
      lines.push(`      - backend: ${r.backend}`);
      lines.push(`        object: ${scalar(r.object)}`);
    }
    lines.push(`    actions: [${s.actions.join(', ')}]`);
    if (s.condition) {
      lines.push('    condition:');
      if (s.condition.rowFilter) lines.push(`      rowFilter: ${scalar(s.condition.rowFilter)}`);
      if (s.condition.maskColumns?.length) lines.push(`      maskColumns: [${s.condition.maskColumns.map(scalar).join(', ')}]`);
      if (s.condition.marking) lines.push(`      marking: ${scalar(s.condition.marking)}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Minimal YAML reader for the exact shape {@link toYaml} emits (2-space indent,
 * `- ` list items, `key: value`, inline `[a, b]` arrays). Not a general YAML
 * parser — JSON is the canonical format; this only exists so a pasted-back YAML
 * review pane imports. Falls back to an empty set on anything it can't read.
 */
export function fromYaml(text: string): unknown {
  const unquote = (v: string): string => {
    const t = v.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      try {
        return JSON.parse(t.startsWith("'") ? `"${t.slice(1, -1).replace(/"/g, '\\"')}"` : t);
      } catch {
        return t.slice(1, -1);
      }
    }
    return t;
  };
  const parseInline = (v: string): unknown => {
    const t = v.trim();
    if (t.startsWith('[') && t.endsWith(']')) {
      const inner = t.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(',').map((x) => unquote(x.trim()));
    }
    return unquote(t);
  };

  const root: any = { statements: [] };
  let curStmt: any = null;
  let listKey: string | null = null; // 'principals' | 'resources' | 'condition'
  let curItem: any = null;

  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.replace(/^\s+/, '').length;
    const line = raw.trim();

    if (indent === 0) {
      const [k, ...rest] = line.split(':');
      const val = rest.join(':').trim();
      if (k === 'statements') root.statements = [];
      else root[k] = parseInline(val);
      curStmt = null;
      continue;
    }
    if (indent === 2 && line.startsWith('- ')) {
      curStmt = {};
      root.statements.push(curStmt);
      listKey = null;
      curItem = null;
      const [k, ...rest] = line.slice(2).split(':');
      curStmt[k.trim()] = parseInline(rest.join(':').trim());
      continue;
    }
    if (indent === 4 && curStmt) {
      const [k, ...rest] = line.split(':');
      const key = k.trim();
      const val = rest.join(':').trim();
      if (key === 'principals' || key === 'resources') {
        listKey = key;
        curStmt[key] = [];
        curItem = null;
      } else if (key === 'condition') {
        curStmt.condition = {};
        listKey = 'condition';
        curItem = null;
      } else {
        curStmt[key] = parseInline(val);
        listKey = null;
      }
      continue;
    }
    if (indent >= 6 && curStmt && listKey === 'condition') {
      const [k, ...rest] = line.split(':');
      curStmt.condition[k.trim()] = parseInline(rest.join(':').trim());
      continue;
    }
    if (indent >= 6 && curStmt && listKey && listKey !== 'condition') {
      if (line.startsWith('- ')) {
        curItem = {};
        curStmt[listKey].push(curItem);
        const [k, ...rest] = line.slice(2).split(':');
        curItem[k.trim()] = parseInline(rest.join(':').trim());
      } else if (curItem) {
        // A continuation field of the current list item (deeper indent).
        const [k, ...rest] = line.split(':');
        curItem[k.trim()] = parseInline(rest.join(':').trim());
      }
      continue;
    }
  }
  return root;
}
