/**
 * N7e — Trino Federated SQL: ENGINE-LEVEL CATALOG AUTHORIZATION (deny-by-default).
 *
 * PURE module. ZERO Azure / Cosmos / Next imports (same discipline as
 * `lib/auth/pdp/resource-ref.ts`), so it unit-tests under the vitest node env and
 * imports cleanly into BOTH the BFF route (`app/api/sql/trino/route.ts`) and the
 * server-only client (`lib/azure/trino-client.ts`).
 *
 * ## The gap this closes (why #2641 stayed red for three rounds)
 *
 * Round 3 shipped AUTHENTICATION — Trino's JWT authenticator, audience pinned to
 * the Console app registration — but NO AUTHORIZATION. `docker-entrypoint.sh`
 * enabled the authenticator and mapped every principal onto ONE Trino user
 * (`loom-console`), but never wrote `access-control.properties`, so the engine
 * fell through to Trino's built-in `AllowAllSystemAccessControl`: any caller who
 * passed authentication could query EVERY catalog, every schema, every table.
 * The BFF route ran whatever SQL it was handed with no per-caller catalog
 * restriction. "Who can run federated queries against which catalogs" had exactly
 * one answer — everyone authenticated, against everything. Internal ingress is a
 * NETWORK control, JWT auth is an AUTHENTICATION control; neither is
 * authorization. That is the "provably incomplete engine-level authorization
 * posture".
 *
 * ## The model — deny-by-default + explicit grant
 *
 * Authorization is resolved HERE, at the BFF, because the BFF is the only layer
 * that holds the caller's real Loom identity (the engine collapses every caller
 * to `loom-console`, so it cannot tell callers apart — see the honest limit
 * below). Two catalog classes:
 *
 *   1. **Built-in catalogs** — the deployment's OWN resources: `system`, `jmx`,
 *      `memory`, and the Loom lake catalog (`iceberg` /
 *      `LOOM_TRINO_ICEBERG_CATALOG`). Open to any SIGNED-IN caller, exactly like
 *      the DuckDB / Synapse-Serverless SQL Lab tiers — querying your own lake is
 *      not a privilege escalation. Uniform across callers.
 *
 *   2. **External / federation catalogs** — an operator-wired PostgreSQL / MySQL /
 *      Kafka / MongoDB source (rendered by the entrypoint from
 *      `LOOM_TRINO_CATALOG_<NAME>`). These hold data OUTSIDE the lake, so wiring a
 *      source is NOT the same as authorizing every signed-in user to read it.
 *      Each external catalog is **DENY-BY-DEFAULT** and becomes reachable only
 *      through an explicit grant in `LOOM_TRINO_CATALOG_POLICY` — either
 *      `"signed-in"` (open to all authenticated users) or a principal set
 *      (`groups` / `oids` / `upns`). A catalog with no grant is refused.
 *
 * A tenant admin (`isTenantAdmin`, fail-closed) reaches every configured catalog.
 *
 * Because a fresh install has NO external catalogs (the entrypoint renders only
 * `jmx` + `memory`, plus `iceberg` once the N1 IRC is wired), the DEFAULT
 * deployment is fully functional with NO policy set — the built-ins are open —
 * so this is not a day-one gate (loom_default_on_opt_out / G2). The grant is
 * required ONLY when an operator opts into an external federation source, at which
 * point "who may read it" is a security question that must be answered, not a
 * gate on a built-in capability.
 *
 * ## Enforcement path (route wiring)
 *
 * The route resolves `principal -> allowedCatalogs`, extracts the catalogs a
 * statement references, and DENIES (403, audited) when any referenced catalog is
 * outside the allowed set — before a single byte reaches the coordinator. The
 * structured cross-source join builder yields EXACT catalog knowledge (left +
 * right), so the primary federation UX is fully governed. Raw SQL is extracted
 * conservatively; when a reference cannot be attributed with certainty
 * ({@link extractReferencedCatalogs} `resolvedFully:false`) the request is allowed
 * ONLY for a caller who may already reach every configured catalog (nothing they
 * could touch is forbidden), and is otherwise DENIED fail-closed.
 *
 * ## Defense in depth + the honest limit
 *
 * The engine also carries a file-based system access control (deny-by-default,
 * rendered by `apps/loom-trino/docker-entrypoint.sh`) so a DIRECT in-VNet caller
 * that bypasses this route is still restricted to the wired catalogs at the
 * engine — the round-1 "sibling container POSTs /v1/statement" hole is closed at
 * the engine, not only the BFF. But because every caller maps to `loom-console`,
 * the engine control is UNIFORM: it cannot narrow a catalog to a specific Loom
 * group. Per-caller narrowing therefore lives at the BFF (here). Restoring the
 * signed-in principal AT THE ENGINE (so the engine could enforce per-group rules
 * itself) needs delegated tokens / an impersonation rules file and is tracked as
 * the documented follow-up — it does not weaken this layer, it would add a second
 * enforcement point.
 */

