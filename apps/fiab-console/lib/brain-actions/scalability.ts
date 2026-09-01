/**
 * LOOM BRAIN ACTIONS — WHICH SERVICES MAY BE SCALED TO ZERO (#4257).
 *
 * ── THE INCIDENT THIS PREVENTS ─────────────────────────────────────────────
 * `scale-to-zero` is the Brain's only working executor, and the largest finding
 * on the live estate is `loom-risingwave`. Its own bicep says, verbatim
 * (`platform/fiab/bicep/modules/data-plane/loom-risingwave-aca.bicep:93-95`):
 *
 *   "COST — this is the one runtime in the band that CANNOT scale to zero: a
 *    single-node RisingWave holds materialized-view + meta state in-process, so
 *    a scaled-to-zero replica loses every MV definition and its progress."
 *
 * Nothing in the guard chain encoded that. Every guard passed — same resource
 * group as the console, evidence satisfied, and the two-step confirm merely asks
 * the operator to re-affirm a change the surface has already presented as a safe
 * cost saving. One click would have destroyed every materialized view in the
 * streaming tier, unrecoverably. It was inert only because nothing carries
 * `loom-estate-id` yet, and #4255 is about to change that.
 *
 * ── WHY THE DECLARATION IS NOT A DENY LIST IN THIS FILE ────────────────────
 * A hand-maintained `NEVER_SCALE = ['loom-risingwave']` would be correct today
 * and wrong on the day the next stateful runtime ships — which is the exact
 * drift class this repo keeps getting bitten by. So the declaration is DERIVED
 * from the deploy, and the source is chosen for one property: it cannot drift
 * from the bicep.
 *
 *   SOURCE: `apps/fiab-console/deploy-templates/main.json` — the COMPILED ARM of
 *   `platform/fiab/bicep/main.bicep`, committed and COPY'd into the console
 *   image. `scripts/ci/check-deploy-template-sync.mjs` recompiles the bicep on
 *   EVERY PR in the merge-blocking `guardrails` job (no path filter) and
 *   requires the committed artifact to be byte-identical. So the file cannot
 *   lag the bicep by mechanism, not by discipline — and unlike the bicep source
 *   it is READABLE AT RUNTIME (the console image has no repository; see the
 *   `ProvenanceCoverage` note in `app/api/admin/brain/_lib/wire.ts`).
 *
 *   Precedent for trusting it this way: `lib/brain/run/__tests__/
 *   bicep-containers.test.ts` already asserts against this artifact for the one
 *   property bicep SOURCE cannot show.
 *
 * ── THE PREDICATE IS A SHAPE, NOT A NAME AND NOT A PHRASE ──────────────────
 * A Container App the deploy declares as
 *
 *     minReplicas >= 1   AND   maxReplicas === minReplicas   AND   no scale.rules
 *
 * is a PINNED SINGLETON: the template has deliberately removed elasticity from
 * it and fixed its replica count. Scaling it to zero contradicts the deployed
 * template, so per `deploy-integrity.md` R2 the next deploy reverts the write —
 * that is drift, not a fix — and for a runtime that holds state in-process it is
 * also unrecoverable data loss in the window before the revert.
 *
 * Keying on the SHAPE rather than on a name means the next stateful service is
 * covered the day its module lands, with no edit here. Keying on it rather than
 * on the prose ("cannot scale to zero") means a differently-worded comment
 * cannot silently un-protect a service — the repo's recorded lesson that a guard
 * keyed to a spelling loses to the next spelling.
 *
 * MEASURED over the committed template on 2026-09-01 — 22 Container App
 * declarations:
 *   3 PINNED     loom-risingwave (1/1), iceberg-catalog (1/1), loom-airflow (1/1)
 *   16 ELASTIC   loom-duckdb, loom-trino, loom-presidio-*, loom-dab-preview,
 *                loom-udf-runtime, loom-transform-runner, … — still performable
 *   3 UNRESOLVED the generic `apps[]` copy loop (whose replica counts come from
 *                a bicepparam, not the template), `script-runner`, `loom-unity`
 *                (a conditional scale object)
 *
 * ── THE RESIDUAL, STATED PLAINLY (R7) ──────────────────────────────────────
 * UNRESOLVED means the declaration could NOT be established, and this module
 * says so rather than inventing one. An unresolved app is NOT reported as
 * non-scalable, because the generic `apps[]` loop is where `loom-console` and
 * `loom-capacity-broker` come from — treating it as pinned would disable the
 * feature rather than guard it. Those apps keep the rest of the guard chain and
 * nothing more. A stateful runtime added through the generic loop instead of its
 * own module would therefore not be covered; a stateful runtime needs volumes,
 * probes and a state store, so it gets its own module, which is exactly the
 * shape this reads.
 *
 * Everything except {@link deployDeclaredScalability} is PURE — the template is
 * a parameter, so every arm is testable with no filesystem and no Azure.
 */

