/**
 * Trino compiler (LU-7 — ABAC engine-compile v2) — `PolicyCodeSet` → REAL Trino
 * engine authorization artifacts, from the SAME policy set that already drives
 * Synapse / Unity Catalog / ADX / Purview / api-scope.
 *
 * ## Why this exists
 *
 * Before LU-7, the federated engine trusted itself. `apps/loom-trino/
 * docker-entrypoint.sh` rendered a file-based system access control whose ONLY
 * content was "these are the catalogs this deployment wired" — a catalog-level
 * deny-by-default floor with no notion of Loom's governance. Per-caller
 * narrowing lived entirely at the BFF (`lib/azure/trino-authz.ts`), so a
 * federated query's row/column governance was whatever the source system
 * happened to enforce. `LU-7` closes that: the policy set compiles to
 * authorization the ENGINE enforces — table grants, explicit denies, ROW
 * FILTERS and COLUMN MASKS — for the real signed-in principal.
 *
 * ## The two artifacts (both real, both engine-consumable)
 *
 * 1. **File-based system access control rules** (`access-control.name=file`) —
 *    the posture the shipped image runs today. Schema grounded in the Trino
 *    docs (`security/file-system-access-control`): top-level `catalogs`,
 *    `schemas`, `tables`, `impersonation`; table rules carry `user` / `group`
 *    (regexes), `catalog` / `schema` / `table` (regexes), `privileges`
 *    (`SELECT|INSERT|DELETE|UPDATE|OWNERSHIP|GRANT_SELECT`), `columns[]`
 *    (`name` / `allow` / `mask`) and `filter`. Rules are FIRST-MATCH-WINS and an
 *    unmatched table is DENIED — which is exactly why {@link buildTrinoRulesDocument}
 *    emits a per-table catch-all deny for every GOVERNED table and a global
 *    allow tail for everything the policy set does not mention (adding one
 *    policy statement must never silently lock the rest of the estate).
 *
 * 2. **OPA rego module** (`access-control.name=opa`) — the same decisions as a
 *    `package trino` policy exposing `allow`, `rowFilters` and `columnMask`,
 *    matching Trino's OPA authorizer contract (`security/opa-access-control`:
 *    `input.context.identity.user` / `.groups`, `input.action.operation`,
 *    `input.action.resource.table.{catalogName,schemaName,tableName,columns}`;
 *    row filters answer `[{"expression": …}]`, column masks answer
 *    `{"expression": …}`). Deployments that run an OPA server point
 *    `opa.policy.uri` / `opa.policy.row-filters-uri` /
 *    `opa.policy.column-masking-uri` at it.
 *
 * ## How the principal reaches the engine (the impersonation unlock)
 *
 * The JWT authenticator maps every authenticated principal onto ONE Trino user
 * (`LOOM_TRINO_SESSION_USER`, default `loom-console`) because the BFF mints a
 * workload token — the end user's identity is not in that token. Trino's
 * DEFAULT access control denies impersonation ("if neither impersonation nor
 * principal rules are defined, impersonation is not allowed"), so before LU-7
 * the engine could not tell callers apart at all. The compiled document emits
 * an **`impersonation` rule per POLICY-NAMED user** — never `.*` — which lets
 * the BFF send the signed-in UPN as `X-Trino-User`, and the engine then
 * evaluates `user`-keyed rules against the REAL caller. The threat model for
 * that grant, and why it is a net REDUCTION in reach, is documented on
 * {@link buildImpersonationRules}.
 *
 * Group-keyed rules additionally need Trino to know the caller's groups, which
 * comes from a group provider — {@link buildTrinoGroupFile} renders the file
 * provider's `groupname:user1,user2` format from Entra group membership the
 * reconcile loop resolves. Until a group file is published, group rules are
 * inert and {@link compileTrino} says so in `warnings` rather than implying
 * enforcement (`no-vaporware.md`: never claim a control that is not running).
 * `trinoGroupProvider` is therefore DERIVED from whether a group file has
 * actually been published — never asserted by the caller.
 *
 * PURE module — no Azure / Cosmos / Next imports, unit-tested under the node env.
 */

import { translateDax, safeIdent } from '@/lib/azure/rls-compiler';
import { escapeSqlLiteral, quoteIdent } from '@/lib/sql/quoting';
import type { PolicyCodeSet, PolicyPrincipal, PolicyStatement } from '../dsl';
import { type CompiledArtifact, type CompiledOp, dedupeOps } from './types';

// ---------------------------------------------------------------------------
// Identifier / literal escapers (Trino ANSI dialect)
// ---------------------------------------------------------------------------

/** Trino delimited identifier — delegated to the ONE audited quoter
 *  (`lib/sql/quoting.ts`), which is what `trino-client.ts` already uses. A
 *  local copy of the ANSI `""` doubling rule would be a second home for an
 *  injection defence, and `check-sql-quoting.mjs` does not see that form. */
export function trinoIdent(raw: string): string {
  return quoteIdent(String(raw), 'trino');
}

/** Trino string literal — `'text'`, embedded `'` doubled by the ONE audited
 *  escaper (`lib/sql/quoting.ts`), never a local copy of the doubling rule. */
export function trinoString(raw: string): string {
  return `'${escapeSqlLiteral(String(raw))}'`;
}