// ---------------------------------------------------------------------------
// Caller identity (mirrors lib/auth/pdp Principal + the claims the session holds)
// ---------------------------------------------------------------------------

/** The authenticated Loom caller, as the route resolves it from `session.claims`
 *  plus the fail-closed tenant-admin tier (`isTenantAdmin`). */
export interface TrinoPrincipal {
  oid: string;
  upn: string;
  /** Entra group object-ids the session cookie carries at sign-in (claims.groups). */
  groups: string[];
  /** Entra tenant id (claims.tid); informational for the audit row. */
  tenantId?: string;
  /** True when the caller is a Loom tenant admin (reaches every configured catalog). */
  tenantAdmin: boolean;
}

// ---------------------------------------------------------------------------
// Policy model
// ---------------------------------------------------------------------------

/**
 * Who may reach one catalog. `"signed-in"` = any authenticated caller; otherwise
 * a principal set (a caller matches when their oid / upn / any group is listed).
 * An empty principal set matches NOBODY (a hard, explicit lock).
 */
export type CatalogAccess =
  | 'signed-in'
  | {
      groups?: string[];
      oids?: string[];
      upns?: string[];
    };

/** The deployment's per-catalog grant table (parsed from LOOM_TRINO_CATALOG_POLICY). */
export interface CatalogPolicy {
  /** catalog name (lower-cased) -> access rule. Absent = deny (for non-built-ins). */
  catalogs: Record<string, CatalogAccess>;
}

/** The env var the bicep hands the Console app — the single source of catalog grants. */
export const CATALOG_POLICY_ENV = 'LOOM_TRINO_CATALOG_POLICY';

/**
 * Built-in, always-configured catalogs — the deployment's OWN resources, open to
 * any signed-in caller. `system`/`jmx`/`memory` are in-process; the lake catalog
 * name is deployment-configurable (defaults to `iceberg`).
 */
export function builtinOpenCatalogs(icebergCatalog?: string): Set<string> {
  const lake = (icebergCatalog || 'iceberg').trim().toLowerCase() || 'iceberg';
  return new Set(['system', 'jmx', 'memory', lake]);
}

/**
 * Parse `LOOM_TRINO_CATALOG_POLICY`. Shape (all keys lower-cased):
 *
 *   { "sales": "signed-in",
 *     "hr":    { "groups": ["<entra-group-oid>"] },
 *     "fin":   { "oids": ["<user-oid>"], "upns": ["cfo@contoso.com"] } }
 *
 * A malformed / empty value yields an EMPTY policy — deny-by-default for every
 * non-built-in catalog (fail-closed: a broken policy never silently opens a
 * source). Unknown rule shapes for a catalog collapse to the empty principal set
 * (locked), never to open.
 */
export function parseCatalogPolicy(raw: string | undefined | null): CatalogPolicy {
  const out: CatalogPolicy = { catalogs: {} };
  const text = (raw || '').trim();
  if (!text) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out; // fail-closed
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  // Accept either { catalogs: {...} } or a bare { <catalog>: rule } map.
  const map = (parsed as Record<string, unknown>).catalogs;
  const table = (map && typeof map === 'object' && !Array.isArray(map))
    ? (map as Record<string, unknown>)
    : (parsed as Record<string, unknown>);
  for (const [name, rule] of Object.entries(table)) {
    const key = String(name).trim().toLowerCase();
    if (!key) continue;
    out.catalogs[key] = normalizeRule(rule);
  }
  return out;
}

function normalizeRule(rule: unknown): CatalogAccess {
  if (typeof rule === 'string') {
    return rule.trim().toLowerCase() === 'signed-in' ? 'signed-in' : { }; // unknown string => locked
  }
  if (rule && typeof rule === 'object' && !Array.isArray(rule)) {
    const r = rule as Record<string, unknown>;
    // An explicit "allow" wrapper is honored too: { allow: "signed-in" | {...} }.
    if ('allow' in r) return normalizeRule(r.allow);
    const asStrArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : [];
    return {
      groups: asStrArr(r.groups),
      oids: asStrArr(r.oids),
      upns: asStrArr(r.upns),
    };
  }
  return {}; // locked
}

