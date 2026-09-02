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
 *     minReplicas >= 1   AND   maxReplicas === minReplicas
 *
 * is a PINNED SINGLETON: the template has deliberately removed elasticity from
 * it and fixed its replica count. Scaling it to zero contradicts the deployed
 * template, so per `deploy-integrity.md` R2 the next deploy reverts the write —
 * that is drift, not a fix — and for a runtime that holds state in-process it is
 * also unrecoverable data loss in the window before the revert.
 *
 * The predicate does NOT exempt an app that carries a scale rule. It did until
 * the round-3 review, and that exemption was a hole: a rule cannot fire when the
 * floor and the ceiling are the same number, and the real `apps[]` copy loop
 * attaches a rule to EVERY app it declares, so a 1/1 stateful runtime added
 * through that array read as elastic and was permitted.
 *
 * Keying on the SHAPE rather than on a name means the next stateful service is
 * covered the day its module lands, with no edit here — PROVIDED the shape is
 * read from the values the deploy actually passes. It was not until the round-2
 * review of #4261: the resolver read each module's `defaultValue` and ignored
 * the enclosing deployment's `properties.parameters`, so a module whose replica
 * floor is passed in was judged on a number the deploy had overridden. See
 * {@link effectiveParam}. Keying on the shape rather than on the prose ("cannot
 * scale to zero") means a differently-worded comment cannot silently un-protect
 * a service — the repo's recorded lesson that a guard keyed to a spelling loses
 * to the next spelling.
 *
 * MEASURED over the committed template on 2026-09-02 — 23 Container App resource
 * declarations, one of which is a `copy` loop declaring 6 apps, giving 27 keyed
 * declarations. PINNED BY THE TESTS (`CENSUS`), not by this comment, so the two
 * cannot drift apart again:
 *   4  PINNED      loom-risingwave (1/1), iceberg-catalog (1/1), loom-airflow (1/1),
 *                  loom-redis-oss (1/1) — the sovereign-boundary OSS Redis added
 *                  by #2642. It is derived as pinned with no change to this
 *                  module: the bicep declares min=max=1, and a cache zeroed is a
 *                  cache emptied, which is the #4257 shape exactly.
 *   21 ELASTIC     loom-duckdb (0/3), loom-directlake (1/2), loom-console (2/6),
 *                  loom-presidio-*, loom-s3-gateway, loom-migrate, script-runner,
 *                  loom-mcp, loom-activator, loom-mirroring, …
 *   2  SHAPE       loom-unity (a conditional scale object) and loom-trino (its
 *      UNRESOLVED  minReplicas is a computed expression the PARENT passes) — in
 *                  the map, with the durability verdict withheld
 *   1  UNNAMED     the dlz-attach s3-gateway, whose name is
 *                  `[take(format('loom-s3-gateway-{0}', …), 32)]`. NOT in the map,
 *                  and recorded as {@link UnnamedDeclaration} so its absence
 *                  cannot be read as "undeclared" — see {@link refuseScaleToZero}.
 *
 * Of the 27 keyed apps, 7 remain performable (the five generic-loop apps that
 * carry no declared consumer, plus `loom-presidio-analyzer` and
 * `loom-presidio-anonymizer`); the availability arm refuses the rest because the
 * deploy wires a consumer to them, and `loom-console` is refused as self. That
 * is over-refusal on a destructive action, which is the safe direction, but it
 * is stated here rather than implied — an executor that refuses nearly
 * everything is close to a disabled feature wearing a guard's clothes.
 *
 * ── THE RESIDUAL, STATED PLAINLY (R7) ──────────────────────────────────────
 * SHAPE-UNRESOLVED means the replica shape could NOT be established, and this
 * module says so rather than inventing one — such an app is NOT reported as
 * non-scalable. UNNAMED means the app could not even be identified; a subject
 * missing from the map is REFUSED rather than permitted whenever an unnamed
 * resource could have produced that name, because "absent from an incomplete
 * population" establishes nothing.
 *
 * That shadow is kept as SMALL as the template allows, and the size matters:
 * an UNBOUNDED hole refuses every unlisted subject, which MEASURED took the
 * perform route's happy path from 200 to 409 — the guard would have disabled the
 * feature it was written to protect. Two things bound it. The `apps[]` copy loop
 * is EXPANDED (the parent passes a static 6-element array), which also means a
 * stateful singleton added through the generic loop is now CAUGHT rather than
 * invisible. And the dlz-attach gateway's name yields a literal prefix, so it
 * shadows `loom-s3-gateway-*` and nothing else.
 *
 * Everything except {@link deployDeclaredScalability} is PURE — the template is
 * a parameter, so every arm is testable with no filesystem and no Azure.
 */

import { resolveDlzTemplateInlineOutcome } from '@/lib/setup/user-arm-deploy';

/** The replica shape the deploy template declares for one Container App. */
export interface DeclaredScale {
  readonly minReplicas: number;
  readonly maxReplicas: number;
  /** True when the template attaches at least one KEDA/http scale rule. */
  readonly hasScaleRules: boolean;
}

/**
 * One wire the DEPLOY declares INTO a Container App — another app's `env`
 * naming it (#4257 review: the availability half).
 */
export interface DeclaredConsumer {
  /** The bicep module whose `env` block declares the wire. */
  readonly consumerModule: string;
  /**
   * How the value expression named the target:
   *   `module-reference`  `reference('icebergCatalog').outputs.fqdn.value`
   *   `fqdn-literal`      `'https://loom-unity.internal.{0}'`
   * Both forms occur in the real template; a matcher that read only one would
   * be blind to half the estate and report a confident zero.
   */
  readonly via: 'module-reference' | 'fqdn-literal';
}

/** What the deploy declares about ONE Container App's scalability. */
export interface ScalabilityDeclaration {
  /** The app name as the template declares it, lowercased (ARM is case-insensitive). */
  readonly appName: string;
  /** The nested-deployment (bicep module) that declares it — shown in the refusal. */
  readonly module: string;
  /** False when the deploy pins the app to a fixed, non-zero replica count. */
  readonly scalableToZero: boolean;
  /**
   * `null` when the replica shape could NOT be established — `loom-unity`'s
   * scale is a conditional on its backing store, so no static answer exists.
   * Null means the DURABILITY predicate is withheld (R7: not established is not
   * "elastic"); the availability signal below still applies.
   */
  readonly declared: DeclaredScale | null;
  /** What was established, in the words the refusal quotes. */
  readonly reason: string;
  /**
   * The deploy's OWN prose about scaling, verbatim, when the module authored
   * any. Evidence only — never the predicate. Absent for a module that pins its
   * replicas without explaining why, which is still a pinned singleton.
   */
  readonly declaredStatement?: string;
  /**
   * Other apps the DEPLOY wires to this one. Non-empty means the deploy itself
   * declares a consumer — see {@link refuseScaleToZero} for what that decides.
   */
  readonly declaredConsumers: readonly DeclaredConsumer[];
}

/** The artifact every declaration in this module is derived from. */
export const SCALABILITY_SOURCE = 'apps/fiab-console/deploy-templates/main.json';

/**
 * How the source is kept honest. Quoted in refusals so the claim is checkable.
 *
 * ── WHAT THIS DOES AND DOES NOT GUARANTEE (review of #4261, should-fix 6) ───
 * The sync gate binds the COMMITTED artifact to the bicep at `main`. It says
 * nothing about the copy baked into the image that is running: an image built
 * three weeks ago carries the template as it was three weeks ago, and this
 * repo's own R3 drift condition says the live console routinely trails `main`.
 * A console older than the module that introduced a stateful app derives no
 * declaration for it — and per {@link refuseScaleToZero} an unlisted subject is
 * only refused because the population gap is now recorded. The previous wording
 * here said "It cannot lag the bicep", asserting about THIS IMAGE something only
 * established about the repo. That is the R7 error in a sentence shown to the
 * operator, so it says what it actually guarantees.
 */
export const SCALABILITY_SOURCE_NOTE =
  `the COMPILED ARM of platform/fiab/bicep/main.bicep, committed at ${SCALABILITY_SOURCE} ` +
  'and kept byte-identical to a fresh `az bicep build` by ' +
  'scripts/ci/check-deploy-template-sync.mjs in the merge-blocking `guardrails` job (no path ' +
  'filter). That gate binds the COMMITTED artifact to the bicep at main; the copy consulted ' +
  'here is the one baked into THIS image, so it is exactly as old as this image and may trail ' +
  'main (deploy-integrity.md R3). Check /admin/readiness for how far behind this build is.';

const CONTAINER_APPS_TYPE = 'microsoft.app/containerapps';

// ---------------------------------------------------------------------------
// ARM expression resolution — only the shapes this template actually uses
// ---------------------------------------------------------------------------

const VAR_REF = /^\[variables\('([^']+)'\)\]$/;
const PARAM_REF = /^\[parameters\('([^']+)'\)\]$/;
/**
 * `[int(coalesce(tryGet(parameters('xConfig'), 'minReplicas'), 1))]` — the
 * config-BAG shape. Both the bag name and the key inside it are captured,
 * because the literal at the end is only the FALLBACK: when the parent passes a
 * bag that carries the key, ARM's `coalesce` takes the passed value and the
 * fallback is never evaluated. Capturing only the fallback (as this did) reads
 * a number the deploy does not use — see {@link effectiveParam}.
 */
const COALESCE_BAG =
  /^\[int\(coalesce\(tryGet\(parameters\('([^']+)'\),\s*'([^']+)'\),\s*(-?\d+)\)\)\]$/;

/**
 * The generic `apps[]` copy loop — ONE resource declaring N Container Apps.
 *
 * `[parameters('apps')[copyIndex()].name]` and
 * `[if(contains(parameters('apps')[copyIndex()], 'minReplicas'), …, 1)]`.
 * MEASURED: the parent passes a STATIC 6-element array, so every one of these
 * resolves. Before this, the whole loop was a single unnamed resource, which
 * made the population hole UNBOUNDED — and an unbounded hole refuses every
 * unlisted subject, which is a disabled feature rather than a guard.
 */
const COPY_ITEM = /^\[parameters\('([^']+)'\)\[copyIndex\(\)\]\.([A-Za-z0-9_]+)\]$/;
const COPY_ITEM_OR = new RegExp(
  String.raw`^\[if\(contains\(parameters\('([^']+)'\)\[copyIndex\(\)\],\s*'([^']+)'\),\s*` +
    String.raw`parameters\('\1'\)\[copyIndex\(\)\]\.\2,\s*(-?\d+)\)\]$`,
);
/** `[length(parameters('apps'))]` — the copy count. */
const COPY_COUNT = /^\[length\(parameters\('([^']+)'\)\)\]$/;
/**
 * A name built from a literal prefix, e.g.
 * `[take(format('loom-s3-gateway-{0}', parameters('attachDomainName')), 32)]`.
 * The prefix BOUNDS which subjects the unresolved name could possibly be.
 */
const FORMAT_PREFIX = /format\('([^'{]*)\{0\}/;

/** One iteration of a `copy` loop, bound to the item it declares. */
interface CopyBinding {
  /** The array parameter the loop counts over. */
  readonly param: string;
  /** The item at this index, already resolved to a literal object. */
  readonly item: Record<string, unknown>;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * True for an ARM expression. `[[` is ARM's escape for a LITERAL leading
 * bracket, so it is a string, not an expression.
 */
function isArmExpression(v: string): boolean {
  return v.startsWith('[') && !v.startsWith('[[') && v.endsWith(']');
}

/**
 * What the DEPLOY actually passes for a nested template's parameter.
 *
 * ── THE PARENT'S VALUE BEATS THE MODULE'S DEFAULT (review of #4261, B1) ─────
 * `properties.parameters` on the enclosing `Microsoft.Resources/deployments` is
 * the value the deploy USES. A nested template's `defaultValue` is only what it
 * would use if the parent passed nothing. Reading the default while the parent
 * overrode it reports a replica shape the deploy never asked for, and null is
 * allow, so it decides a destructive mutation on a number nothing established.
 *
 * MEASURED on the committed artifact, both shapes are already live:
 *
 *   direct   `loom-directlake` passes maxReplicas 2 over a default of 3;
 *            `loom-trino` passes a COMPUTED minReplicas over a default of 0;
 *            `script-runner` has NO default, so it dropped out of the map
 *            entirely; the dlz-attach gateway passes a computed name over a
 *            default (`loom-s3-gateway`) that collides with a different module's
 *            real app.
 *   bag      SIX modules resolve replicas through `coalesce(tryGet(bag, k), N)`
 *            and the parent passes the bag in every one. `loom-duckdb` is
 *            misread TODAY: the fallback says minReplicas 1, the deploy passes
 *            0. `loom-risingwave` — the subject this guard exists for — passes
 *            1/1 over a 1/1 fallback, so it reads correctly BY COINCIDENCE.
 *            Change that module's fallback without changing the bag and the
 *            guard silently starts reading a shape the deploy does not deploy.
 *
 * A parent value that is itself an ARM EXPRESSION is evaluated at deploy time in
 * the PARENT's scope, which this static reader cannot enter. That is
 * UNRESOLVABLE, and it must NOT fall back to the default: the default is exactly
 * what the parent chose to override, so substituting it asserts the opposite of
 * what the template says (deploy-integrity.md R7).
 */
type EffectiveParam =
  | { readonly state: 'literal'; readonly value: unknown }
  | {
      readonly state: 'unresolvable';
      /** WHICH way it could not be resolved — quoted where the gap is reported. */
      readonly why: 'parent-expression' | 'parent-non-literal' | 'no-value';
    };

function effectiveParam(
  key: string,
  passed: Record<string, unknown>,
  params: Record<string, unknown>,
): EffectiveParam {
  if (key in passed) {
    const entry = asRecord(passed[key]);
    // `{ reference: { keyVault … } }` — a deploy-time secret fetch, not a value.
    if (!('value' in entry)) return { state: 'unresolvable', why: 'parent-non-literal' };
    const v = entry.value;
    if (typeof v === 'string' && isArmExpression(v)) {
      return { state: 'unresolvable', why: 'parent-expression' };
    }
    return { state: 'literal', value: v };
  }
  const p = asRecord(params[key]);
  // No parent value AND no default. `script-runner`'s name is this shape, and it
  // is why that module vanished from the derived map rather than refusing.
  if (!('defaultValue' in p)) return { state: 'unresolvable', why: 'no-value' };
  // A default may itself be an expression in the NESTED scope (`[variables(…)]`),
  // which the callers below CAN resolve — so it is handed back for resolution.
  return { state: 'literal', value: p.defaultValue };
}

/**
 * Resolve a value taken from a container the PARENT supplied — a config bag or
 * a copy-loop item.
 *
 * ── ONE LEVEL DOWN IS STILL THE PARENT'S SCOPE (round-3 review) ─────────────
 * {@link effectiveParam} rejects a parent-passed value that is an ARM
 * expression, but it only sees the TOP-LEVEL string. An expression nested
 * INSIDE a passed bag or array item was handed to the resolver, which evaluated
 * it against THIS template's `variables` — a different template's numbers.
 * MEASURED at review: a bag carrying `[variables('minReplicas')]` returned 9.
 *
 * Latent today (all six real bags and all six array items carry integer
 * literals), but it fails in the reads-ELASTIC-where-the-deploy-PINS direction,
 * which is the data-loss direction. Unresolvable, therefore, and never a guess.
 */
function fromParentContainer(
  value: unknown,
  params: Record<string, unknown>,
  variables: Record<string, unknown>,
  passed: Record<string, unknown>,
  depth: number,
  copy?: CopyBinding,
): number | null {
  if (typeof value === 'string' && isArmExpression(value)) return null;
  return resolveDeclaredInt(value, params, variables, passed, depth + 1, copy);
}

/**
 * Resolve an ARM `minReplicas` / `maxReplicas` expression to a literal.
 *
 * Returns `null` for anything this resolver does not UNDERSTAND — never a
 * default. A guessed replica floor is exactly the "assert what you did not
 * establish" failure R7 names, and here it would decide whether a destructive
 * mutation is offered.
 *
 * `passed` is the enclosing deployment's `properties.parameters`. It is
 * consulted BEFORE the nested template's defaults; see {@link effectiveParam}.
 */
export function resolveDeclaredInt(
  expr: unknown,
  params: Record<string, unknown>,
  variables: Record<string, unknown>,
  passed: Record<string, unknown> = {},
  depth = 0,
  copy?: CopyBinding,
): number | null {
  if (typeof expr === 'number' && Number.isInteger(expr)) return expr;
  if (typeof expr !== 'string' || depth > 4) return null;

  if (copy) {
    const item = COPY_ITEM.exec(expr);
    if (item?.[1] === copy.param && item[2] !== undefined) {
      return fromParentContainer(copy.item[item[2]], params, variables, passed, depth, copy);
    }
    // `if(contains(item, 'k'), item.k, N)` — present wins, absent takes N.
    const guarded = COPY_ITEM_OR.exec(expr);
    if (guarded?.[1] === copy.param && guarded[2] !== undefined && guarded[3] !== undefined) {
      return guarded[2] in copy.item
        ? fromParentContainer(copy.item[guarded[2]], params, variables, passed, depth, copy)
        : Number.parseInt(guarded[3], 10);
    }
  }

  const bag = COALESCE_BAG.exec(expr);
  if (bag?.[1] !== undefined && bag[2] !== undefined && bag[3] !== undefined) {
    const eff = effectiveParam(bag[1], passed, params);
    // The bag itself is a runtime expression: whether it carries the key is
    // unknowable here, so BOTH branches of the coalesce are unestablished.
    if (eff.state !== 'literal') return null;
    if (eff.value === null || eff.value === undefined) {
      // `tryGet` on an absent bag yields null and `coalesce` takes the fallback.
      return Number.parseInt(bag[3], 10);
    }
    if (typeof eff.value !== 'object' || Array.isArray(eff.value)) return null;
    const carried = asRecord(eff.value);
    // Key ABSENT: `tryGet` yields null, so the fallback is genuinely what runs.
    if (!(bag[2] in carried)) return Number.parseInt(bag[3], 10);
    return fromParentContainer(carried[bag[2]], params, variables, passed, depth, copy);
  }

  const varRef = VAR_REF.exec(expr);
  if (varRef?.[1] !== undefined) {
    return resolveDeclaredInt(variables[varRef[1]], params, variables, passed, depth + 1, copy);
  }

  const paramRef = PARAM_REF.exec(expr);
  if (paramRef?.[1] !== undefined) {
    const eff = effectiveParam(paramRef[1], passed, params);
    if (eff.state !== 'literal') return null;
    return resolveDeclaredInt(eff.value, params, variables, passed, depth + 1, copy);
  }

  return null;
}

/**
 * The literal prefix an unresolved name is known to start with, if any.
 *
 * `[take(format('loom-s3-gateway-{0}', …), 32)]` can only ever produce a name
 * beginning `loom-s3-gateway-`, which BOUNDS the hole: every other subject is
 * provably not this resource. Null means unbounded — the hole could be any name.
 */
function unresolvedNamePrefix(expr: string): string | undefined {
  const m = FORMAT_PREFIX.exec(expr);
  return m?.[1] !== undefined && m[1] !== '' ? m[1].toLowerCase() : undefined;
}

/**
 * The app NAME a resource declares, or null when it is a runtime expression.
 *
 * A null here does NOT mean "no such app" — it means this reader could not
 * establish which app the resource declares, so the derived map's POPULATION is
 * incomplete. {@link deriveScalability} records every one of these and
 * {@link refuseScaleToZero} refuses an unlisted subject that the hole could
 * account for, because "absent from an incomplete map" is not evidence.
 */
function resolveDeclaredName(
  name: unknown,
  params: Record<string, unknown>,
  passed: Record<string, unknown>,
  copy?: CopyBinding,
): string | null {
  if (typeof name !== 'string' || name === '') return null;
  if (!isArmExpression(name)) return name.toLowerCase();
  if (copy) {
    const item = COPY_ITEM.exec(name);
    if (item?.[1] === copy.param && item[2] !== undefined) {
      const v = copy.item[item[2]];
      return typeof v === 'string' && v !== '' && !isArmExpression(v) ? v.toLowerCase() : null;
    }
  }
  const paramRef = PARAM_REF.exec(name);
  if (paramRef?.[1] === undefined) return null;
  const eff = effectiveParam(paramRef[1], passed, params);
  if (eff.state !== 'literal') return null;
  const v = eff.value;
  // A default that is itself an expression is no more resolvable than a passed
  // one — `[take(format('loom-s3-gateway-{0}', …), 32)]` names no static app.
  if (typeof v !== 'string' || v === '' || isArmExpression(v)) return null;
  return v.toLowerCase();
}

/**
 * The name expression an unresolved resource would have to be judged by.
 *
 * For a `[parameters('x')]` name the operative expression is the VALUE the
 * parent passed, not the reference — that is where the `format()` prefix that
 * BOUNDS the hole lives. It is read here even though {@link effectiveParam}
 * refuses it as a value: unusable for deciding a replica count is not the same
 * as uninformative about which names it can produce.
 */
function unresolvedNameExpr(
  name: unknown,
  params: Record<string, unknown>,
  passed: Record<string, unknown>,
): string {
  if (typeof name !== 'string') return JSON.stringify(name ?? null);
  const paramRef = PARAM_REF.exec(name);
  if (paramRef?.[1] === undefined) return name;
  const key = paramRef[1];
  if (key in passed) {
    const v = asRecord(passed[key]).value;
    return typeof v === 'string' ? v : name;
  }
  const dflt = asRecord(params[key]).defaultValue;
  return typeof dflt === 'string' ? dflt : name;
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

/**
 * `resources` is a list in classic templates and a DICT keyed by symbolic name
 * in `languageVersion` ones — both shapes appear in this artifact. The symbolic
 * key matters: `reference('icebergCatalog')` in a consumer's env names the
 * MODULE by that key, so a walker that discarded it would be blind to every
 * module-reference wire and report a confident zero.
 */
function resourceEntries(
  template: Record<string, unknown>,
): Array<{ symbol: string | null; resource: unknown }> {
  const res = template.resources;
  if (Array.isArray(res)) return res.map((r) => ({ symbol: null, resource: r }));
  if (typeof res === 'object' && res !== null) {
    return Object.entries(res as Record<string, unknown>).map(([symbol, resource]) => ({
      symbol,
      resource,
    }));
  }
  return [];
}

/** One app's `env` block, serialized, plus the module that owns it. */
interface EnvBlob {
  readonly ownerSymbol: string;
  readonly text: string;
}

/** Every `env:` block in a template body, serialized for matching. */
function collectEnvBlobs(
  tmpl: Record<string, unknown>,
  ownerSymbol: string,
  into: EnvBlob[],
): void {
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const x of node) visit(x);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const rec = node as Record<string, unknown>;
    // DO NOT descend into a nested deployment's template. It is visited
    // separately under ITS OWN symbol, and double-counting it here attributes a
    // child app's env to the parent — which made a service look like its own
    // consumer and defeated the self-wire exclusion below.
    if (rec.type === 'Microsoft.Resources/deployments') {
      for (const [k, v] of Object.entries(asRecord(rec.properties))) {
        if (k !== 'template') visit(v);
      }
      return;
    }
    for (const [k, v] of Object.entries(rec)) {
      // An `env` value is either a literal array of {name,value} objects or a
      // single ARM expression string building one. Serializing covers both.
      if (k === 'env') into.push({ ownerSymbol, text: JSON.stringify(v).toLowerCase() });
      visit(v);
    }
  };
  for (const { resource } of resourceEntries(tmpl)) visit(resource);
  visit(tmpl.variables);
}

/**
 * The consumers the deploy declares for one app.
 *
 * An app's OWN env is excluded — a service does not wire itself.
 */
function consumersFor(
  appName: string,
  ownerSymbol: string,
  blobs: readonly EnvBlob[],
): DeclaredConsumer[] {
  const out: DeclaredConsumer[] = [];
  const moduleRef = ownerSymbol ? `reference('${ownerSymbol}')` : null;
  // `loom-unity.internal.` — the literal-FQDN form the console's env uses for
  // apps whose module output it does not read.
  const fqdnLiteral = `${appName}.internal.`;
  for (const blob of blobs) {
    // Self-exclusion is per MODULE, because `reference('x')` names a module and
    // not an app. For the expanded `apps[]` copy loop that means a wire BETWEEN
    // two apps of that one loop is not counted — the six of them share a symbol.
    // NOT ESTABLISHED, and stated rather than implied: it is under-refusal on
    // the availability arm only, it applies to no app the shape marks pinned
    // (all six are elastic WITH scale rules), and before the loop was expanded
    // those apps carried no declaration at all and were permitted outright. A
    // per-app exclusion needs the blob to carry the app name, not the module's.
    if (blob.ownerSymbol === ownerSymbol) continue;
    if (moduleRef && blob.text.includes(moduleRef)) {
      out.push({ consumerModule: blob.ownerSymbol, via: 'module-reference' });
      continue;
    }
    if (includesAtNameBoundary(blob.text, fqdnLiteral)) {
      out.push({ consumerModule: blob.ownerSymbol, via: 'fqdn-literal' });
    }
  }
  return out;
}

/**
 * `text` contains `needle` starting at a NAME BOUNDARY (review of #4261, nit 8).
 *
 * A bare `includes` made the FQDN form a substring match, so a hypothetical app
 * named `unity` would match `loom-unity.internal.` and be refused for a wire
 * that names a different service. Over-refusal rather than under-refusal, so it
 * was never a safety hole — but a refusal that cites the wrong wire states
 * something it did not establish, which is the R7 problem in miniature.
 *
 * The boundary is "the character before the match is not one an app name could
 * continue through". App names are lowercase alphanumerics and hyphens.
 */
function includesAtNameBoundary(text: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return false;
    if (at === 0 || !/[a-z0-9-]/i.test(text.charAt(at - 1))) return true;
    from = at + 1;
  }
}

function declarationFor(
  resource: Record<string, unknown>,
  template: Record<string, unknown>,
  moduleLabel: string,
  declaredConsumers: readonly DeclaredConsumer[],
  passed: Record<string, unknown>,
  copy?: CopyBinding,
): ScalabilityDeclaration | null {
  const params = asRecord(template.parameters);
  const variables = asRecord(template.variables);

  const appName = resolveDeclaredName(resource.name, params, passed, copy);
  if (appName === null) return null;

  const scale = asRecord(asRecord(asRecord(resource.properties).template).scale);
  const minReplicas = resolveDeclaredInt(scale.minReplicas, params, variables, passed, 0, copy);
  const maxReplicas = resolveDeclaredInt(scale.maxReplicas, params, variables, passed, 0, copy);

  // SHAPE NOT ESTABLISHED. `loom-unity`'s scale is `[if(usePostgres, …, …)]` —
  // two different shapes depending on its backing store, so there is no static
  // answer. The declaration is still emitted (its consumers are knowable and
  // the availability signal must reach it — the #4261 review hole); only the
  // durability verdict is withheld.
  if (minReplicas === null || maxReplicas === null) {
    return {
      appName,
      module: moduleLabel,
      scalableToZero: true,
      declared: null,
      declaredConsumers,
      reason:
        `the deploy's replica shape for '${appName}' could NOT be established from the template ` +
        `(module '${moduleLabel}' computes it conditionally), so no pinned-singleton verdict is ` +
        'drawn. NOT ESTABLISHED is not "elastic" — it means this half of the check has nothing ' +
        'to say.',
    };
  }

  const rules = scale.rules;
  const hasScaleRules = Array.isArray(rules) ? rules.length > 0 : rules !== undefined;

  // ── A RULE THAT CANNOT FIRE IS NOT ELASTICITY (round-3 review, B3) ────────
  // This predicate used to carry `&& !hasScaleRules`, on the reading that a
  // scale rule expresses an intent to scale. It does not when `min === max`:
  // KEDA has no room to move between a floor and a ceiling that are the same
  // number, so the rule is inert and the app is a singleton with a vestigial
  // rule attached.
  //
  // And that is exactly the shape the real `apps[]` loop emits — its `rules`
  // field is
  //   [if(contains(item,'scaleRules'), item.scaleRules, createArray(createObject(…)))]
  // so EVERY app in the generic array carries a rule. A stateful runtime added
  // there at 1/1 read as ELASTIC and was PERMITTED, and with the per-module
  // self-exclusion documented in `consumersFor` its wires are uncounted too, so
  // nothing else would have caught it. MEASURED census-neutral: no app besides
  // the three already pinned has `min === max`, so this refuses nothing that
  // was previously permitted — it only closes the hole.
  const pinned = minReplicas >= 1 && maxReplicas === minReplicas;
  const declaredStatement = pinned ? declaredStatementFrom(template) : undefined;

  return {
    appName,
    module: moduleLabel,
    scalableToZero: !pinned,
    declared: { minReplicas, maxReplicas, hasScaleRules },
    declaredConsumers,
    reason: pinned
      ? `the deploy PINS '${appName}' to exactly ${minReplicas} replica(s) ` +
        `(minReplicas ${minReplicas} = maxReplicas ${maxReplicas}` +
        (hasScaleRules
          ? ', and the scale rule(s) attached to it CANNOT fire — a floor and a ceiling that ' +
            'are the same number leave nothing to scale between'
          : ', no scale rules') +
        `) in bicep module '${moduleLabel}'. A template that fixes a replica count has ` +
        'deliberately removed elasticity from that app: it is a singleton runtime, not an elastic one.'
      : `the deploy declares '${appName}' as ELASTIC (minReplicas ${minReplicas}, maxReplicas ` +
        `${maxReplicas}${hasScaleRules ? ', with scale rule(s)' : ''}) in bicep module ` +
        `'${moduleLabel}', so scaling its floor to zero does not contradict the template.`,
    ...(declaredStatement ? { declaredStatement } : {}),
  };
}

/** One template body in the graph, with the identity a consumer would name it by. */
interface TemplateBody {
  readonly tmpl: Record<string, unknown>;
  /** Symbolic resource key of the nested deployment — what `reference()` names. */
  readonly symbol: string;
  /** The deployment's `name`, shown to operators. */
  readonly label: string;
  /**
   * The enclosing deployment's `properties.parameters` — the values the deploy
   * PASSES into this body. Empty for the root, which has no enclosing
   * deployment. See {@link effectiveParam}: these beat the body's own defaults.
   */
  readonly passed: Record<string, unknown>;
}

/**
 * A Container App resource whose NAME could not be established.
 *
 * Its declaration cannot be keyed, so it is missing from the map — and a map
 * with a hole in it cannot support "this subject is not declared". Recorded so
 * {@link refuseScaleToZero} can refuse an unlisted subject rather than allow it.
 */
export interface UnnamedDeclaration {
  /** The bicep module that declares it. */
  readonly module: string;
  /** The unresolved `name` expression, verbatim, so the gap is inspectable. */
  readonly nameExpr: string;
  /**
   * The literal prefix every name this resource can produce must start with, or
   * undefined when the hole is UNBOUNDED. A bounded hole only shadows subjects
   * that match it; an unbounded one shadows every unlisted subject.
   */
  readonly namePrefix?: string;
}

/** The derivation's two halves: what was established, and what was not. */
export interface ScalabilityDerivation {
  readonly declarations: ReadonlyMap<string, ScalabilityDeclaration>;
  readonly unnamed: readonly UnnamedDeclaration[];
}

/**
 * Every Container App declaration the compiled template carries, keyed by
 * lowercased app name, PLUS the ones whose name could not be resolved.
 *
 * PURE — the parsed template is the input. A name that appears in more than one
 * module (the s3-gateway ships in both the admin plane and the dlz-attach path)
 * resolves to the FIRST pinned declaration if any module pins it: a runtime that
 * is a singleton on one deploy path is a singleton, and the safe reading of a
 * disagreement is the restrictive one.
 *
 * Two passes, and the order is load-bearing: every `env` block in the whole
 * graph must be collected BEFORE any app is judged, because the consumer of a
 * data-plane app is usually the Console, whose module is walked later.
 */
export function deriveScalability(template: unknown): ScalabilityDerivation {
  const bodies: TemplateBody[] = [];
  const collect = (
    tmpl: Record<string, unknown>,
    symbol: string,
    label: string,
    passed: Record<string, unknown>,
  ): void => {
    bodies.push({ tmpl, symbol, label, passed });
    for (const { symbol: key, resource } of resourceEntries(tmpl)) {
      const r = asRecord(resource);
      if (r.type !== 'Microsoft.Resources/deployments') continue;
      const props = asRecord(r.properties);
      const inner = props.template;
      if (typeof inner !== 'object' || inner === null) continue;
      const name = typeof r.name === 'string' ? r.name : '(unnamed module)';
      collect(asRecord(inner), (key ?? name).toLowerCase(), name, asRecord(props.parameters));
    }
  };
  collect(asRecord(template), 'main.bicep', 'main.bicep', {});

  const envBlobs: EnvBlob[] = [];
  for (const b of bodies) collectEnvBlobs(b.tmpl, b.symbol, envBlobs);

  const out = new Map<string, ScalabilityDeclaration>();
  const unnamed: UnnamedDeclaration[] = [];
  for (const b of bodies) {
    const params = asRecord(b.tmpl.parameters);
    for (const { resource } of resourceEntries(b.tmpl)) {
      const r = asRecord(resource);
      const type = r.type;
      if (typeof type !== 'string' || type.toLowerCase() !== CONTAINER_APPS_TYPE) continue;

      // ── ONE RESOURCE, N APPS (the generic `apps[]` loop) ──────────────────
      // A `copy` block declares one Container App per array element. Left
      // unexpanded it is a single UNBOUNDED hole in the population, which would
      // shadow every unlisted subject and refuse the whole estate.
      const bindings: Array<CopyBinding | undefined> = [undefined];
      const copyBlock = asRecord(r.copy);
      if (typeof copyBlock.count === 'string') {
        const counted = COPY_COUNT.exec(copyBlock.count);
        const eff =
          counted?.[1] !== undefined ? effectiveParam(counted[1], b.passed, params) : null;
        if (counted?.[1] !== undefined && eff?.state === 'literal' && Array.isArray(eff.value)) {
          bindings.length = 0;
          for (const item of eff.value) {
            bindings.push({ param: counted[1], item: asRecord(item) });
          }
        }
        // A copy whose count does NOT resolve stays a single unresolved
        // resource below — it is not silently dropped.
      }

      for (const copy of bindings) {
        const named = resolveDeclaredName(r.name, params, b.passed, copy);
        if (named === null) {
          const expr = unresolvedNameExpr(r.name, params, b.passed);
          unnamed.push({
            module: b.label,
            nameExpr: expr,
            ...(unresolvedNamePrefix(expr) !== undefined
              ? { namePrefix: unresolvedNamePrefix(expr)! }
              : {}),
          });
          continue;
        }
        const consumers = consumersFor(named, b.symbol, envBlobs);
        const decl = declarationFor(r, b.tmpl, b.label, consumers, b.passed, copy);
        if (!decl) continue;
        const existing = out.get(decl.appName);
        // ── THE RESTRICTIVE READING WINS (review of #4261, finding 6) ──────
        // MERGE, never replace. The previous rule replaced a PINNED declaration
        // with an ELASTIC one whenever the elastic module knew more consumers,
        // which inverts the two claims: the operator would be told "no data is
        // lost" (availability) about a service another module pins as a
        // singleton (durability). That is the exact R7 inversion this file
        // exists to prevent, and the merge is the one place the invariant lives.
        //
        // Reachable only when one app is declared in two modules — MEASURED:
        // not true on today's artifact, so this is latent, not live. It is
        // fixed anyway, because "not reachable today" is not an invariant.
        out.set(
          decl.appName,
          existing
            ? {
                // The pinned declaration wins the durability verdict and keeps
                // its own prose; consumers UNION, so no module's wires are lost.
                ...(existing.scalableToZero ? decl : existing),
                scalableToZero: existing.scalableToZero && decl.scalableToZero,
                declaredConsumers: dedupeConsumers([
                  ...existing.declaredConsumers,
                  ...decl.declaredConsumers,
                ]),
              }
            : decl,
        );
      }
    }
  }
  return { declarations: out, unnamed };
}

/**
 * The declarations only, keyed by app name.
 *
 * Convenience over {@link deriveScalability} for callers that genuinely only
 * want the population. It DISCARDS `unnamed`, so a caller that uses this to
 * decide whether a subject is declared is asserting the population is complete
 * — which is the B1 hole in miniature. The production path does not use it.
 */
export function declarationsFromTemplate(
  template: unknown,
): ReadonlyMap<string, ScalabilityDeclaration> {
  return deriveScalability(template).declarations;
}

/**
 * Union of declared consumers across modules, keyed by the WHOLE wire so two
 * genuinely distinct wires are never collapsed into one (which would understate
 * the count the refusal text reports).
 */
function dedupeConsumers(all: readonly DeclaredConsumer[]): readonly DeclaredConsumer[] {
  const seen = new Map<string, DeclaredConsumer>();
  for (const c of all) seen.set(JSON.stringify(c), c);
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// The runtime lookup
// ---------------------------------------------------------------------------

let declarationCache: ScalabilitySource | undefined;

/** Reset the derived-declaration cache (test-only). */
export function __resetScalabilityCache(): void {
  declarationCache = undefined;
}

/**
 * Where the declarations came from, and whether they were ESTABLISHED at all.
 *
 * ── WHY A MAP IS NOT ENOUGH (review of #4261, finding 1) ────────────────────
 * `deployDeclaredScalability()` used to return a bare `ReadonlyMap` and an EMPTY
 * map for every failure. Measured on that shape:
 *
 *     refuseScaleToZero('loom-risingwave', new Map()) === null      // = ALLOW
 *
 * An empty map made EVERY subject performable, so a single `readFileSync` throw
 * on the 3.9 MB artifact at cold start silently disarmed all three "independent"
 * enforcement points at once — they share this one input, so with respect to
 * THIS failure they were never independent. The module comment claimed the case
 * was "reported ... never as everything is scalable dressed up as a fact", but
 * null and allow are the same value and the same outcome, so the reporting was
 * indistinguishable from permission. That comment was itself the R7 error.
 *
 * Three states, kept apart, because they are three different facts:
 *
 *   `declared`    the artifact was read and parsed. The map is what it says.
 *                 An EMPTY map here is still an anomaly (see `refuseScaleToZero`).
 *   `absent`      the artifact is not in this image at all. ESTABLISHED.
 *   `unreadable`  the read or the parse FAILED. NOTHING was established.
 */
export type ScalabilitySource =
  | {
      readonly status: 'declared';
      readonly declarations: ReadonlyMap<string, ScalabilityDeclaration>;
      readonly from: string;
      /**
       * Container Apps whose NAME could not be resolved, so they are absent from
       * `declarations`. While this is non-empty the map's population is
       * INCOMPLETE and "not in the map" establishes nothing — see
       * {@link refuseScaleToZero}.
       */
      readonly unnamed: readonly UnnamedDeclaration[];
    }
  | {
      readonly status: 'absent';
      readonly from: string;
      readonly detail: string;
    }
  | {
      readonly status: 'unreadable';
      readonly from: string;
      readonly detail: string;
    };

/**
 * The declarations derived from the BUNDLED compiled template, CLASSIFIED.
 *
 * Only an established outcome is cached — `resolveDlzTemplateInlineOutcome()`
 * does not cache `unreadable`, so a transient failure is retried on the next
 * call and the guard RECOVERS rather than staying disarmed for the life of the
 * process.
 */
export function deployDeclaredScalabilitySource(): ScalabilitySource {
  if (declarationCache !== undefined) return declarationCache;
  const outcome = resolveDlzTemplateInlineOutcome();
  if (outcome.status === 'unreadable') {
    // NOT cached, deliberately — this is the retryable one.
    return {
      status: 'unreadable',
      from: outcome.file,
      detail: outcome.detail,
    };
  }
  declarationCache =
    outcome.status === 'ok'
      ? (() => {
          const derived = deriveScalability(outcome.inline.template);
          return {
            status: 'declared' as const,
            declarations: derived.declarations,
            unnamed: derived.unnamed,
            from: outcome.file,
          };
        })()
      : {
          status: 'absent',
          from: outcome.candidates.join(' , '),
          detail:
            `the compiled deploy template is not present at any candidate path in this image ` +
            `(${outcome.candidates.length} tried). It is COPY'd by apps/fiab-console/Dockerfile; ` +
            'an image built without it cannot establish any scalability declaration.',
        };
  return declarationCache;
}

/**
 * The declarations as a plain map — EMPTY when the source could not be read.
 *
 * Kept for callers that only want the population (the tests that count
 * declarations, the population floor). NEVER use this to decide whether a
 * destructive action is permitted: an empty map from here does not say which of
 * the three {@link ScalabilitySource} states produced it. Use
 * {@link refuseScaleToZero}, which does.
 */
export function deployDeclaredScalability(): ReadonlyMap<string, ScalabilityDeclaration> {
  const source = deployDeclaredScalabilitySource();
  return source.status === 'declared' ? source.declarations : new Map();
}

/**
 * The declaration REFUSING scale-to-zero for this app, or null.
 *
 * Null covers three different states on purpose — not declared at all, declared
 * elastic, and no template in the image. None of them is a licence; they only
 * mean this particular check has nothing to say, and the rest of the guard chain
 * still applies. THE SOURCE-UNAVAILABLE CASE IS NOT HANDLED HERE — this function
 * answers "is there a durability declaration", and there is no declaration to
 * return when the source could not be read. {@link refuseScaleToZero} is the
 * load-bearing check and it refuses that case; every guard uses that one.
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
 *
 * ── THE DURABILITY CLAIM IS CONDITIONAL ON EVIDENCE (review of #4261, nit 7) ─
 * Of the three pinned apps only `loom-risingwave` yields a `declaredStatement`;
 * `loom-airflow` and `iceberg-catalog` are `undefined`, and `iceberg-catalog`'s
 * real reason is AVAILABILITY ("the catalog is on the metadata hot path",
 * `iceberg-catalog-aca.bicep:86`), not durability. Asserting "unrecoverable
 * loss" from the replica SHAPE alone would be the same proxy-for-property
 * substitution the predicate itself was corrected for, relocated into the
 * message. So the unrecoverable-loss claim is made only where the module said so
 * in its own words; otherwise the text says what shape actually establishes.
 */
export function nonScalableExplanation(decl: ScalabilityDeclaration): string {
  const head =
    `'${decl.appName}' CANNOT be scaled to zero: ${decl.reason}` +
    (decl.declaredStatement
      ? ` The module states it in its own words: "${decl.declaredStatement}."`
      : '') +
    ` Source: ${SCALABILITY_SOURCE_NOTE}`;
  return decl.declaredStatement
    ? head +
        ' Scaling a pinned singleton to zero destroys whatever state its single replica holds in ' +
        'process, and the next deploy re-asserts the declared floor anyway — so the write is ' +
        'unrecoverable loss in exchange for drift, not a saving (deploy-integrity.md R2).'
    : head +
        ' The module states NO reason in prose, so what is established here is the SHAPE: the ' +
        'deploy pins this app to a single replica that never scales to zero. Whether that floor ' +
        'exists for durability (state held in process) or for availability (a hot path that must ' +
        'not cold-start) is not established from the template, so neither is asserted. Either way ' +
        'the next deploy re-asserts the floor, so the write buys drift, not a saving ' +
        '(deploy-integrity.md R2).';
}

// ---------------------------------------------------------------------------
// THE AVAILABILITY HALF (#4257 review) — a DIFFERENT property, stated as such
// ---------------------------------------------------------------------------

/**
 * Why a scale-to-zero is refused. The two arms are DIFFERENT CLAIMS and are
 * never collapsed: telling an operator "this would lose data" about a service
 * that would only go offline is the R7 error in the other direction.
 *
 *   `pinned-singleton`   DURABILITY. The deploy fixed the replica count; the
 *                        single replica holds state in process. Unrecoverable.
 *   `declared-consumer`  AVAILABILITY. The deploy WIRES another app to this
 *                        service, so the finding's central claim ("nothing in
 *                        the deployment points at it") is contradicted by the
 *                        deploy's own template. Recoverable on cold start, but
 *                        it is an operator-triggered outage of a declared
 *                        dependency, taken on evidence the deploy disagrees with.
 */
export type ScaleToZeroRefusal =
  | { readonly kind: 'pinned-singleton'; readonly declaration: ScalabilityDeclaration }
  | { readonly kind: 'declared-consumer'; readonly declaration: ScalabilityDeclaration }
  | { readonly kind: 'self'; readonly appName: string }
  | {
      readonly kind: 'declaration-unavailable';
      /**
       * WHICH failure. `unreadable` may be transient; `absent` is a property of
       * the image; `name-unresolved` means the artifact parsed but its
       * population has a hole, so this subject's absence proves nothing.
       */
      readonly why: 'unreadable' | 'absent' | 'empty' | 'name-unresolved';
      /** The path(s) the answer was sought at — so the refusal NAMES its unreadable source. */
      readonly from: string;
      readonly detail: string;
    };

/**
 * ── WHY A SECOND SIGNAL EXISTS, AND WHY IT IS NOT THE REPLICA SHAPE ────────
 * The pinned-singleton predicate infers "must not scale to zero" from "is a
 * pinned singleton". Those two properties CORRELATE on this estate; they are
 * not the same property, and `loom-unity` is the measured counter-example:
 * `compute/loom-unity-app.bicep` renders min 1 / max 3 / WITH scale rules on
 * the Postgres path (`effectiveMinReplicas`/`effectiveMaxReplicas`, :292/:296,
 * rules at :543), so the shape says ELASTIC. Its state is external, so scaling
 * it to zero loses no data — it takes the federated-catalog metadata hot path
 * OFFLINE until cold start. `iceberg-catalog-aca.bicep:86` says exactly that in
 * prose: "the catalog is on the metadata hot path (never scale-to-zero)".
 *
 * That intent has NO machine-readable home in the compiled template today (no
 * tag, no metadata key, nothing but the prose), and adding one is a bicep edit
 * this lane does not own. So the second signal keys on a property the template
 * DOES carry and that means the operative thing: **the deploy declares another
 * app's `env` wire INTO this service.**
 *
 *   - shape-independent — `loom-unity` on Postgres is elastic and still refused
 *   - not a name list, not a prose match
 *   - generalizes — a new hot-path service is covered the day the deploy wires
 *     a consumer to it, with no edit here
 *
 * And it is the honest reading of the finding itself: `unreachable-always-on`
 * asserts "NOTHING in the live deployment points at it". When the deploy's own
 * template names a consumer, that assertion is contradicted at its source — the
 * #4258 extractor blindness (a 20-name env allowlist) is exactly how a wired
 * service comes to look unreachable. Acting destructively on a claim the deploy
 * disagrees with is not a saving; it is a false positive with an outage attached.
 *
 * It does NOT refuse everything: `loom-capacity-broker` — the founding
 * acceptance case — is wired by `LOOM_BROKER_URL: ''`, an EMPTY value that names
 * nothing, so no consumer is declared and it stays performable. That is the
 * control, and the tests assert it.
 */
export function declaredConsumerExplanation(decl: ScalabilityDeclaration): string {
  const modules = [...new Set(decl.declaredConsumers.map((c) => c.consumerModule))];
  const via = [...new Set(decl.declaredConsumers.map((c) => c.via))].join(' + ');
  return (
    `'${decl.appName}' must NOT be scaled to zero: the DEPLOY ITSELF wires ` +
    `${decl.declaredConsumers.length} consumer(s) to it (bicep module(s) ` +
    `${modules.map((m) => `'${m}'`).join(', ')}, matched by ${via}), so the finding's central ` +
    'claim — that NOTHING in the deployment points at this service — is contradicted by the ' +
    'deployment template. This is an AVAILABILITY refusal, not a durability one: no data is ' +
    'lost, but removing the always-on floor takes a declared dependency offline until it ' +
    `cold-starts. The live graph missing that wire is the known extractor blindness (#4258 — a ` +
    '20-name env allowlist discards most wires before resolution), not evidence that the ' +
    `service is unused. Source: ${SCALABILITY_SOURCE_NOTE}`
  );
}

/**
 * The name of THIS console's own Container App.
 *
 * Duplicated from `lib/admin/env-apply.ts`'s `consoleAppName()` rather than
 * imported — the same reason `lib/azure/aks-arm-client.ts` duplicates it: that
 * module drags the whole env-write path into this one's import closure, and this
 * file is imported by the pure-ish guard chain.
 */
function consoleOwnAppName(): string {
  return (process.env.LOOM_CONSOLE_APP_NAME || 'loom-console').trim().toLowerCase();
}

/**
 * The composite verdict for `scale-to-zero`, or null when nothing objects.
 *
 * DURABILITY IS REPORTED FIRST when both apply — it is the stronger claim and
 * the one an operator must not have softened into "it would just go offline".
 *
 * ── THE SOURCE IS CHECKED BEFORE THE SUBJECT (review of #4261, finding 1) ───
 * Fail CLOSED when the declaration source could not be established. "I could not
 * read the deploy template" and "the deploy template says this app is elastic"
 * are different facts and MUST NOT share the `null` return, because null is
 * allow. The three unavailable reasons are kept apart in the verdict AND in the
 * text, so an operator reading the refusal can tell a missing artifact from a
 * transient IO failure from a template that parsed but declares nothing.
 *
 * `unreadable` is not cached upstream, so a transient failure followed by a good
 * read RECOVERS — the guard is not disarmed for the life of the process.
 */
export function refuseScaleToZero(
  appName: string,
  source: ScalabilitySource | ReadonlyMap<string, ScalabilityDeclaration> =
    deployDeclaredScalabilitySource(),
): ScaleToZeroRefusal | null {
  const resolved: ScalabilitySource =
    source instanceof Map
      ? {
          status: 'declared',
          declarations: source,
          from: '(declarations supplied by the caller)',
          // A caller that hands over a bare Map is ASSERTING its population is
          // complete — there is nowhere else for the gap to be recorded. The
          // production path never does this; it goes through
          // `deployDeclaredScalabilitySource()`, which carries the real list.
          unnamed: [],
        }
      : (source as ScalabilitySource);

  if (resolved.status !== 'declared') {
    return {
      kind: 'declaration-unavailable',
      why: resolved.status,
      from: resolved.from,
      detail: resolved.detail,
    };
  }
  if (resolved.declarations.size === 0) {
    return {
      kind: 'declaration-unavailable',
      why: 'empty',
      from: resolved.from,
      detail:
        'the source was read and parsed successfully, and it yielded ZERO Container App ' +
        'scalability declarations. That is not a clean estate — this console is itself a ' +
        'Container App, and the committed artifact carries a double-digit number of static ' +
        'declarations — so an empty result means the artifact is not the one expected here ' +
        '(a stub, a truncation, or a schema change this parser no longer matches).',
    };
  }

  // ── THE CONSOLE MAY NOT ZERO ITSELF (review of #4261, finding 5) ──────────
  // The console comes from the generic `apps[]` copy loop, so its name resolves
  // to a `copyIndex()` expression and it never enters the derived map — i.e. it
  // is PERMITTED by every signal above. `unreachable-always-on` needs only
  // "always-on and no resolved inbound configured edge", and the console is the
  // consumer of everything and the consumee of little, so with #4258's 20-name
  // env allowlist that is a plausible finding, not a contrived one. The outcome
  // is an operator-triggered outage of the very surface they clicked from.
  const subject = appName.trim().toLowerCase();
  if (subject !== '' && subject === consoleOwnAppName()) {
    return { kind: 'self', appName: subject };
  }

  const decl = resolved.declarations.get(subject);
  if (!decl) {
    // ── AN INCOMPLETE MAP CANNOT SAY "NOT DECLARED" (review of #4261, B1) ────
    // A Container App whose name is a runtime expression has no key, so it is
    // missing from the map — and a lookup miss against a map with a hole in it
    // is indistinguishable from "this app is genuinely undeclared". Returning
    // null there is `absent -> allow`, the same shape as the round-1 fail-open.
    //
    // The hole is BOUNDED wherever it can be: only a hole that could actually
    // produce THIS name shadows this subject. MEASURED on the committed
    // artifact, after the `apps[]` copy loop is expanded the single remaining
    // hole is the dlz-attach gateway, whose name is
    // `[take(format('loom-s3-gateway-{0}', …), 32)]` — so it shadows
    // `loom-s3-gateway-*` and nothing else. Refusing every unlisted subject on
    // account of it would be a disabled feature wearing a guard's clothes.
    const shadowing = resolved.unnamed.filter(
      (u) => u.namePrefix === undefined || subject.startsWith(u.namePrefix),
    );
    if (shadowing.length > 0) {
      const where = shadowing
        .map((u) => `'${u.module}' (name expression ${u.nameExpr})`)
        .join('; ');
      return {
        kind: 'declaration-unavailable',
        why: 'name-unresolved',
        from: resolved.from,
        detail:
          `the template parsed, but ${shadowing.length} Container App declaration(s) could not be ` +
          'keyed because their app NAME is computed at deploy time, so the derived map is ' +
          `INCOMPLETE and '${subject}' not being in it establishes nothing — it may be one of ` +
          `them. Unresolved and capable of producing this name: ${where}. This is not a claim ` +
          'that the app is undeclared; it is a claim that the question could not be answered ' +
          'from this artifact.',
      };
    }
    return null;
  }
  if (!decl.scalableToZero) return { kind: 'pinned-singleton', declaration: decl };
  if (decl.declaredConsumers.length > 0) {
    return { kind: 'declared-consumer', declaration: decl };
  }
  return null;
}

/** The operator-facing text for a refusal, keyed to WHICH claim it is making. */
export function scaleToZeroRefusalReason(refusal: ScaleToZeroRefusal): string {
  switch (refusal.kind) {
    case 'pinned-singleton':
      return nonScalableExplanation(refusal.declaration);
    case 'declared-consumer':
      return declaredConsumerExplanation(refusal.declaration);
    case 'self':
      return (
        `'${refusal.appName}' is THIS CONSOLE. Scaling it to zero removes the surface the ` +
        'recommendation was read from and the API that would have to bring it back, so the ' +
        'action cannot be undone from where it was taken. The console is reachable by EXTERNAL ' +
        'ingress — a browser, Front Door, a webhook — and none of those is an edge in this ' +
        "graph, so 'zero inbound configured edges' establishes nothing about whether it is " +
        'used. This is an AVAILABILITY refusal, not a durability one: no data is lost. Set ' +
        'LOOM_CONSOLE_APP_NAME if this console runs under a different app name.'
      );
    case 'declaration-unavailable':
      return declarationUnavailableExplanation(refusal);
  }
}

/**
 * The refusal text for a source that could not be established.
 *
 * The three reasons say DIFFERENT things, because they are different facts and
 * they have different remediations. R7: none of them asserts that the subject is
 * or is not scalable — that was never established, and saying otherwise is the
 * error this whole arm exists to prevent.
 */
export function declarationUnavailableExplanation(
  refusal: Extract<ScaleToZeroRefusal, { kind: 'declaration-unavailable' }>,
): string {
  const head =
    'REFUSED because the deploy template could not be consulted, NOT because this resource was ' +
    `judged unsafe — and not because it was judged safe either. Nothing was established about ` +
    'this subject at all. A destructive scale-to-zero is refused rather than performed blind.';
  const tail =
    ' This refusal is fail-CLOSED on purpose: an unreadable input is not an empty one, and ' +
    'treating "I could not read the declaration" as "there is no declaration" would let one bad ' +
    'read permit every scale-to-zero on the estate (deploy-integrity.md R7).';
  switch (refusal.why) {
    case 'unreadable':
      return (
        `${head} The artifact at '${refusal.from}' EXISTS and could not be read or parsed: ` +
        `${refusal.detail} This may be transient (IO pressure at cold start), so it is NOT ` +
        'cached — retry the action and it will re-read. If it persists, the bundled template is ' +
        `corrupt in this image and the image must be rebuilt.${tail}`
      );
    case 'absent':
      return (
        `${head} ${refusal.detail} Paths tried: '${refusal.from}'. Remediation: rebuild the ` +
        "console image with the deploy-templates/main.json COPY intact — it is what every " +
        `scalability declaration is derived from.${tail}`
      );
    case 'empty':
      return `${head} Source: '${refusal.from}'. ${refusal.detail}${tail}`;
    case 'name-unresolved':
      return (
        `${head} Source: '${refusal.from}'. ${refusal.detail} Remediation: this is a gap in the ` +
        'reader, not in the estate — the module(s) named above declare their app name with an ' +
        'expression this static resolver does not evaluate. Until it does, an unlisted subject is ' +
        `refused rather than performed blind.${tail}`
      );
  }
}
