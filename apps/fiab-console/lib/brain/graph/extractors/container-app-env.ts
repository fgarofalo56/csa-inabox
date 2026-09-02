/**
 * LOOM BRAIN — extractor: live container-app env → `configured` edges.
 *
 * PURE. Takes env lists a caller has ALREADY read (ARM GET or Resource Graph
 * projection) and turns them into edges. No client, no request, no write.
 *
 * ── WHY `configured` IS A DIFFERENT PROVENANCE FROM `declared` ─────────────
 * `declared` is what the TEMPLATE says. `configured` is what the DEPLOYMENT
 * actually has. They disagree routinely, and each direction of disagreement is a
 * distinct finding:
 *
 *   declared, not configured  the bicep wires it, the running app does not have
 *                             it — a deploy that never rolled, or a value the
 *                             template computes to ''.
 *   configured, not declared  someone set it by hand on the live app. MEASURED
 *                             on this estate: `lib/azure/capacity-broker-client.ts`
 *                             records that the live Commercial console carries
 *                             BOTH `LOOM_BROKER_URL` (bicep-emitted) and a
 *                             hand-added `LOOM_CAPACITY_BROKER_URL`, which is
 *                             what patching around a broken binding by hand
 *                             looks like. Only a `configured` edge can see it;
 *                             no amount of reading bicep ever will.
 *
 * ── `secretRef` IS INDETERMINATE, NOT EMPTY (R7) ───────────────────────────
 * A Container Apps env entry is either `{ name, value }` or `{ name, secretRef }`.
 * A `secretRef` entry HAS a value; this process simply cannot see it. Reporting
 * that as an empty wire would manufacture a dangling edge for a variable that is
 * correctly configured — a false claim, and one that would put a healthy service
 * on a cleanup list. So `secretRef` produces NO edge and a recorded skip, and
 * the skip says which variable and why.
 *
 * ── THE VALUE IS THE EVIDENCE, NOT THE VARIABLE'S NAME (#4258) ─────────────
 * Until 2026-09-01 this extractor took `onlyNames` as a HARD FILTER: an env
 * entry whose name was absent from the caller's list was `continue`d before its
 * value was ever looked at, and it was not even counted. The console supplied a
 * 20-name list; the `unreachable-always-on` detector then judged all 65 Container
 * Apps. MEASURED consequence: `loom-risingwave` is wired for real at
 * `platform/fiab/bicep/modules/admin-plane/main.bicep:4859`
 * (`LOOM_RISINGWAVE_URL = 'loom-risingwave.internal.${caeDefaultDomain}:4566'`),
 * but `LOOM_RISINGWAVE_URL` was not on the list, so the wire was discarded HERE —
 * before FQDN resolution would have matched it — and the service could never gain
 * an inbound edge. It was reported as "unreachable and always-on", which was a
 * true statement about this extractor's population and a FALSE statement about
 * the estate. A control that is loudly red while examining a set that structurally
 * excludes its own subject.
 *
 * THE FIX: an entry is admitted when EITHER
 *   (1) its NAME is one the caller always wants considered (the wire-binding
 *       table — required for EMPTY values, which cannot name their own target),
 *       OR
 *   (2) its VALUE names something the SAME pull actually discovered — an ARM id
 *       or an ingress FQDN in {@link EstateTargetIndex}.
 *
 * (2) is what makes the blindness structurally impossible to reintroduce by
 * forgetting a row: the candidate set is DERIVED from the measured estate, so it
 * cannot drift from what the deploy actually wired.
 *
 * WHAT (2) DELIBERATELY DOES **NOT** DO — do not "improve" these away:
 *   • It never infers a target from the variable's NAME. `wire-bindings.ts`
 *     records why: `LOOM_BROKER_URL` name-mangles to `loom-broker`, and the app
 *     is `loom-capacity-broker`. A heuristic that guesses wrong but plausibly
 *     manufactures an inbound edge for the WRONG node and makes an unreachable
 *     service look reachable — undetectable from the output.
 *   • It never admits a BARE TOKEN by resource-name match. `resolveTarget` can
 *     resolve an unambiguous bare name, but admitting one HERE would let
 *     `LOG_LEVEL=info` mint an edge the moment some resource is named `info`.
 *     Bare tokens outside the name list are counted and reported as an
 *     acknowledged recall gap instead of guessed at.
 *   • It never widens beyond what the pull discovered. `AOAI_ENDPOINT=
 *     https://x.openai.azure.com` names a real service that is not in the
 *     container-tier query, so it produces no edge — and is COUNTED, so the gap
 *     is visible rather than implied.
 *
 * ── THE POPULATION IS REPORTED, NOT IMPLIED ────────────────────────────────
 * Every entry this extractor declines is counted and the counts ride on the
 * `ExtractionResult` — in `population.scope` and in aggregate {@link SkippedSubject}
 * records that reach the snapshot. A caller that supplies a name list and NO
 * `estateTargets` is in the pre-#4258 blind configuration, and that fact is
 * emitted as its own skip record rather than left for a reader to infer.
 */