/** Does this principal satisfy one catalog access rule? */
export function principalMatchesRule(principal: TrinoPrincipal, rule: CatalogAccess): boolean {
  if (rule === 'signed-in') return true;
  const oid = (principal.oid || '').toLowerCase();
  const upn = (principal.upn || '').toLowerCase();
  const groups = (principal.groups || []).map((g) => g.toLowerCase());
  if (rule.oids && rule.oids.includes(oid)) return true;
  if (rule.upns && rule.upns.includes(upn)) return true;
  if (rule.groups && rule.groups.some((g) => groups.includes(g))) return true;
  return false;
}

/**
 * Every catalog the DEPLOYMENT authorizes for someone: the built-ins plus every
 * catalog named in the policy. Used to decide whether a caller is "unrestricted"
 * (may reach everything the deployment configured) for the conservative raw-SQL
 * path.
 */
export function configuredCatalogs(policy: CatalogPolicy, builtins: Set<string>): Set<string> {
  const out = new Set<string>(builtins);
  for (const name of Object.keys(policy.catalogs)) out.add(name);
  return out;
}

/**
 * The set of catalogs THIS principal may reach: the built-ins (open to any
 * signed-in caller) plus every policy catalog whose rule the principal matches.
 * A tenant admin reaches every configured catalog.
 */
export function resolveAllowedCatalogs(
  principal: TrinoPrincipal,
  policy: CatalogPolicy,
  builtins: Set<string>,
): Set<string> {
  if (principal.tenantAdmin) return configuredCatalogs(policy, builtins);
  const allowed = new Set<string>(builtins);
  for (const [name, rule] of Object.entries(policy.catalogs)) {
    if (principalMatchesRule(principal, rule)) allowed.add(name);
  }
  return allowed;
}

// ---------------------------------------------------------------------------
// Statement -> referenced catalogs (conservative extraction)
// ---------------------------------------------------------------------------

/** A Trino identifier segment: a bare word, or an ANSI double-quoted string. */
const IDENT = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_]*)';
// A fully-qualified 3-part reference: catalog.schema.table (each part IDENT).
const THREE_PART = new RegExp(`(${IDENT})\\s*\\.\\s*(${IDENT})\\s*\\.\\s*(${IDENT})`, 'g');
// FROM / JOIN / INTO / UPDATE / TABLE <ref> — the table-position keywords whose
// operand resolves against the SESSION catalog when it is NOT 3-part.
const TABLE_POS = new RegExp(
  `\\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\\s+(${IDENT})(\\s*\\.\\s*${IDENT})?(\\s*\\.\\s*${IDENT})?`,
  'gi',
);
// USE <catalog>[.<schema>].
const USE_RE = new RegExp(`\\bUSE\\s+(${IDENT})`, 'gi');
// SHOW SCHEMAS|TABLES|COLUMNS|VIEWS ... FROM|IN <catalog>[.<schema>] — the catalog
// is the FIRST identifier after FROM/IN. Anchored to SHOW so a plain
// `SELECT ... FROM schema.table` is NEVER mis-read as `FROM <catalog>.<schema>`.
const SHOW_RE = new RegExp(
  `\\bSHOW\\s+(?:SCHEMAS|TABLES|COLUMNS|VIEWS|MATERIALIZED\\s+VIEWS)\\b[\\s\\S]*?\\b(?:FROM|IN)\\s+(${IDENT})`,
  'gi',
);

function unquoteIdent(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/""/g, '"').toLowerCase();
  return t.toLowerCase();
}

/** Strip string/line/block comments so a catalog name inside a literal or a
 *  comment is never mistaken for a real reference (and cannot smuggle one past
 *  the extractor). */
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

export interface ReferencedCatalogs {
  /** Distinct catalog names (lower-cased) the statement provably references. */
  catalogs: string[];
  /**
   * FALSE when the statement contains a table-position reference that is NOT
   * fully catalog-qualified (a bare `table` or `schema.table`), so it resolves
   * against the session catalog and the extractor cannot attribute it with
   * certainty. The route treats this as a fail-closed signal for restricted
   * callers.
   */
  resolvedFully: boolean;
}

/**
 * Conservatively extract the catalogs a Trino statement references. Deny-safe by
 * construction: a reference the extractor cannot attribute sets
 * `resolvedFully:false` rather than being silently dropped.
 *
 * `opts.defaultCatalog` is the request's session catalog (the `catalog` field on
 * the BFF body / `X-Trino-Catalog`), which every non-qualified reference resolves
 * against — so it is itself a referenced catalog.
 */