/** Escape a literal so it is safe inside a Trino access-control regex field. */
export function regexLiteral(raw: string): string {
  return `^${String(raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

/**
 * The Trino group name for a policy principal. Deterministic and stable across
 * a display-name change (the Entra object id is the identity), but readable
 * when a name is present so an operator can inspect the rules document.
 */
export function trinoGroupName(p: PolicyPrincipal): string {
  const base = (p.name || p.id || '').trim();
  const slug = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 96);
  return slug || `grp_${safeIdent(p.id).slice(0, 40)}`;
}

/** The Trino `user` value for a user principal — the UPN when known, else the OID. */
export function trinoUserName(p: PolicyPrincipal): string {
  return (p.name || p.id || '').trim();
}

// ---------------------------------------------------------------------------
// DAX row filter → Trino predicate
// ---------------------------------------------------------------------------

/**
 * DAX → Trino boolean predicate. `USERPRINCIPALNAME()` maps to Trino's
 * `current_user` (no parentheses — it is a built-in reference, not a function),
 * which resolves to the SESSION user, i.e. the impersonated Loom caller.
 */
export function daxFilterToTrinoSql(dax: string): { sql: string; columns: string[]; warnings: string[] } {
  return translateDax(dax, {
    identityExpr: 'current_user',
    column: (c) => trinoIdent(c),
    str: (inner) => trinoString(inner),
    and: ' AND ',
    or: ' OR ',
    not: ' NOT ',
    ne: ' <> ',
    trueLit: 'true',
    falseLit: 'false',
  });
}

// ---------------------------------------------------------------------------
// The rules document shapes (grounded in the Trino file-access-control schema)
// ---------------------------------------------------------------------------

export type TrinoPrivilege = 'SELECT' | 'INSERT' | 'DELETE' | 'UPDATE' | 'OWNERSHIP' | 'GRANT_SELECT';

export interface TrinoColumnConstraint {
  name: string;
  allow?: boolean;
  mask?: string;
}

export interface TrinoTableRule {
  user?: string;
  group?: string;
  catalog?: string;
  schema?: string;
  table?: string;
  privileges: TrinoPrivilege[];
  columns?: TrinoColumnConstraint[];
  filter?: string;
}

export interface TrinoCatalogRule {
  user?: string;
  group?: string;
  catalog?: string;
  allow: 'all' | 'read-only' | 'none';
}

export interface TrinoSchemaRule {
  user?: string;
  group?: string;
  catalog?: string;
  schema?: string;
  owner: boolean;
}

export interface TrinoImpersonationRule {
  original_user: string;
  new_user: string;
  allow?: boolean;
}

export interface TrinoRulesDocument {
  catalogs: TrinoCatalogRule[];
  schemas: TrinoSchemaRule[];
  tables: TrinoTableRule[];
  impersonation: TrinoImpersonationRule[];
}

const READ_PRIVS: TrinoPrivilege[] = ['SELECT'];
const WRITE_PRIVS: TrinoPrivilege[] = ['SELECT', 'INSERT', 'DELETE', 'UPDATE'];
const ADMIN_PRIVS: TrinoPrivilege[] = ['SELECT', 'INSERT', 'DELETE', 'UPDATE', 'OWNERSHIP', 'GRANT_SELECT'];

function privilegesFor(action: 'read' | 'write' | 'admin'): TrinoPrivilege[] {
  if (action === 'read') return READ_PRIVS;
  if (action === 'write') return WRITE_PRIVS;
  return ADMIN_PRIVS;
}

// ---------------------------------------------------------------------------
// Object parsing
// ---------------------------------------------------------------------------

export interface TrinoObjectRef {
  catalog: string;
  schema: string;
  table: string;
}

/**
 * Parse a `trino` resource object. Canonical form is `catalog.schema.table`.
 * A 2-part `schema.table` resolves against `defaultCatalog` (the deployment's
 * lake catalog) so an author who thinks in Loom-lake terms still compiles;
 * anything else is reported, never silently widened to a wildcard.
 */
export function parseTrinoObject(
  object: string,
  defaultCatalog: string,
): { ref: TrinoObjectRef | null; warning?: string } {
  const parts = String(object || '')
    .split('.')
    .map((p) => p.trim().replace(/^"(.*)"$/, '$1'))
    .filter((p) => p.length > 0);
  if (parts.length === 3) return { ref: { catalog: parts[0], schema: parts[1], table: parts[2] } };
  if (parts.length === 2) {
    return {
      ref: { catalog: defaultCatalog, schema: parts[0], table: parts[1] },
      warning: `trino object "${object}" is 2-part; resolved against the deployment lake catalog "${defaultCatalog}". Use catalog.schema.table to be explicit.`,
    };
  }
  return {
    ref: null,
    warning: `trino object "${object}" is not catalog.schema.table (or schema.table); skipped — a partial reference is never widened to a wildcard.`,
  };
}

// ---------------------------------------------------------------------------
// Compile options
// ---------------------------------------------------------------------------

export interface TrinoCompileOptions {
  /**
   * The Trino session user the JWT authenticator maps every authenticated
   * principal onto (`LOOM_TRINO_SESSION_USER`). The compiled document lets this
   * user impersonate the signed-in caller so `user`-keyed rules can match.
   */
  trinoSessionUser?: string;
  /** The catalog fronting the Loom lake (`LOOM_TRINO_ICEBERG_CATALOG`), for 2-part refs. */
  trinoDefaultCatalog?: string;
  /**
   * True when a Trino group provider is published for this deployment. When
   * false, `group`-keyed rules compile but cannot match, and the compiler says
   * so in `warnings` instead of implying an enforced control.
   */
  trinoGroupProvider?: boolean;
}

export const TRINO_SESSION_USER_DEFAULT = 'loom-console';
export const TRINO_DEFAULT_CATALOG = 'iceberg';

/**
 * The deployment-derived compile options, resolved from the environment in ONE
 * place.
 *
 * Every consumer of a compiled Trino artifact must use this. The publish path
 * (`reconcilePolicyCode`) and the serve path (the engine-rules route) compile
 * the SAME policy set and their outputs are compared by content hash, so an
 * option present on one side and absent on the other makes them disagree
 * permanently — the enforcement receipt can never converge, and worse, the
 * engine ends up governing a different table than the document an admin
 * inspects claims.
 *
 * That is not hypothetical: reconcile once built `{ ucVariant, tenantId }` by
 * hand and dropped `trinoDefaultCatalog`, so under a non-default
 * `LOOM_TRINO_ICEBERG_CATALOG` a 2-part `sales.orders` resource compiled to
 * `iceberg.sales.orders` on the publish side and `lake.sales.orders` on the
 * serve side. A hand-copied option literal is exactly the shape that drifts;
 * a shared reader cannot.
 */
export function trinoCompileOptionsFromEnv(): Required<Pick<TrinoCompileOptions, never>> & TrinoCompileOptions {
  return {
    trinoDefaultCatalog: (process.env.LOOM_TRINO_ICEBERG_CATALOG || '').trim() || undefined,
    trinoSessionUser: (process.env.LOOM_TRINO_SESSION_USER || '').trim() || undefined,
  };
}

// ---------------------------------------------------------------------------
// The compiler
// ---------------------------------------------------------------------------

/** The rule a compiled op carries, parsed back out of `op.statement`. */
export function opRule(op: CompiledOp): TrinoTableRule | null {
  try {
    const parsed = JSON.parse(op.statement);
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.privileges) ? (parsed as TrinoTableRule) : null;
  } catch {
    return null;
  }
}

function principalSelector(p: PolicyPrincipal): Pick<TrinoTableRule, 'user' | 'group'> {
  return p.kind === 'user'
    ? { user: regexLiteral(trinoUserName(p)) }
    : { group: regexLiteral(trinoGroupName(p)) };
}

function tableSelector(ref: TrinoObjectRef): Pick<TrinoTableRule, 'catalog' | 'schema' | 'table'> {
  return {
    catalog: regexLiteral(ref.catalog),
    schema: regexLiteral(ref.schema),
    table: regexLiteral(ref.table),
  };
}

function fqn(ref: TrinoObjectRef): string {
  return `${ref.catalog}.${ref.schema}.${ref.table}`;
}

function statementOps(
  stmt: PolicyStatement,
  ref: TrinoObjectRef,
  opts: Required<Pick<TrinoCompileOptions, 'trinoGroupProvider'>>,
  warnings: string[],
  summary: string[],
): CompiledOp[] {
  const ops: CompiledOp[] = [];
  const target = fqn(ref);

  // Row filter — one predicate per statement, applied to every grant rule the
  // statement emits for this table.
  let filter: string | undefined;
  const dax = stmt.condition?.rowFilter?.trim();
  if (dax) {
    const tr = daxFilterToTrinoSql(dax);
    tr.warnings.forEach((w) => warnings.push(`statement "${stmt.id}" / ${target}: ${w}`));
    if (tr.columns.length === 0) {
      warnings.push(
        `statement "${stmt.id}" / ${target}: row filter references no columns; no Trino filter emitted.`,
      );
    } else {
      filter = tr.sql;
      summary.push(`row filter: "${stmt.id}" → ${target} WHERE ${tr.sql}`);
    }
  }

  // Column masks — a masked column is served as NULL, matching the Synapse
  // compiler's `DENY SELECT ON tbl(col)` semantics (the value never leaves the
  // engine) while keeping the query shape valid.
  const maskCols = stmt.condition?.maskColumns || [];
  if (maskCols.length) summary.push(`column mask: "${stmt.id}" → ${target} [${maskCols.join(', ')}] → NULL`);

  for (const action of stmt.actions) {
    for (const p of stmt.principals) {
      if (p.kind === 'group' && !opts.trinoGroupProvider) {
        warnings.push(
          `statement "${stmt.id}" / ${target}: principal "${trinoGroupName(p)}" is a GROUP, but no Trino group `
          + 'provider is published for this deployment, so the engine cannot resolve the caller\'s groups and this '
          + 'rule will not match. Publish the group file (the reconcile loop resolves Entra membership) or target '
          + 'user principals. The BFF catalog authorization (lib/azure/trino-authz.ts) still applies.',
        );
      }
      const sel = { ...principalSelector(p), ...tableSelector(ref) };
      if (action === 'deny') {
        ops.push({
          key: `trino:deny:${target}:${p.id}:${stmt.id}`,
          kind: 'deny',
          statement: JSON.stringify({ ...sel, privileges: [] } satisfies TrinoTableRule),
          target,
          principals: [p.id],
          from: stmt.id,
        });
        continue;
      }
      // The GRANT contribution — privileges only. The row filter and the column
      // masks are SEPARATE ops (below) with their own keys, exactly as the
      // Synapse / ADX / Unity-Catalog compilers do.
      //
      // This is not cosmetic. `dedupeOps` is FIRST-WINS, so any two statements
      // that produced the same key would silently discard the second — and when
      // the filter/mask rode inside the grant op's key, an unconditional grant
      // authored before a filtered one DESTROYED the filter and the mask before
      // the document was ever built. The narrower policy lost to the broader one
      // upstream of the ordering that was supposed to be the control.
      ops.push({
        key: `trino:grant:${action}:${target}:${p.id}:${stmt.id}`,
        kind: 'grant',
        statement: JSON.stringify({ ...sel, privileges: privilegesFor(action) } satisfies TrinoTableRule),
        target,
        principals: [p.id],
        from: stmt.id,
      });
      if (filter) {
        ops.push({
          key: `trino:rls:${target}:${p.id}:${stmt.id}`,
          kind: 'rls',
          statement: JSON.stringify({ ...sel, privileges: [], filter } satisfies TrinoTableRule),
          target,
          principals: [p.id],
          from: stmt.id,
        });
      }
      for (const col of maskCols) {
        ops.push({
          key: `trino:mask:${target}:${String(col).toLowerCase()}:${p.id}:${stmt.id}`,
          kind: 'mask',
          statement: JSON.stringify({ ...sel, privileges: [], columns: [{ name: col, mask: 'NULL' }] } satisfies TrinoTableRule),
          target,
          principals: [p.id],
          from: stmt.id,
        });
      }
    }
  }
  return ops;
}

/**
 * Compile the `trino` slice of a policy set to engine rules. Pure. Emits one op
 * per (statement × table × principal × action) so the reconcile loop diffs at
 * the same granularity as every other backend.
 */
export function compileTrino(set: PolicyCodeSet, opts: TrinoCompileOptions = {}): CompiledArtifact {
  const ops: CompiledOp[] = [];
  const warnings: string[] = [];
  const summary: string[] = [];
  const defaultCatalog = (opts.trinoDefaultCatalog || TRINO_DEFAULT_CATALOG).trim() || TRINO_DEFAULT_CATALOG;
  const groupProvider = opts.trinoGroupProvider === true;

  for (const stmt of set.statements) {
    for (const res of stmt.resources) {
      if (res.backend !== 'trino') continue;
      const { ref, warning } = parseTrinoObject(res.object, defaultCatalog);
      if (warning) warnings.push(`statement "${stmt.id}": ${warning}`);
      if (!ref) continue;
      ops.push(...statementOps(stmt, ref, { trinoGroupProvider: groupProvider }, warnings, summary));
    }
  }

  const deduped = dedupeOps(ops);
  const grants = deduped.filter((o) => o.kind === 'grant').length;
  const denies = deduped.filter((o) => o.kind === 'deny').length;
  const filters = deduped.filter((o) => o.kind === 'rls').length;
  const masks = deduped.filter((o) => o.kind === 'mask').length;
  if (grants) summary.unshift(`${grants} table grant rule(s)`);
  if (denies) summary.push(`${denies} explicit deny rule(s)`);
  if (filters) summary.push(`${filters} row-filtered rule(s)`);
  if (masks) summary.push(`${masks} column-masked rule(s)`);

  return { backend: 'trino', applicable: deduped.length > 0, ops: deduped, warnings, summary };
}

// ---------------------------------------------------------------------------
// The complete rules document (what the engine actually loads)
// ---------------------------------------------------------------------------

export interface TrinoDocumentOptions extends TrinoCompileOptions {
  /**
   * The catalogs the ENGINE actually wired, as the entrypoint rendered them.
   * The console never guesses this — the engine reports its own catalog list
   * when it fetches the document, so `SHOW CATALOGS` and the catalog rules can
   * never drift apart. Absent on the publish path (reconcile has no engine to
   * ask), which is precisely why {@link rulesVersion} excludes this section.
   */
  catalogs?: Array<{ name: string; allow: 'all' | 'read-only' | 'none' }>;
  /**
   * Extra identities the mapped session user may impersonate beyond the user
   * principals the policy names. Empty by default — the grant is bounded to
   * what the policy actually describes.
   */
  additionalImpersonatedUsers?: string[];
}

/**
 * Assemble the complete file-based access-control document.
 *
 * ## Contributions are MERGED, because Trino gives one rule per match
 *
 * The compiler emits the grant, the row filter and each column mask as
 * SEPARATE ops so that `dedupeOps` (first-wins) can never let one statement
 * silently discard another's filter or mask. But Trino's `tables` rules are
 * first-match-wins and ONE rule carries privileges + `filter` + `columns`
 * together — a second rule for the same principal and table would simply never
 * be reached. So every contribution for the same (principal, table) selector is
 * merged back into a single rule here:
 *
 *   privileges → UNION      (a principal granted read by one statement and
 *                            write by another holds both)
 *   filter     → AND        (every filter that names this principal applies;
 *                            see below on why this is the safe direction)
 *   columns    → UNION      (a column masked by any statement stays masked)
 *
 * **The merge is deliberately RESTRICTIVE.** If statement A grants a principal
 * unfiltered read and statement B grants the same principal read behind a row
 * filter, the filter APPLIES. A policy author who writes a filter for a
 * principal means to constrain them; letting a broader statement elsewhere in
 * the set silently strip it is exactly the failure this merge exists to
 * prevent. A selector that ends up with masks but no grant resolves to zero
 * privileges — no grant means no access, fail-closed.
 *
 * ## ORDERING IS THE SECURITY CONTROL
 *
 * Trino evaluates `tables` rules top-to-bottom, first match wins, and DENIES a
 * table no rule matches:
 *
 *   1. explicit denies            (a `deny` statement beats every grant)
 *   2. row-filtered / masked rules (the narrower rule must win over a plain one
 *      when a caller matches BOTH — e.g. a user rule and a group rule)
 *   3. plain grants
 *   4. per-governed-table catch-all deny — every table the policy set names is
 *      deny-by-default for principals it did not grant
 *   5. global allow tail — every table the policy set does NOT name keeps its
 *      pre-policy behaviour. Trino's documented default is that "if no rules are
 *      provided at all, then access is granted", so before this document existed
 *      every table was allowed; without this tail, adding one governed table
 *      would deny the entire rest of the estate. That is a self-inflicted
 *      outage, not security.
 *
 * The catalog floor from the entrypoint is preserved in `catalogs`, so an
 * un-wired catalog stays unreachable no matter what the table tail says.
 */
export function buildTrinoRulesDocument(
  artifact: CompiledArtifact,
  opts: TrinoDocumentOptions = {},
): TrinoRulesDocument {
  const sessionUser = (opts.trinoSessionUser || TRINO_SESSION_USER_DEFAULT).trim() || TRINO_SESSION_USER_DEFAULT;

  const denies: TrinoTableRule[] = [];
  const governed = new Map<string, TrinoObjectRef>();
  /** Merged grant contributions, keyed by the rule's principal+table selector. */
  const merged = new Map<string, {
    sel: Pick<TrinoTableRule, 'user' | 'group' | 'catalog' | 'schema' | 'table'>;
    privileges: Set<TrinoPrivilege>;
    filters: string[];
    columns: Map<string, TrinoColumnConstraint>;
    /** Insertion order, so the emitted document is deterministic. */
    seq: number;
  }>();

  for (const op of artifact.ops) {
    const rule = opRule(op);
    if (!rule) continue;
    const parts = op.target.split('.');
    if (parts.length === 3) governed.set(op.target, { catalog: parts[0], schema: parts[1], table: parts[2] });
    if (op.kind === 'deny') {
      denies.push(rule);
      continue;
    }
    const sel = {
      ...(rule.user ? { user: rule.user } : {}),
      ...(rule.group ? { group: rule.group } : {}),
      catalog: rule.catalog,
      schema: rule.schema,
      table: rule.table,
    };
    const key = `${rule.user || ''}|${rule.group || ''}|${rule.catalog || ''}|${rule.schema || ''}|${rule.table || ''}`;
    let entry = merged.get(key);
    if (!entry) {
      entry = { sel, privileges: new Set(), filters: [], columns: new Map(), seq: merged.size };
      merged.set(key, entry);
    }
    for (const p of rule.privileges) entry.privileges.add(p);
    if (rule.filter && !entry.filters.includes(rule.filter)) entry.filters.push(rule.filter);
    for (const c of rule.columns || []) entry.columns.set(c.name.toLowerCase(), c);
  }

  const narrowed: Array<{ rule: TrinoTableRule; seq: number }> = [];
  const plain: Array<{ rule: TrinoTableRule; seq: number }> = [];
  for (const entry of merged.values()) {
    const privileges = ADMIN_PRIVS.filter((p) => entry.privileges.has(p));
    const columns = [...entry.columns.values()];
    // Multiple filters AND together — every constraint that names this
    // principal applies, never just the first one encountered.
    const filter = entry.filters.length === 1
      ? entry.filters[0]
      : entry.filters.length > 1
        ? entry.filters.map((f) => `(${f})`).join(' AND ')
        : undefined;
    const rule: TrinoTableRule = {
      ...entry.sel,
      privileges,
      ...(columns.length ? { columns } : {}),
      ...(filter ? { filter } : {}),
    };
    (filter || columns.length ? narrowed : plain).push({ rule, seq: entry.seq });
  }
  const bySeq = (a: { seq: number }, b: { seq: number }) => a.seq - b.seq;
  narrowed.sort(bySeq);
  plain.sort(bySeq);

  const governedCatchAll: TrinoTableRule[] = [...governed.values()].map((ref) => ({
    ...tableSelector(ref),
    privileges: [],
  }));

  const tables: TrinoTableRule[] = [
    ...denies,
    ...narrowed.map((n) => n.rule),
    ...plain.map((n) => n.rule),
    ...governedCatchAll,
    // Global tail — see the ordering note above.
    { privileges: ADMIN_PRIVS },
  ];

  const catalogs: TrinoCatalogRule[] = (opts.catalogs || []).map((c) => ({
    catalog: regexLiteral(c.name),
    allow: c.allow,
  }));
  // Anything the deployment did not wire stays denied (belt-and-suspenders —
  // Trino already denies an unmatched catalog once ANY catalog rule exists).
  catalogs.push({ catalog: '.*', allow: 'none' });

  return {
    catalogs,
    // Ownership on every wired schema keeps CREATE TABLE AS / temp joins working
    // in the writable scratch catalog; the catalog floor still gates reachability.
    schemas: [{ owner: true }],
    // The unlock: the mapped session user may become a policy-named Loom
    // principal, so `user`-keyed table rules evaluate against the REAL caller.
    // Bounded to the principals the policy actually names — see
    // {@link buildImpersonationRules} for the threat analysis.
    impersonation: buildImpersonationRules(sessionUser, artifact, opts),
    tables,
  };
}

/**
 * The `impersonation` section — and the reason it is bounded.
 *
 * Trino's default (and the pre-LU-7 posture) is that impersonation is DENIED:
 * "If neither impersonation nor principal rules are defined, impersonation is
 * not allowed." Granting it is what lets the BFF present the signed-in Loom
 * principal so per-user table rules can match at all.
 *
 * THREAT: `X-Trino-User` is a caller-asserted header. Anything that can mint a
 * bearer for the pinned Trino audience and reach the coordinator directly can
 * therefore assert an identity. That is a real property and it is stated here
 * rather than in a footnote.
 *
 * WHY IT IS NOT A WIDENING: before this document existed the engine shipped a
 * rules file with NO `tables` section at all, and Trino's documented default is
 * that "if no rules are provided at all, then access is granted". So that same
 * credential already had unrestricted SELECT on every table in every wired
 * catalog, with no impersonation needed. After this change the un-impersonated
 * mapped user matches only the global allow tail and is DENIED every governed
 * table. The credential's reach strictly SHRINKS.
 *
 * WHY IT IS STILL BOUNDED: `new_user` is restricted to the exact set of user
 * principals the policy names, rather than `.*`. A direct caller cannot invent
 * an identity that some other system's rules key on, and cannot enumerate its
 * way into a principal Loom has no policy for. When the policy names no user
 * principals, NO impersonation rule is emitted — the grant does not exist
 * until something needs it.
 *
 * The deployment can also turn the BFF half off entirely
 * (`LOOM_TRINO_IMPERSONATION=disabled`), which keeps the compiled document in
 * force while the BFF continues to present the mapped session user.
 */
export function buildImpersonationRules(
  sessionUser: string,
  artifact: CompiledArtifact,
  opts: TrinoDocumentOptions = {},
): TrinoImpersonationRule[] {
  const users = new Set<string>();
  for (const op of artifact.ops) {
    const rule = opRule(op);
    if (rule?.user) users.add(rule.user);
  }
  for (const extra of opts.additionalImpersonatedUsers || []) {
    const v = String(extra || '').trim();
    if (v) users.add(regexLiteral(v));
  }
  if (!users.size) return [];
  // One rule per named principal — an explicit, auditable list, never `.*`.
  return [...users].sort().map((u) => ({
    original_user: regexLiteral(sessionUser),
    new_user: u,
    allow: true,
  }));
}

/**
 * The Trino file group provider document — `groupname:user1,user2` lines, one
 * per group, which is what `group-provider.name=file` reads. `memberships` maps
 * a policy group principal id to the member UPNs the reconcile loop resolved
 * from Entra. Groups with no resolved members are emitted with no members
 * (an empty group matches nobody — fail-closed, never omitted-and-forgotten).
 */
export function buildTrinoGroupFile(
  set: PolicyCodeSet,
  memberships: Record<string, string[]>,
): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const stmt of set.statements) {
    const targetsTrino = stmt.resources.some((r) => r.backend === 'trino');
    if (!targetsTrino) continue;
    for (const p of stmt.principals) {
      if (p.kind !== 'group') continue;
      const name = trinoGroupName(p);
      if (seen.has(name)) continue;
      seen.add(name);
      const members = (memberships[p.id] || []).map((m) => String(m).trim()).filter(Boolean);
      lines.push(`${name}:${members.join(',')}`);
    }
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

/** Group principals a `trino` statement references — what reconcile must resolve. */
export function trinoGroupPrincipals(set: PolicyCodeSet): PolicyPrincipal[] {
  const out = new Map<string, PolicyPrincipal>();
  for (const stmt of set.statements) {
    if (!stmt.resources.some((r) => r.backend === 'trino')) continue;
    for (const p of stmt.principals) if (p.kind === 'group') out.set(p.id, p);
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// OPA rego (the `access-control.name=opa` artifact)
// ---------------------------------------------------------------------------

function regoString(raw: string): string {
  return JSON.stringify(String(raw));
}

/**
 * Compile the same policy set to an OPA `package trino` module implementing
 * Trino's OPA authorizer contract:
 *
 *   `allow`       — boolean, queried at `opa.policy.uri` (…/v1/data/trino/allow)
 *   `rowFilters`  — `[{"expression": …}]`, at `opa.policy.row-filters-uri`
 *   `columnMask`  — `{"expression": …}`, at `opa.policy.column-masking-uri`
 *
 * The module is deny-by-default for GOVERNED tables and allow for everything
 * else — identical semantics to {@link buildTrinoRulesDocument}, so a deployment
 * can switch enforcement engines without a change in behaviour.
 */
export function buildTrinoRego(set: PolicyCodeSet, opts: TrinoDocumentOptions = {}): string {
  const defaultCatalog = (opts.trinoDefaultCatalog || TRINO_DEFAULT_CATALOG).trim() || TRINO_DEFAULT_CATALOG;

  interface Grant { catalog: string; schema: string; table: string; users: string[]; groups: string[]; deny: boolean }
  const grants: Grant[] = [];
  const filters: Array<{ catalog: string; schema: string; table: string; users: string[]; groups: string[]; expression: string }> = [];
  const masks: Array<{ catalog: string; schema: string; table: string; column: string; users: string[]; groups: string[] }> = [];
  const governed = new Set<string>();

  for (const stmt of set.statements) {
    const users = stmt.principals.filter((p) => p.kind === 'user').map(trinoUserName).filter(Boolean);
    const groups = stmt.principals.filter((p) => p.kind === 'group').map(trinoGroupName).filter(Boolean);
    for (const res of stmt.resources) {
      if (res.backend !== 'trino') continue;
      const { ref } = parseTrinoObject(res.object, defaultCatalog);
      if (!ref) continue;
      governed.add(fqn(ref));
      const deny = stmt.actions.includes('deny');
      grants.push({ ...ref, users, groups, deny });
      const dax = stmt.condition?.rowFilter?.trim();
      if (dax) {
        const tr = daxFilterToTrinoSql(dax);
        if (tr.columns.length) filters.push({ ...ref, users, groups, expression: tr.sql });
      }
      for (const col of stmt.condition?.maskColumns || []) {
        masks.push({ ...ref, column: col, users, groups });
      }
    }
  }

  const L: string[] = [];
  L.push('# CSA Loom — generated from the Loom policy-as-code set (LU-7).');
  L.push('# DO NOT EDIT BY HAND: the Console recompiles this from the governance');
  L.push('# policy set; hand edits are overwritten on the next reconcile.');
  L.push('#');
  L.push('# Contract: Trino OPA access control');
  L.push('#   opa.policy.uri                → data.trino.allow        (boolean)');
  L.push('#   opa.policy.row-filters-uri    → data.trino.rowFilters   ([{expression}])');
  L.push('#   opa.policy.column-masking-uri → data.trino.columnMask   ({expression})');
  L.push('package trino');
  L.push('');
  L.push('import rego.v1');
  L.push('');
  L.push('default allow := false');
  L.push('');
  L.push('# The caller, as Trino reports it.');
  L.push('caller_user := input.context.identity.user');
  L.push('caller_groups := object.get(input.context.identity, "groups", [])');
  L.push('');

  // ── The CATALOG FLOOR — the same outer gate the file-rules document carries.
  // Omitting it made this module strictly MORE PERMISSIVE than the document it
  // claims equivalence with: a caller naming an un-wired catalog would fall
  // through to the table rules and be allowed. The list is engine-reported,
  // exactly as in the file document; with none supplied NO catalog gate is
  // emitted and the module SAYS SO rather than silently gating on an empty set.
  const wiredCatalogs = (opts.catalogs || []).map((c) => c.name);
  if (wiredCatalogs.length) {
    L.push('# Catalog floor — only the catalogs this deployment WIRED are reachable.');
    L.push('wired_catalogs := {');
    L.push(wiredCatalogs.map((c) => `  ${regoString(c)},`).join('\n'));
    L.push('}');
    L.push('');
    L.push('# The catalog this action names, whichever resource shape carries it.');
    L.push('catalog_names contains input.action.resource.catalog.name');
    L.push('catalog_names contains input.action.resource.table.catalogName');
    L.push('catalog_names contains input.action.resource.schema.catalogName');
    L.push('');
    L.push('default catalog_ok := true');
    L.push('catalog_ok := false if {');
    L.push('  some c in catalog_names');
    L.push('  not wired_catalogs[c]');
    L.push('}');
    L.push('');
  } else {
    L.push('# NOTE: no engine catalog list was supplied when this module was');
    L.push('# generated, so it carries NO catalog floor while the file-based');
    L.push('# document does. Regenerate with the catalog list for equivalence.');
    L.push('default catalog_ok := true');
    L.push('');
  }

  // ── IMPERSONATION — bounded to the policy-named users, matching the file
  // document's `impersonation` section. Trino asks the OPA authorizer via the
  // `ImpersonateUser` operation; with no rule it is denied, which is both the
  // correct default and the pre-LU-7 posture.
  const impersonatedUsers = [...new Set(
    set.statements.flatMap((st) => (st.resources.some((r) => r.backend === 'trino')
      ? st.principals.filter((p) => p.kind === 'user').map(trinoUserName).filter(Boolean)
      : [])),
  )].sort();
  const regoSessionUser = (opts.trinoSessionUser || TRINO_SESSION_USER_DEFAULT).trim() || TRINO_SESSION_USER_DEFAULT;
  L.push('# Impersonation — the mapped session user may become a POLICY-NAMED');
  L.push('# principal, never an arbitrary identity. An empty set denies it.');
  L.push(`session_user := ${regoString(regoSessionUser)}`);
  L.push('impersonatable := {');
  L.push(impersonatedUsers.map((u) => `  ${regoString(u)},`).join('\n'));
  L.push('}');
  L.push('');
  L.push('allow if {');
  L.push('  input.action.operation == "ImpersonateUser"');
  L.push('  caller_user == session_user');
  L.push('  impersonatable[input.action.resource.user.user]');
  L.push('}');
  L.push('');
  L.push('# The table this action touches (absent for non-table operations).');
  L.push('tbl := input.action.resource.table');
  L.push('');
  L.push('# Every table the Loom policy set governs. A table NOT listed here keeps');
  L.push('# its pre-policy behaviour; a table listed here is deny-by-default.');
  L.push('governed := {');
  L.push([...governed].sort().map((t) => `  ${regoString(t)},`).join('\n'));
  L.push('}');
  L.push('');
  L.push('table_fqn := sprintf("%s.%s.%s", [tbl.catalogName, tbl.schemaName, tbl.tableName])');
  L.push('');
  L.push('# 1. Operations with no table resource (SHOW CATALOGS, SELECT 1, …) are');
  L.push('#    outside the TABLE policy, but still pass the catalog floor.');
  L.push('allow if {');
  L.push('  not input.action.resource.table');
  L.push('  input.action.operation != "ImpersonateUser"');
  L.push('  catalog_ok');
  L.push('}');
  L.push('');
  L.push('# 2. A table the policy set does not govern is unchanged.');
  L.push('allow if {');
  L.push('  input.action.resource.table');
  L.push('  catalog_ok');
  L.push('  not governed[table_fqn]');
  L.push('}');
  L.push('');
  L.push('# 3. A governed table is allowed only by an explicit, non-denied grant.');
  L.push('allow if {');
  L.push('  input.action.resource.table');
  L.push('  catalog_ok');
  L.push('  governed[table_fqn]');
  L.push('  some g in grants');
  L.push('  g.table_fqn == table_fqn');
  L.push('  not g.deny');
  L.push('  principal_matches(g)');
  L.push('  not denied_for_caller(table_fqn)');
  L.push('}');
  L.push('');
  L.push('principal_matches(g) if some u in g.users; u == caller_user');
  L.push('principal_matches(g) if some gr in g.groups; gr in caller_groups');
  L.push('');
  L.push('denied_for_caller(t) if {');
  L.push('  some g in grants');
  L.push('  g.table_fqn == t');
  L.push('  g.deny');
  L.push('  principal_matches(g)');
  L.push('}');
  L.push('');
  L.push('grants := [');
  for (const g of grants) {
    L.push(
      `  {"table_fqn": ${regoString(fqn(g))}, "users": ${JSON.stringify(g.users)}, `
      + `"groups": ${JSON.stringify(g.groups)}, "deny": ${g.deny}},`,
    );
  }
  L.push(']');
  L.push('');
  L.push('# Row filters — Trino expects a list of {"expression": …}.');
  L.push('row_filter_rules := [');
  for (const f of filters) {
    L.push(
      `  {"table_fqn": ${regoString(fqn(f))}, "users": ${JSON.stringify(f.users)}, `
      + `"groups": ${JSON.stringify(f.groups)}, "expression": ${regoString(f.expression)}},`,
    );
  }
  L.push(']');
  L.push('');
  L.push('rowFilters contains {"expression": r.expression} if {');
  L.push('  some r in row_filter_rules');
  L.push('  r.table_fqn == table_fqn');
  L.push('  principal_matches(r)');
  L.push('}');
  L.push('');
  L.push('# Column masks — Trino expects a single {"expression": …} per column.');
  L.push('mask_rules := [');
  for (const m of masks) {
    L.push(
      `  {"table_fqn": ${regoString(fqn(m))}, "column": ${regoString(m.column)}, `
      + `"users": ${JSON.stringify(m.users)}, "groups": ${JSON.stringify(m.groups)}},`,
    );
  }
  L.push(']');
  L.push('');
  L.push('columnMask := {"expression": "NULL"} if {');
  L.push('  some m in mask_rules');
  L.push('  m.table_fqn == sprintf("%s.%s.%s", [');
  L.push('    input.action.resource.column.catalogName,');
  L.push('    input.action.resource.column.schemaName,');
  L.push('    input.action.resource.column.tableName,');
  L.push('  ])');
  L.push('  m.column == input.action.resource.column.columnName');
  L.push('  principal_matches(m)');
  L.push('}');
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Content identity (the receipt the engine's fetch is checked against)
// ---------------------------------------------------------------------------

/**
 * A stable, dependency-free content hash of a rules document (FNV-1a, hex).
 * Published with the document so `/admin/policy-code` can prove the ENGINE
 * fetched the version currently stored — a real receipt, not an assumption
 * that a write reached the engine.
 *
 * ## The hash covers the POLICY, never the engine's catalog list
 *
 * `catalogs` is ENGINE STATE, not policy: the coordinator reports its own
 * mounted catalogs with each fetch and the document is rendered around them.
 * The publisher (reconcile) has no catalog list; the fetch path always has one.
 * Hashing the whole document therefore made the two sides deterministically
 * unequal FOREVER — `lastFetch.version` could never equal `doc.version`, so the
 * enforcement status was permanently `stale`, reconcile could never report
 * `applied`, and the detail string blamed an unreachable Console while the
 * engine was in fact fetching successfully every refresh interval. A status
 * surface that cannot report success is worse than none, and an error message
 * asserting a cause it did not establish is the `deploy-integrity.md` R7 class.
 *
 * Hashing the policy-derived sections only makes the version mean what it
 * claims: "this is the policy the engine is enforcing". A catalog appearing or
 * disappearing is not a policy change and must not read as drift.
 */
export function rulesVersion(doc: TrinoRulesDocument): string {
  const text = JSON.stringify({
    schemas: doc.schemas,
    tables: doc.tables,
    impersonation: doc.impersonation,
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