import { resolveDlzTemplateInline } from '@/lib/setup/user-arm-deploy';

/** The replica shape the deploy template declares for one Container App. */
export interface DeclaredScale {
  readonly minReplicas: number;
  readonly maxReplicas: number;
  /** True when the template attaches at least one KEDA/http scale rule. */
  readonly hasScaleRules: boolean;
}

/** What the deploy declares about ONE Container App's scalability. */
export interface ScalabilityDeclaration {
  /** The app name as the template declares it, lowercased (ARM is case-insensitive). */
  readonly appName: string;
  /** The nested-deployment (bicep module) that declares it — shown in the refusal. */
  readonly module: string;
  /** False when the deploy pins the app to a fixed, non-zero replica count. */
  readonly scalableToZero: boolean;
  readonly declared: DeclaredScale;
  /** What was established, in the words the refusal quotes. */
  readonly reason: string;
  /**
   * The deploy's OWN prose about scaling, verbatim, when the module authored
   * any. Evidence only — never the predicate. Absent for a module that pins its
   * replicas without explaining why, which is still a pinned singleton.
   */
  readonly declaredStatement?: string;
}

/** The artifact every declaration in this module is derived from. */
export const SCALABILITY_SOURCE = 'apps/fiab-console/deploy-templates/main.json';

/** How the source is kept honest. Quoted in refusals so the claim is checkable. */
export const SCALABILITY_SOURCE_NOTE =
  `the COMPILED ARM of platform/fiab/bicep/main.bicep, committed at ${SCALABILITY_SOURCE} ` +
  'and kept byte-identical to a fresh `az bicep build` by ' +
  'scripts/ci/check-deploy-template-sync.mjs in the merge-blocking `guardrails` job (no path ' +
  'filter). It cannot lag the bicep.';

const CONTAINER_APPS_TYPE = 'microsoft.app/containerapps';

// ---------------------------------------------------------------------------
// ARM expression resolution — only the shapes this template actually uses
// ---------------------------------------------------------------------------