import type {
  ExtractionResult,
  NodeId,
  PendingEdge,
  SkippedSubject,
} from '../../types';
import { azureResourceNodeId } from '../node-id';
import { makePopulation } from '../graph';

/**
 * What the SAME pull actually discovered, keyed the way a wire's VALUE names it.
 *
 * Built by the caller from the resource extractor's OWN node output — never from
 * a hand list and never from a second read — so it cannot disagree with the
 * graph the edges are about to be resolved against.
 */
export interface EstateTargetIndex {
  /** Lowercased ingress FQDNs. How `https://svc.internal.example.io/x` finds its app. */
  readonly fqdns: ReadonlySet<string>;
  /**
   * Canonical node ids (i.e. {@link azureResourceNodeId} output), for values that
   * carry a full ARM resource id.
   */
  readonly resourceIds: ReadonlySet<string>;
}

/** One env entry as ARM returns it. Exactly one of `value` / `secretRef` is set. */
export interface ContainerAppEnvEntry {
  readonly name: string;
  /** The literal value. `''` is a REAL state — an empty wire — not a missing field. */
  readonly value?: string;
  /** Present when the value comes from a secret. The value is not readable here. */
  readonly secretRef?: string;
}

/** The live env of one container app. */
export interface ContainerAppEnvInput {
  /** ARM resource id of the app whose env this is. Becomes the edge's `from`. */
  readonly appResourceId: string;
  readonly env: readonly ContainerAppEnvEntry[];
  /**
   * Env var name → the node it is MEANT to reach, for entries whose value is
   * empty. Same rationale as the bicep extractor: an empty value cannot name its
   * own target, so the mapping is supplied as reviewable data rather than
   * inferred from the variable's name.
   */
  readonly envVarBindings?: Readonly<Record<string, NodeId>>;
  /**
   * Env var names to consider WHATEVER their value looks like — including `''`.
   *
   * This is the binding table's name set. It is required for EMPTY values only:
   * `''` names nothing, so an empty wire's intent cannot be recovered from its
   * value and has to be supplied as `envVarBindings`. Omit to consider every
   * entry by name.
   *
   * IT IS NOT A FILTER ON WHAT CAN PRODUCE AN EDGE. An entry whose name is not
   * here is still admitted when its VALUE names something in
   * {@link ContainerAppEnvInput.estateTargets} — see this module's header for the
   * measured false positive (#4258) that made that non-negotiable.
   */
  readonly alwaysConsiderNames?: readonly string[];
  /**
   * @deprecated Legacy spelling of {@link alwaysConsiderNames}, unioned with it.
   *
   * Retained ONLY because a second caller — `lib/brain/run/azure/arg-graph-source.ts`,
   * owned by the scheduled-run lane — still supplies it. It no longer means "only
   * these names": with `estateTargets` supplied it is an ALWAYS-CONSIDER list;
   * without `estateTargets` it is still a hard filter, and THAT configuration is
   * reported as a named recall gap rather than left implicit.
   */
  readonly onlyNames?: readonly string[];
  /**
   * Targets the same pull discovered. Supplying this is what lets a wire be found
   * by its VALUE rather than by its variable's name.
   *
   * Omitting it is a legitimate call shape (a unit test with no estate, a caller
   * that has no node set yet) — and it is REPORTED, because omitting it while
   * also supplying a name list reproduces exactly the population blindness of
   * #4258.
   */
  readonly estateTargets?: EstateTargetIndex;
  /**
   * This app's OWN ingress FQDN, when it has one.
   *
   * Required to reject SELF-REFERENCE. {@link EstateTargetIndex} is two flat
   * sets with no node attribution, so `namesADiscoveredTarget` can tell that a
   * value names *something* discovered but not *which* something — and an app
   * advertising its own address (`RW_ADVERTISE_ADDR`,
   * `KAFKA_ADVERTISED_LISTENERS`, `TRINO_DISCOVERY_URI`) would otherwise be
   * admitted, resolve to itself, and clear the unreachable-service detector on
   * the strength of an edge that points nowhere. The ARM-id form of the same
   * value is caught without this field, by comparing against `from`.
   *
   * Omitting it is legitimate (a unit test, a caller with no ingress in hand)
   * and only weakens the FQDN half of the check; `graph.ts` refuses to index a
   * `from === to` edge regardless, so the detector cannot be fooled either way.
   */
  readonly selfFqdn?: string;
}