export function extractReferencedCatalogs(
  sql: string,
  opts: { defaultCatalog?: string } = {},
): ReferencedCatalogs {
  let cleaned = stripLiteralsAndComments(String(sql || ''));
  const found = new Set<string>();
  let resolvedFully = true;

  // The session/default catalog is referenced by any unqualified table.
  const dflt = (opts.defaultCatalog || '').trim().toLowerCase();
  if (dflt) found.add(dflt);

  // SHOW ... FROM/IN <catalog> — capture the catalog, then REMOVE the SHOW clause
  // so its `FROM` cannot trip the table-position scan below (a SHOW names a
  // catalog explicitly; it is not an unresolved table reference).
  cleaned = cleaned.replace(SHOW_RE, (_m, cat: string) => {
    found.add(unquoteIdent(cat));
    return ' ';
  });

  // Every 3-part reference contributes its catalog exactly.
  for (const m of cleaned.matchAll(THREE_PART)) found.add(unquoteIdent(m[1]));

  // USE <catalog> changes the session catalog — capture it.
  for (const m of cleaned.matchAll(USE_RE)) found.add(unquoteIdent(m[1]));

  // A FROM/JOIN/INTO operand that is NOT 3-part is unresolved (resolves against
  // the session catalog, which a USE could also have changed). If there is no
  // known default catalog to attribute it to, we cannot be certain.
  for (const m of cleaned.matchAll(TABLE_POS)) {
    const hasCatalog = Boolean(m[3]); // third segment present => catalog.schema.table
    if (!hasCatalog) resolvedFully = false; // bare `table` / `schema.table`
    // (3-part operands are already captured by THREE_PART above.)
  }

  return { catalogs: Array.from(found), resolvedFully };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface TrinoAuthzAllow {
  effect: 'allow';
  /** The catalogs the statement was authorized to touch (for the audit row). */
  catalogs: string[];
}
export interface TrinoAuthzDeny {
  effect: 'deny';
  /** The first catalog that failed the check (absent for an unresolved-restricted deny). */
  catalog?: string;
  /** Machine code for the route/UI. */
  code: 'catalog_forbidden' | 'catalog_unresolved';
  /** Human-readable, honest reason (surfaced in the 403 body + audit row). */
  reason: string;
  /** The catalogs the caller MAY reach — surfaced so the user knows their scope. */
  allowed: string[];
}
export type TrinoAuthzDecision = TrinoAuthzAllow | TrinoAuthzDeny;

/**
 * Authorize a statement's catalog footprint against a principal's allowed set.
 * Deny-by-default:
 *
 *   • Any referenced catalog outside `allowed`      -> DENY (catalog_forbidden).
 *   • `resolvedFully:false` AND the caller cannot
 *     already reach EVERY configured catalog        -> DENY (catalog_unresolved,
 *     fail-closed: an unattributable reference from a restricted caller could
 *     reach a catalog they lack).
 *   • otherwise                                      -> ALLOW.
 *
 * A caller who may reach every configured catalog is never denied for an
 * unresolved reference — nothing they could touch is forbidden, and the engine's
 * own deny-by-default floor blocks any catalog the deployment did not configure.
 */
export function authorizeTrinoCatalogs(args: {
  referenced: ReferencedCatalogs;
  allowed: Set<string>;
  configured: Set<string>;
}): TrinoAuthzDecision {
  const { referenced, allowed, configured } = args;
  const allowedList = Array.from(allowed).sort();

  // 1. Exact: every referenced catalog must be allowed.
  for (const c of referenced.catalogs) {
    if (!allowed.has(c)) {
      return {
        effect: 'deny',
        catalog: c,
        code: 'catalog_forbidden',
        reason:
          `Not authorized to query catalog "${c}". Built-in catalogs (system, jmx, memory, and your Loom `
          + `lake catalog) are open to any signed-in user; external federation catalogs are deny-by-default `
          + `and must be granted in ${CATALOG_POLICY_ENV}. Your access is scoped to: ${allowedList.join(', ') || '(none)'}.`,
        allowed: allowedList,
      };
    }
  }

  // 2. Unresolved reference from a RESTRICTED caller -> fail closed.
  if (!referenced.resolvedFully) {
    const unrestricted = Array.from(configured).every((c) => allowed.has(c));
    if (!unrestricted) {
      return {
        effect: 'deny',
        code: 'catalog_unresolved',
        reason:
          'This statement references a table that is not fully catalog-qualified, so the catalog it reaches '
          + 'cannot be verified against your scoped access. Fully qualify every table as '
          + '"catalog"."schema"."table", or use the structured cross-source join, so authorization can be enforced. '
          + `Your access is scoped to: ${allowedList.join(', ') || '(none)'}.`,
        allowed: allowedList,
      };
    }
  }

  return { effect: 'allow', catalogs: referenced.catalogs };
}