const VAR_REF = /^\[variables\('([^']+)'\)\]$/;
const PARAM_REF = /^\[parameters\('([^']+)'\)\]$/;
/** `[int(coalesce(tryGet(parameters('xConfig'), 'minReplicas'), 1))]` — the config-bag default. */
const COALESCE_DEFAULT = /^\[int\(coalesce\(tryGet\(parameters\('[^']+'\),\s*'[^']+'\),\s*(-?\d+)\)\)\]$/;

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * Resolve an ARM `minReplicas` / `maxReplicas` expression to a literal.
 *
 * Returns `null` for anything this resolver does not UNDERSTAND — never a
 * default. A guessed replica floor is exactly the "assert what you did not
 * establish" failure R7 names, and here it would decide whether a destructive
 * mutation is offered.
 */
export function resolveDeclaredInt(
  expr: unknown,
  params: Record<string, unknown>,
  variables: Record<string, unknown>,
  depth = 0,
): number | null {
  if (typeof expr === 'number' && Number.isInteger(expr)) return expr;
  if (typeof expr !== 'string' || depth > 4) return null;

  const coalesced = COALESCE_DEFAULT.exec(expr);
  if (coalesced?.[1] !== undefined) return Number.parseInt(coalesced[1], 10);

  const varRef = VAR_REF.exec(expr);
  if (varRef?.[1] !== undefined) {
    return resolveDeclaredInt(variables[varRef[1]], params, variables, depth + 1);
  }

  const paramRef = PARAM_REF.exec(expr);
  if (paramRef?.[1] !== undefined) {
    const p = asRecord(params[paramRef[1]]);
    if (!('defaultValue' in p)) return null;
    return resolveDeclaredInt(p.defaultValue, params, variables, depth + 1);
  }

  return null;
}

/** The app NAME a resource declares, or null when it is a runtime expression. */
function resolveDeclaredName(
  name: unknown,
  params: Record<string, unknown>,
): string | null {
  if (typeof name !== 'string' || name === '') return null;
  if (!name.startsWith('[')) return name.toLowerCase();
  const paramRef = PARAM_REF.exec(name);
  if (paramRef?.[1] === undefined) return null;
  const dflt = asRecord(params[paramRef[1]]).defaultValue;
  return typeof dflt === 'string' && dflt !== '' ? dflt.toLowerCase() : null;
}

/**
 * The deploy's own words about scaling, when it wrote any.
 *
 * EVIDENCE ONLY. The predicate is the replica shape above; this exists so the
 * refusal can quote the module rather than paraphrase it — the RisingWave module
 * spells out that a stopped replica loses every materialized view, and an
 * operator deserves to read that sentence rather than a summary of it.
 */
// Sentence-bounded (`.` is the terminator) and LENGTH-CAPPED, not line-bounded:
// the RisingWave module wraps its statement across two lines, and a `\n`-bounded
// window truncated it mid-clause — dropping the only part an operator needs
// ("loses every materialized view and its progress").
const NON_SCALABLE_PROSE =
  /[^.]{0,200}\b(?:cannot|can not|must not|never)\s+(?:be\s+)?scaled?\s+to\s+zero\b[^.]{0,300}/i;

function declaredStatementFrom(template: Record<string, unknown>): string | undefined {
  const texts: string[] = [];
  const meta = asRecord(template.metadata).description;
  if (typeof meta === 'string') texts.push(meta);
  for (const p of Object.values(asRecord(template.parameters))) {
    const desc = asRecord(asRecord(p).metadata).description;
    if (typeof desc === 'string') texts.push(desc);
  }
  for (const t of texts) {
    const hit = NON_SCALABLE_PROSE.exec(t);
    if (hit) return hit[0].replace(/\s+/g, ' ').trim();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/** `resources` is a list in classic templates and a dict in `languageVersion` ones. */
function resourceList(template: Record<string, unknown>): unknown[] {
  const res = template.resources;
  if (Array.isArray(res)) return res;
  if (typeof res === 'object' && res !== null) return Object.values(res);
  return [];
}

function declarationFor(
  resource: Record<string, unknown>,
  template: Record<string, unknown>,
  moduleLabel: string,
): ScalabilityDeclaration | null {
  const params = asRecord(template.parameters);
  const variables = asRecord(template.variables);

  const appName = resolveDeclaredName(resource.name, params);
  if (appName === null) return null;

  const scale = asRecord(asRecord(asRecord(resource.properties).template).scale);
  const minReplicas = resolveDeclaredInt(scale.minReplicas, params, variables);
  const maxReplicas = resolveDeclaredInt(scale.maxReplicas, params, variables);
  if (minReplicas === null || maxReplicas === null) return null;

  const rules = scale.rules;
  const hasScaleRules = Array.isArray(rules) ? rules.length > 0 : rules !== undefined;

  const pinned = minReplicas >= 1 && maxReplicas === minReplicas && !hasScaleRules;
  const declaredStatement = pinned ? declaredStatementFrom(template) : undefined;

  return {
    appName,
    module: moduleLabel,
    scalableToZero: !pinned,
    declared: { minReplicas, maxReplicas, hasScaleRules },
    reason: pinned
      ? `the deploy PINS '${appName}' to exactly ${minReplicas} replica(s) ` +
        `(minReplicas ${minReplicas} = maxReplicas ${maxReplicas}, no scale rules) in bicep module ` +
        `'${moduleLabel}'. A template that fixes a replica count and attaches no autoscale rule has ` +
        'deliberately removed elasticity from that app: it is a singleton runtime, not an elastic one.'
      : `the deploy declares '${appName}' as ELASTIC (minReplicas ${minReplicas}, maxReplicas ` +
        `${maxReplicas}${hasScaleRules ? ', with scale rule(s)' : ''}) in bicep module ` +
        `'${moduleLabel}', so scaling its floor to zero does not contradict the template.`,
    ...(declaredStatement ? { declaredStatement } : {}),
  };
}

/**
 * Every Container App declaration the compiled template carries, keyed by
 * lowercased app name.
 *
 * PURE — the parsed template is the input. A name that appears in more than one
 * module (the s3-gateway ships in both the admin plane and the dlz-attach path)
 * resolves to the FIRST pinned declaration if any module pins it: a runtime that
 * is a singleton on one deploy path is a singleton, and the safe reading of a
 * disagreement is the restrictive one.
 */
export function declarationsFromTemplate(
  template: unknown,
): ReadonlyMap<string, ScalabilityDeclaration> {
  const out = new Map<string, ScalabilityDeclaration>();

  const walk = (tmpl: Record<string, unknown>, label: string): void => {
    const items = resourceList(tmpl);
    for (const raw of items) {
      const r = asRecord(raw);
      const type = r.type;
      if (typeof type === 'string' && type.toLowerCase() === CONTAINER_APPS_TYPE) {
        const decl = declarationFor(r, tmpl, label);
        if (decl) {
          const existing = out.get(decl.appName);
          if (!existing || (existing.scalableToZero && !decl.scalableToZero)) {
            out.set(decl.appName, decl);
          }
        }
      }
    }
    for (const raw of items) {
      const r = asRecord(raw);
      if (r.type !== 'Microsoft.Resources/deployments') continue;
      const inner = asRecord(r.properties).template;
      if (typeof inner !== 'object' || inner === null) continue;
      const name = typeof r.name === 'string' ? r.name : '(unnamed module)';
      walk(asRecord(inner), name);
    }
  };

  walk(asRecord(template), 'main.bicep');
  return out;
}

// ---------------------------------------------------------------------------
// The runtime lookup
// ---------------------------------------------------------------------------

let declarationCache: ReadonlyMap<string, ScalabilityDeclaration> | undefined;

/** Reset the derived-declaration cache (test-only). */
export function __resetScalabilityCache(): void {
  declarationCache = undefined;
}

/**
 * The declarations derived from the BUNDLED compiled template.
 *
 * Returns an EMPTY map when the artifact is not present in this image. That is
 * reported by {@link declaredNonScalableToZero} returning null — i.e. "the
 * declaration could not be established" — never as "everything is scalable"
 * dressed up as a fact.
 */
export function deployDeclaredScalability(): ReadonlyMap<string, ScalabilityDeclaration> {
  if (declarationCache !== undefined) return declarationCache;
  const inline = resolveDlzTemplateInline();
  declarationCache = inline ? declarationsFromTemplate(inline.template) : new Map();
  return declarationCache;
}

/**
 * The declaration REFUSING scale-to-zero for this app, or null.
 *
 * Null covers three different states on purpose — not declared at all, declared
 * elastic, and no template in the image. None of them is a licence; they only
 * mean this particular check has nothing to say, and the rest of the guard chain
 * still applies.
 */
export function declaredNonScalableToZero(
  appName: string,
  declarations: ReadonlyMap<string, ScalabilityDeclaration> = deployDeclaredScalability(),
): ScalabilityDeclaration | null {
  const decl = declarations.get(appName.trim().toLowerCase());
  return decl && !decl.scalableToZero ? decl : null;
}

/**
 * The refusal text. One writer, so the guard, the executor and the detector all
 * say the same true thing about the same resource.
 */
export function nonScalableExplanation(decl: ScalabilityDeclaration): string {
  return (
    `'${decl.appName}' CANNOT be scaled to zero: ${decl.reason}` +
    (decl.declaredStatement
      ? ` The module states it in its own words: "${decl.declaredStatement}."`
      : '') +
    ` Source: ${SCALABILITY_SOURCE_NOTE}` +
    ' Scaling a pinned singleton to zero destroys whatever state its single replica holds in ' +
    'process, and the next deploy re-asserts the declared floor anyway — so the write is ' +
    'unrecoverable loss in exchange for drift, not a saving (deploy-integrity.md R2).'
  );
}