/**
 * Values that name a target rather than being one. A wire whose value is a
 * boolean or a numeric knob is not pointing at a node, and turning it into a
 * dangling edge would be noise that looks like a finding.
 */
function looksLikeATarget(value: string): boolean {
  const v = value.trim();
  if (v === '') return false;
  if (/^(true|false|yes|no|on|off|enabled|disabled)$/i.test(v)) return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return false;
  return (
    v.startsWith('/subscriptions/') ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ||
    /\.[a-z]{2,}(:\d+)?(\/|$)/i.test(v) ||
    /^[a-z0-9][a-z0-9-]{2,}$/i.test(v)
  );
}

/**
 * Strip scheme, port, path, query, fragment and trailing dot from a URL or bare
 * host, and lowercase it.
 *
 * MUST agree with `graph.ts`'s `hostOf`, which is what actually resolves the
 * edge. A disagreement in either direction is a defect: admit a value this
 * normalizes differently and the edge is emitted but dangles; decline one and
 * the wire is discarded again. The agreement is asserted END-TO-END — the specs
 * push scheme / port / path / uppercase / trailing-dot forms through
 * `extractFromContainerAppEnv` + `buildGraph` and require a RESOLVED edge —
 * rather than by comparing two implementations, because only the end-to-end form
 * fails when either side drifts.
 */
function hostOf(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const noScheme = v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const host = noScheme.split('/')[0]!.split('?')[0]!.split('#')[0]!;
  const noPort = host.replace(/:\d+$/, '');
  const clean = noPort.replace(/\.$/, '').trim().toLowerCase();
  return clean || null;
}

/**
 * Does this VALUE name something the pull actually discovered?
 *
 * Deliberately narrower than {@link looksLikeATarget}: membership in the measured
 * index, never a shape guess. Returns the KIND of match so the population can say
 * how a wire was found, or `null` when the value names nothing discovered.
 *
 * EXPORTED so a caller that reports the same statistic uses THIS function rather
 * than a second copy of the host-normalization rules. A caller-side copy would
 * be a fourth place the parsing lives and the first place it drifts.
 */
export function namesADiscoveredTarget(
  value: string,
  targets: EstateTargetIndex | undefined,
): 'arm-id' | 'fqdn' | null {
  if (!targets) return null;
  const v = value.trim();
  if (v === '') return null;

  // Case-insensitive, exactly as `resolveTarget` does it. Written
  // `v.startsWith('/subscriptions/')` this misses `/SUBSCRIPTIONS/…`, the value
  // falls through to the host test, matches nothing, and the target silently
  // loses an inbound edge — the same bug node-id.test.ts caught in the resolver.
  if (/^\/subscriptions\//i.test(v)) {
    return targets.resourceIds.has(azureResourceNodeId(v)) ? 'arm-id' : null;
  }

  const host = hostOf(v);
  if (host !== null && targets.fqdns.has(host)) return 'fqdn';
  return null;
}

/**
 * Does this VALUE name the app it was read FROM?
 *
 * A self-advertised address is a real, extremely common configuration —
 * `RW_ADVERTISE_ADDR`, `KAFKA_ADVERTISED_LISTENERS`, `TRINO_DISCOVERY_URI`,
 * `<X>_NODE_URL` are standard for the distributed-systems images this estate
 * runs — and it is NOT an inbound wire. Admitting it mints a `from === to` edge
 * that resolves, lands in `inbound`, and clears `unreachable-service` with the
 * ledger reason "a resolved `configured` edge in the live deployment points at
 * it" — where the thing pointing at it is itself. That is the same lie as the
 * bug this extractor exists to fix, inverted: #4258 was a false POSITIVE from a
 * wire nobody saw; this is a false NEGATIVE from a wire that is not real.
 *
 * Both address forms are covered:
 *   • ARM id — canonicalized and compared to `from`, needs nothing extra.
 *   • FQDN   — compared to `selfFqdn`, because {@link EstateTargetIndex} is a
 *     flat set with no node attribution and therefore cannot say WHICH app a
 *     matched host belongs to.
 *
 * Normalization goes through the same {@link hostOf} the resolver uses, so a
 * value that WOULD have resolved to this app is the same set this rejects.
 */
