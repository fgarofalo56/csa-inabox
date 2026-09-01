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
    if (blob.ownerSymbol === ownerSymbol) continue;
    if (moduleRef && blob.text.includes(moduleRef)) {
      out.push({ consumerModule: blob.ownerSymbol, via: 'module-reference' });
      continue;
    }
    if (blob.text.includes(fqdnLiteral)) {
      out.push({ consumerModule: blob.ownerSymbol, via: 'fqdn-literal' });
    }
  }
  return out;
}

function declarationFor(
  resource: Record<string, unknown>,
  template: Record<string, unknown>,
  moduleLabel: string,
  declaredConsumers: readonly DeclaredConsumer[],
): ScalabilityDeclaration | null {
  const params = asRecord(template.parameters);
  const variables = asRecord(template.variables);

  const appName = resolveDeclaredName(resource.name, params);
  if (appName === null) return null;

  const scale = asRecord(asRecord(asRecord(resource.properties).template).scale);
  const minReplicas = resolveDeclaredInt(scale.minReplicas, params, variables);
  const maxReplicas = resolveDeclaredInt(scale.maxReplicas, params, variables);

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

  const pinned = minReplicas >= 1 && maxReplicas === minReplicas && !hasScaleRules;
  const declaredStatement = pinned ? declaredStatementFrom(template) : undefined;

  return {
    appName,
    module: moduleLabel,
    scalableToZero: !pinned,
    declared: { minReplicas, maxReplicas, hasScaleRules },
    declaredConsumers,
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

/** One template body in the graph, with the identity a consumer would name it by. */
interface TemplateBody {
  readonly tmpl: Record<string, unknown>;
  /** Symbolic resource key of the nested deployment — what `reference()` names. */
  readonly symbol: string;
  /** The deployment's `name`, shown to operators. */
  readonly label: string;
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
 *
 * Two passes, and the order is load-bearing: every `env` block in the whole
 * graph must be collected BEFORE any app is judged, because the consumer of a
 * data-plane app is usually the Console, whose module is walked later.
 */
export function declarationsFromTemplate(
  template: unknown,
): ReadonlyMap<string, ScalabilityDeclaration> {
  const bodies: TemplateBody[] = [];
  const collect = (tmpl: Record<string, unknown>, symbol: string, label: string): void => {
    bodies.push({ tmpl, symbol, label });
    for (const { symbol: key, resource } of resourceEntries(tmpl)) {
      const r = asRecord(resource);
      if (r.type !== 'Microsoft.Resources/deployments') continue;
      const inner = asRecord(r.properties).template;
      if (typeof inner !== 'object' || inner === null) continue;
      const name = typeof r.name === 'string' ? r.name : '(unnamed module)';
      collect(asRecord(inner), (key ?? name).toLowerCase(), name);
    }
  };
  collect(asRecord(template), 'main.bicep', 'main.bicep');

  const envBlobs: EnvBlob[] = [];
  for (const b of bodies) collectEnvBlobs(b.tmpl, b.symbol, envBlobs);

  const out = new Map<string, ScalabilityDeclaration>();
  for (const b of bodies) {
    for (const { resource } of resourceEntries(b.tmpl)) {
      const r = asRecord(resource);
      const type = r.type;
      if (typeof type !== 'string' || type.toLowerCase() !== CONTAINER_APPS_TYPE) continue;
      const named = resolveDeclaredName(r.name, asRecord(b.tmpl.parameters));
      const consumers = named === null ? [] : consumersFor(named, b.symbol, envBlobs);
      const decl = declarationFor(r, b.tmpl, b.label, consumers);
      if (!decl) continue;
      const existing = out.get(decl.appName);
      // Prefer a pinned declaration; otherwise keep whichever knows more consumers.
      if (
        !existing ||
        (existing.scalableToZero && !decl.scalableToZero) ||
        (existing.declaredConsumers.length === 0 && decl.declaredConsumers.length > 0)
      ) {
        out.set(decl.appName, decl);
      }
    }
  }
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
  | { readonly kind: 'declared-consumer'; readonly declaration: ScalabilityDeclaration };

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
 * The composite verdict for `scale-to-zero`, or null when nothing objects.
 *
 * DURABILITY IS REPORTED FIRST when both apply — it is the stronger claim and
 * the one an operator must not have softened into "it would just go offline".
 */
export function refuseScaleToZero(
  appName: string,
  declarations: ReadonlyMap<string, ScalabilityDeclaration> = deployDeclaredScalability(),
): ScaleToZeroRefusal | null {
  const decl = declarations.get(appName.trim().toLowerCase());
  if (!decl) return null;
  if (!decl.scalableToZero) return { kind: 'pinned-singleton', declaration: decl };
  if (decl.declaredConsumers.length > 0) {
    return { kind: 'declared-consumer', declaration: decl };
  }
  return null;
}

/** The operator-facing text for a refusal, keyed to WHICH claim it is making. */
export function scaleToZeroRefusalReason(refusal: ScaleToZeroRefusal): string {
  return refusal.kind === 'pinned-singleton'
    ? nonScalableExplanation(refusal.declaration)
    : declaredConsumerExplanation(refusal.declaration);
}