export function namesSelf(value: string, from: NodeId, selfFqdn: string | undefined): boolean {
  const v = value.trim();
  if (v === '') return false;
  if (/^\/subscriptions\//i.test(v)) return azureResourceNodeId(v) === from;
  if (selfFqdn === undefined) return false;
  const self = hostOf(selfFqdn);
  if (self === null) return false;
  const host = hostOf(v);
  return host !== null && host === self;
}

/**
 * What the extractor RANGED OVER, including everything it declined.
 *
 * Carried on `population.scope` and as aggregate skip records so a detector or a
 * surface can state the recall bound instead of implying estate-wide coverage.
 * Every field is a count of entries, not of apps.
 */
interface EnvScanTally {
  /** Every env entry handed in, before any admission decision. */
  seen: number;
  /** Entries admitted as candidate wires — the set edges can come from. */
  considered: number;
  /** Admitted because the caller always considers that NAME. */
  admittedByName: number;
  /** Admitted because the VALUE named a discovered ARM id or ingress FQDN. */
  admittedByValue: number;
  /** Admitted, value `''` — a real empty wire. */
  emptyWires: number;
  /** Admitted by name, value set, but not target-shaped (a flag, a number, free text). */
  notAWire: number;
  /** NOT admitted: `''` and outside the name list, so its intent cannot be established. */
  declinedEmptyUnnamed: number;
  /** NOT admitted: value set, outside the name list, and naming nothing this pull discovered. */
  declinedValueOutsideEstate: number;
  /**
   * NOT admitted: the value named the app it was read FROM. A self-advertised
   * address is not an inbound wire, and an edge for it would clear the
   * unreachable-service detector on evidence that points nowhere.
   */
  selfReference: number;
  secretRef: number;
  indeterminate: number;
}

export function extractFromContainerAppEnv(
  apps: readonly ContainerAppEnvInput[],
): ExtractionResult {
  const edges: PendingEdge[] = [];
  const skipped: SkippedSubject[] = [];
  const tally: EnvScanTally = {
    seen: 0,
    considered: 0,
    admittedByName: 0,
    admittedByValue: 0,
    emptyWires: 0,
    notAWire: 0,
    declinedEmptyUnnamed: 0,
    declinedValueOutsideEstate: 0,
    selfReference: 0,
    secretRef: 0,
    indeterminate: 0,
  };
  let appsWithNameList = 0;
  let appsWithNameListAndNoTargets = 0;

  for (const app of apps) {
    const from = azureResourceNodeId(app.appResourceId);
    const bindings = app.envVarBindings ?? {};
    const nameList = [...(app.alwaysConsiderNames ?? []), ...(app.onlyNames ?? [])];
    // SEMANTICS, decided deliberately: the name list is keyed on whether the
    // caller SUPPLIED one, never on whether it happens to be non-empty. An
    // explicit `onlyNames: []` therefore means "consider NOTHING by name" — an
    // empty Set, which admits nothing — and NOT "consider everything". Keying on
    // `nameList.length > 0` would invert it: `[]` would collapse to `null`, every
    // entry would be admitted by default, and each URL-shaped value with no
    // `estateTargets` would emit a DANGLING `unresolved-target` edge. Those
    // inflate `byProvenance.configured` (dangling-inclusive, `graph.ts`
    // `countByProvenance`), which is the exact counter the vacuity guard in
    // `lib/brain-actions/guards.ts` reads — i.e. the inversion would make #4258
    // item 3's failure mode EASIER to reach, from a type-legal caller input.
    // `arg-graph-source.ts` derives its list from a caller-supplied array where
    // empty is type-legal, so this is reachable, not theoretical.
    const always =
      app.alwaysConsiderNames !== undefined || app.onlyNames !== undefined
        ? new Set(nameList)
        : null;
    if (always !== null) {
      appsWithNameList += 1;
      if (!app.estateTargets) appsWithNameListAndNoTargets += 1;
    }

    for (const entry of app.env) {
      tally.seen += 1;
      if (entry.secretRef !== undefined) tally.secretRef += 1;
      else if (entry.value === undefined) tally.indeterminate += 1;

      // ── ADMISSION ────────────────────────────────────────────────────────
      // By NAME (the binding table — the only path an EMPTY value can take), or
      // by VALUE (it names something this pull discovered). Neither path can
      // silently exclude: the declined branch below is COUNTED, per category.
      const byName = always === null || always.has(entry.name);
      const valueMatch =
        !byName && entry.secretRef === undefined && typeof entry.value === 'string'
          ? namesADiscoveredTarget(entry.value, app.estateTargets)
          : null;

      if (!byName && valueMatch === null) {
        if (entry.secretRef === undefined && entry.value !== undefined) {
          if (entry.value.trim() === '') tally.declinedEmptyUnnamed += 1;
          else tally.declinedValueOutsideEstate += 1;
        }
        continue;
      }

      // ── SELF-REFERENCE ───────────────────────────────────────────────────
      // An app advertising its OWN address (`RW_ADVERTISE_ADDR`,
      // `KAFKA_ADVERTISED_LISTENERS`, `TRINO_DISCOVERY_URI`, `<X>_NODE_URL` —
      // standard for the distributed-systems images this estate runs) is not an
      // INBOUND wire. Admitting it mints a resolved `from === to` edge, which
      // `unreachable-service` counts as "a resolved configured edge points at
      // it" and CLEARS the app — on the strength of the app pointing at itself.
      // That is the same lie as #4258 inverted: #4258 was a false positive from
      // an edge we could not see; this is a false negative from an edge that is
      // not real. Declined here, and COUNTED, so it is reported rather than
      // silent. Checked for BOTH admission paths, since a variable that is in
      // the name list and holds the app's own address is equally a self-edge.
      if (
        entry.secretRef === undefined &&
        typeof entry.value === 'string' &&
        namesSelf(entry.value, from, app.selfFqdn)
      ) {
        tally.selfReference += 1;
        continue;
      }

      tally.considered += 1;
      if (byName) tally.admittedByName += 1;
      else tally.admittedByValue += 1;

      if (entry.secretRef !== undefined) {
        skipped.push({
          subject: `${app.appResourceId} ${entry.name}`,
          reason:
            `value comes from secretRef '${entry.secretRef}' and is NOT readable here. ` +
            'INDETERMINATE — this is not an empty wire, and no edge is emitted either way.',
        });
        continue;
      }

      if (entry.value === undefined) {
        skipped.push({
          subject: `${app.appResourceId} ${entry.name}`,
          reason:
            'entry has neither `value` nor `secretRef`. The env list was read but this entry ' +
            'carries no value field — indeterminate, not empty.',
        });
        continue;
      }

      const value = entry.value;
      const isEmpty = value.trim() === '';

      if (isEmpty) {
        // THE FOUNDING CASE, live side. The wire EXISTS on the running app and
        // carries ''. Emitted as a dangling edge so the evidence survives; its
        // `to` is null so it does not make the target reachable.
        tally.emptyWires += 1;
        const intendedTo = bindings[entry.name] ?? null;
        edges.push({
          provenance: 'configured',
          from,
          targetRef: '',
          emptyValue: true,
          intendedTo,
          evidence: {
            artifact: app.appResourceId,
            symbol: entry.name,
            rawValue: value,
            extractor: 'container-app-env',
          },
        });
        if (intendedTo === null) {
          skipped.push({
            subject: `${app.appResourceId} ${entry.name}`,
            reason:
              'live value is EMPTY and no envVarBindings entry names its intended target, so the ' +
              'dangling edge cannot be attached to a node. It is still emitted and visible via ' +
              'danglingEdges().',
          });
        }
        continue;
      }

      // `valueMatch !== null` means the value is IN the measured target index,
      // which is strictly stronger evidence than the shape test — so it is not
      // re-litigated here. Only name-admitted entries reach the shape test.
      if (valueMatch === null && !looksLikeATarget(value)) {
        tally.notAWire += 1;
        skipped.push({
          subject: `${app.appResourceId} ${entry.name}`,
          reason:
            'value is set but does not name a target (a flag, a number, or free text). ' +
            'Not a wire; no edge emitted.',
        });
        continue;
      }

      edges.push({
        provenance: 'configured',
        from,
        targetRef: value,
        emptyValue: false,
        intendedTo: bindings[entry.name] ?? null,
        evidence: {
          artifact: app.appResourceId,
          symbol: entry.name,
          rawValue: value,
          extractor: 'container-app-env',
        },
      });
    }
  }

  // ── THE RECALL BOUND, STATED (#4258) ─────────────────────────────────────
  // Aggregate rather than per-entry: a Loom app carries well over a hundred env
  // vars, so one record per declined entry would be thousands of rows and would
  // bury the wires that matter — the failure mode the old hard filter was trying
  // to avoid. But it is a RECORD, not a silence: the old code `continue`d on a
  // name miss without counting it, which is what let "zero inbound edges across
  // 65 Container App(s) examined" be published as a statement about the estate.
  if (tally.declinedValueOutsideEstate > 0 || tally.declinedEmptyUnnamed > 0) {
    skipped.push({
      subject: `${apps.length} container app(s) — env entries outside the always-consider name list`,
      reason:
        `${tally.declinedValueOutsideEstate} entr(ies) carried a value that names NOTHING this ` +
        `pull discovered (a service outside the query's resource-type filter, an external ` +
        `endpoint, or a bare token this extractor refuses to guess at), and ` +
        `${tally.declinedEmptyUnnamed} were EMPTY with no binding row, so their intended target ` +
        'cannot be established. NO edge was emitted for any of them. Inbound-wire coverage is ' +
        'therefore bounded by what this pull discovered — a "zero inbound edges" verdict ranges ' +
        'over that bound, not over the estate.',
    });
  }
  if (appsWithNameListAndNoTargets > 0) {
    skipped.push({
      subject: `${appsWithNameListAndNoTargets} of ${apps.length} container app(s) — no estateTargets supplied`,
      reason:
        'these apps were scanned with an always-consider NAME LIST and NO estateTargets index, ' +
        'so for them the list is still a HARD FILTER and a wire riding a variable outside it is ' +
        'discarded before resolution. That is the exact population blindness of #4258: an app ' +
        'whose only inbound wire uses an unlisted variable name can never gain an inbound edge, ' +
        'and is then vacuously "unreachable". Supply estateTargets, built from the same pull, to ' +
        'remove the bound.',
    });
  }

  if (tally.selfReference > 0) {
    skipped.push({
      subject: `${apps.length} container app(s) — env entries naming the app they were read FROM`,
      reason:
        `${tally.selfReference} entr(ies) carried a value resolving to the SAME app (a self-advertised ` +
        'address such as RW_ADVERTISE_ADDR / KAFKA_ADVERTISED_LISTENERS / TRINO_DISCOVERY_URI). ' +
        'That is not an inbound wire, so NO edge was emitted. Had one been, it would have been a ' +
        'resolved `from === to` edge and the unreachable-service detector would have cleared the ' +
        'app because "a resolved configured edge points at it" — where the thing pointing at it is ' +
        'itself. Counted here so the decline is stated rather than silent.',
    });
  }

  return {
    source: 'container-app-env',
    // No nodes: the apps themselves come from Resource Graph, which reads their
    // scale, ingress and tags. Minting a second, thinner node for the same ARM
    // id here would be de-duplicated by buildGraph anyway, but emitting it would
    // imply this extractor established facts it did not.
    nodes: [],
    edges,
    population: makePopulation({
      subject: 'edges',
      nodes: [],
      edges,
      scope:
        `${apps.length} container app(s); ${tally.seen} env entr(ies) SEEN, ` +
        `${tally.considered} considered (${tally.admittedByName} by name, ` +
        `${tally.admittedByValue} by VALUE naming a discovered target); ` +
        `${tally.declinedValueOutsideEstate} declined — value named nothing discovered; ` +
        `${tally.declinedEmptyUnnamed} declined — EMPTY and unbound; ` +
        `${tally.selfReference} declined — value named the app it was read FROM; ` +
        `${tally.notAWire} not a wire; ${tally.secretRef} secretRef (INDETERMINATE); ` +
        `${tally.indeterminate} with no value field; ` +
        `${appsWithNameList} app(s) scanned with an always-consider name list` +
        (appsWithNameListAndNoTargets > 0
          ? ` (${appsWithNameListAndNoTargets} of them with NO estateTargets — name list acts as a HARD FILTER there)`
          : '') +
        `; ${edges.length} configured edge(s) emitted (${tally.emptyWires} EMPTY); ` +
        `${skipped.length} skipped`,
    }),
    skipped,
  };
}
