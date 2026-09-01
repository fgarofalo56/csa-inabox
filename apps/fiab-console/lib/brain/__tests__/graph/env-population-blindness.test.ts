/**
 * LOOM BRAIN — THE EXTRACTOR'S POPULATION MUST CONTAIN ITS OWN SUBJECT (#4258).
 *
 * ── THE DEFECT THESE SPECS PIN ─────────────────────────────────────────────
 * `extractFromContainerAppEnv` used to take `onlyNames` as a HARD FILTER and
 * `continue` past every entry whose NAME was absent — without counting it. The
 * console supplied a 20-row hand list; `unreachable-always-on` then judged all
 * 65 Container Apps in the pull. An app whose inbound wire rode a variable
 * outside that list could not gain an inbound edge under any circumstances, so
 * it was VACUOUSLY "unreachable and always-on".
 *
 * MEASURED instance: `loom-risingwave` is wired at
 * `platform/fiab/bicep/modules/admin-plane/main.bicep:4859` as
 *
 *     { name: 'LOOM_RISINGWAVE_URL',
 *       value: 'loom-risingwave.internal.${caeDefaultDomain}:4566' }
 *
 * — a bare host:port with no scheme — and `LOOM_RISINGWAVE_URL` appears in NO
 * table in this repository. The wire was discarded at extraction, before FQDN
 * resolution would have matched it, and the service became the estate's single
 * largest cost finding. The finding's own text ("zero inbound resolved
 * 'configured' edges across 65 Container App(s) examined") was a true statement
 * about the extractor's population and a FALSE statement about the estate.
 *
 * ── WHAT MAKES THESE SPECS DISCRIMINATING RATHER THAN AGREEABLE ────────────
 * Every "it now resolves" assertion is paired with a "and this still does not"
 * assertion over the same call:
 *
 *   • the risingwave-shaped wire RESOLVES (the fix), and
 *   • a flag / a number / a bare token / an endpoint outside the pull still
 *     produces NOTHING (the fix did not become "emit an edge for everything"),
 *   • the pre-existing empty-wire and binding-table behaviour is unchanged (no
 *     previously-resolved edge is lost).
 *
 * A widening that also admitted the second group would pass half of this file
 * and fail the other half, which is the point.
 */

import { describe, expect, it } from 'vitest';
import {
  azureResourceNodeId,
  buildGraph,
  extractFromContainerAppEnv,
  extractFromResourceGraph,
  namesADiscoveredTarget,
  namesSelf,
  nodesWithNoInboundEdge,
  type EstateTargetIndex,
  type NodeId,
  type ResourceGraphRow,
} from '../../graph';
import { unreachableService } from '../../detectors';
import { buildLiveGraph } from '@/app/api/admin/brain/_lib/live-graph';
import { BOUND_ENV_VAR_NAMES } from '@/app/api/admin/brain/_lib/wire-bindings';
import { appId, containerAppRow, managedEnvRow, SUB_A } from '../ui/estate-fixture';

const CONSOLE_ARM = appId(SUB_A, 'loom-console');
const RISINGWAVE_ARM = appId(SUB_A, 'loom-risingwave');
const RISINGWAVE_ID = azureResourceNodeId(RISINGWAVE_ARM);
const DIRECTLAKE_ARM = appId(SUB_A, 'loom-directlake');
const DIRECTLAKE_ID = azureResourceNodeId(DIRECTLAKE_ARM);

/** The real bicep shape: bare host, `.internal.` form, explicit TCP port, no scheme. */
const RISINGWAVE_FQDN = 'loom-risingwave.internal.example.azurecontainerapps.io';
const RISINGWAVE_WIRE = `${RISINGWAVE_FQDN}:4566`;

/**
 * `LOOM_RISINGWAVE_URL` is genuinely absent from the binding table. If a future
 * change adds it, the fixtures below stop testing the defect (they would pass by
 * the NAME path) — so the absence is asserted rather than assumed.
 */
describe('the premise: the wire-binding table does not cover this variable', () => {
  it('LOOM_RISINGWAVE_URL is NOT in BOUND_ENV_VAR_NAMES', () => {
    expect(BOUND_ENV_VAR_NAMES).not.toContain('LOOM_RISINGWAVE_URL');
  });

  it('and the table is small relative to the fleet it is asked to cover', () => {
    // The measured shape of the defect: a 20-row list standing in for the wires
    // of 35 declared Loom container apps.
    expect(BOUND_ENV_VAR_NAMES.length).toBeLessThan(35);
  });
});

// ---------------------------------------------------------------------------
// Extractor level
// ---------------------------------------------------------------------------

function targets(fqdns: string[], resourceIds: string[] = []): EstateTargetIndex {
  return {
    fqdns: new Set(fqdns.map((f) => f.toLowerCase())),
    resourceIds: new Set(resourceIds.map((r) => azureResourceNodeId(r) as string)),
  };
}

/**
 * The binding-table name set, supplied under BOTH spellings.
 *
 * NOT redundancy — it is what makes these specs FAIL on the parent commit. The
 * parent reads only `onlyNames`; a fixture that supplied the new
 * `alwaysConsiderNames` alone left `only === null` there, so the parent admitted
 * every entry and the defect specs went GREEN on the broken code. A spec that
 * passes against the code it was written to indict proves nothing. Both
 * spellings are unioned by the fix, so the post-fix behaviour is identical and
 * the pre-fix filter is faithfully reproduced.
 */
const NAME_LIST = {
  alwaysConsiderNames: BOUND_ENV_VAR_NAMES,
  onlyNames: BOUND_ENV_VAR_NAMES,
} as const;

describe('a wire is found by its VALUE, not by its variable name', () => {
  it('THE DEFECT: a wire on a variable outside the name list now produces an edge', () => {
    const r = extractFromContainerAppEnv([
      {
        appResourceId: CONSOLE_ARM,
        ...NAME_LIST,
        estateTargets: targets([RISINGWAVE_FQDN]),
        env: [{ name: 'LOOM_RISINGWAVE_URL', value: RISINGWAVE_WIRE }],
      },
    ]);
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]!.provenance).toBe('configured');
    expect(r.edges[0]!.targetRef).toBe(RISINGWAVE_WIRE);
    expect(r.edges[0]!.evidence.symbol).toBe('LOOM_RISINGWAVE_URL');
  });

  it('and it RESOLVES to the service, which is therefore not unreachable', () => {
    const rows = [
      containerAppRow({ name: 'loom-console', external: true, env: [{ name: 'LOOM_RISINGWAVE_URL', value: RISINGWAVE_WIRE }] }),
      containerAppRow({ name: 'loom-risingwave', minReplicas: 1, fqdn: RISINGWAVE_FQDN }),
    ];
    const resources = extractFromResourceGraph(rows);
    const env = extractFromContainerAppEnv([
      {
        appResourceId: CONSOLE_ARM,
        ...NAME_LIST,
        estateTargets: targets([RISINGWAVE_FQDN]),
        env: [{ name: 'LOOM_RISINGWAVE_URL', value: RISINGWAVE_WIRE }],
      },
    ]);
    const g = buildGraph([resources, env]);

    expect(g.inboundEdges(RISINGWAVE_ID, 'configured').result).toHaveLength(1);
    expect(nodesWithNoInboundEdge(g, 'configured').result.map((n) => n.id)).not.toContain(
      RISINGWAVE_ID,
    );
  });

  it('an ARM-id value is admitted too — and the test is CASE-INSENSITIVE', () => {
    // Written `startsWith('/subscriptions/')` this misses `/SUBSCRIPTIONS/…`,
    // the value falls through to the host test, matches nothing, and the target
    // silently loses an inbound edge. Same bug node-id.test.ts caught in the
    // resolver; it must not be reintroduced on the admission side.
    const upper = RISINGWAVE_ARM.replace('/subscriptions/', '/SUBSCRIPTIONS/');
    const r = extractFromContainerAppEnv([
      {
        appResourceId: CONSOLE_ARM,
        ...NAME_LIST,
        estateTargets: targets([], [RISINGWAVE_ARM]),
        env: [{ name: 'SOME_TARGET_ID', value: upper }],
      },
    ]);
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]!.targetRef).toBe(upper);
  });

  it('scheme, port, path, case and a trailing dot all still RESOLVE end-to-end', () => {
    // The admission side normalizes the host itself. If its rules ever disagree
    // with the resolver's, an admitted value is emitted and then DANGLES — this
    // asserts the resolved outcome, which is what fails when either side drifts.
    const forms = [
      RISINGWAVE_FQDN,
      `https://${RISINGWAVE_FQDN}`,
      `https://${RISINGWAVE_FQDN}:4566`,
      `https://${RISINGWAVE_FQDN}/health?x=1#f`,
      `HTTPS://${RISINGWAVE_FQDN.toUpperCase()}`,
      `${RISINGWAVE_FQDN}.`,
    ];
    const resources = extractFromResourceGraph([
      containerAppRow({ name: 'loom-console', external: true }),
      containerAppRow({ name: 'loom-risingwave', minReplicas: 1, fqdn: RISINGWAVE_FQDN }),
    ]);
    for (const value of forms) {
      const env = extractFromContainerAppEnv([
        {
          appResourceId: CONSOLE_ARM,
          ...NAME_LIST,
          estateTargets: targets([RISINGWAVE_FQDN]),
          env: [{ name: 'UNLISTED_VAR', value }],
        },
      ]);
      expect(env.edges, `admission for ${value}`).toHaveLength(1);
      const g = buildGraph([resources, env]);
      expect(g.inboundEdges(RISINGWAVE_ID, 'configured').result, `resolution for ${value}`).toHaveLength(1);
    }
  });
});

describe('the widening is BOUNDED — these still produce nothing', () => {
  const only = {
    appResourceId: CONSOLE_ARM,
    ...NAME_LIST,
    estateTargets: targets([RISINGWAVE_FQDN], [RISINGWAVE_ARM]),
  } as const;

  it('a flag, a number and free text on unlisted variables are not wires', () => {
    const r = extractFromContainerAppEnv([
      {
        ...only,
        env: [
          { name: 'LOOM_ENABLE_SOMETHING', value: 'false' },
          { name: 'LOOM_TIMEOUT_MS', value: '3000' },
          { name: 'LOOM_LOG_LEVEL', value: 'info' },
          { name: 'AZURE_CLIENT_ID', value: '00000000-0000-4000-8000-00000000000a' },
        ],
      },
    ]);
    expect(r.edges).toHaveLength(0);
  });

  it('a BARE TOKEN is never admitted by value, even when a resource carries that name', () => {
    // `resolveTarget` can resolve an unambiguous bare name, but admitting one
    // HERE would let `LOG_LEVEL=info` mint an edge the day something is named
    // `info`. The value must name an FQDN or an ARM id the pull discovered.
    const r = extractFromContainerAppEnv([
      { ...only, env: [{ name: 'UNLISTED_VAR', value: 'loom-risingwave' }] },
    ]);
    expect(r.edges).toHaveLength(0);
  });

  it('an endpoint OUTSIDE the pull produces no edge — no fabricated dangling noise', () => {
    const r = extractFromContainerAppEnv([
      {
        ...only,
        env: [
          { name: 'LOOM_AOAI_ENDPOINT', value: 'https://contoso.openai.azure.com/' },
          { name: 'LOOM_COSMOS_ENDPOINT', value: 'https://contoso.documents.azure.com:443/' },
        ],
      },
    ]);
    expect(r.edges).toHaveLength(0);
  });

  it('an EMPTY value on an unlisted variable is NOT turned into a dangling edge', () => {
    // `''` names nothing, so there is no evidence of intent to attach. Emitting
    // one per unlisted empty var would bury the binding-table ones that DO carry
    // an intended target.
    const r = extractFromContainerAppEnv([
      { ...only, env: [{ name: 'UNLISTED_EMPTY', value: '' }] },
    ]);
    expect(r.edges).toHaveLength(0);
  });

  it('a secretRef on an unlisted variable is still INDETERMINATE, never an empty wire', () => {
    const r = extractFromContainerAppEnv([
      { ...only, env: [{ name: 'UNLISTED_SECRET', secretRef: 's' }] },
    ]);
    expect(r.edges).toHaveLength(0);
  });

  it('namesADiscoveredTarget answers NOTHING when no index is supplied', () => {
    expect(namesADiscoveredTarget(RISINGWAVE_WIRE, undefined)).toBeNull();
    expect(namesADiscoveredTarget(RISINGWAVE_WIRE, targets([RISINGWAVE_FQDN]))).toBe('fqdn');
    expect(namesADiscoveredTarget(RISINGWAVE_ARM, targets([], [RISINGWAVE_ARM]))).toBe('arm-id');
    expect(namesADiscoveredTarget('', targets([RISINGWAVE_FQDN]))).toBeNull();
  });
});

describe('nothing the name path used to produce is lost', () => {
  const bindings: Record<string, NodeId> = { LOOM_BROKER_URL: DIRECTLAKE_ID };

  it('an EMPTY binding-table wire is still a dangling edge carrying its intended target', () => {
    const r = extractFromContainerAppEnv([
      {
        appResourceId: CONSOLE_ARM,
        ...NAME_LIST,
        estateTargets: targets([RISINGWAVE_FQDN]),
        envVarBindings: bindings,
        env: [{ name: 'LOOM_BROKER_URL', value: '' }],
      },
    ]);
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]!.emptyValue).toBe(true);
    expect(r.edges[0]!.intendedTo).toBe(DIRECTLAKE_ID);
  });

  it('a WIRED binding-table variable still resolves to its app', () => {
    const wired = `https://${'loom-directlake.internal.example.azurecontainerapps.io'}`;
    const resources = extractFromResourceGraph([
      containerAppRow({ name: 'loom-console', external: true }),
      containerAppRow({ name: 'loom-directlake', minReplicas: 1 }),
    ]);
    const env = extractFromContainerAppEnv([
      {
        appResourceId: CONSOLE_ARM,
        ...NAME_LIST,
        estateTargets: targets(['loom-directlake.internal.example.azurecontainerapps.io']),
        env: [{ name: 'LOOM_DIRECTLAKE_URL', value: wired }],
      },
    ]);
    const g = buildGraph([resources, env]);
    expect(g.inboundEdges(DIRECTLAKE_ID, 'configured').result).toHaveLength(1);
  });

  it('the legacy `onlyNames` spelling is still honoured, unioned with the new one', () => {
    // `lib/brain/run/azure/arg-graph-source.ts` supplies it and is owned by
    // another lane; removing the field would break that build.
    const r = extractFromContainerAppEnv([
      {
        appResourceId: CONSOLE_ARM,
        onlyNames: ['LOOM_BROKER_URL'],
        env: [
          { name: 'LOOM_BROKER_URL', value: '' },
          { name: 'UNRELATED', value: 'x' },
        ],
      },
    ]);
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]!.emptyValue).toBe(true);
  });

  it('an EXPLICIT `onlyNames: []` considers NOTHING by name — the field is keyed on SUPPLIED, not on non-empty', () => {
    // SEMANTICS, decided deliberately: `[]` means "consider nothing by name",
    // NOT "consider everything". Keying admission on `nameList.length > 0` would
    // invert it — `[]` collapses to `null`, `byName` becomes true for every
    // entry, and each URL-shaped value with no `estateTargets` emits a DANGLING
    // `unresolved-target` edge. Those inflate `byProvenance.configured` (which
    // is dangling-inclusive), the exact counter the vacuity guard in
    // `lib/brain-actions/guards.ts` reads. `arg-graph-source.ts` derives its
    // list from a caller-supplied array where empty is type-legal, so an
    // inverted `[]` is reachable from a type-correct caller, not theoretical.
    const explicitlyEmpty = extractFromContainerAppEnv([
      {
        appResourceId: CONSOLE_ARM,
        onlyNames: [],
        env: [{ name: 'SOME_URL', value: 'https://not-in-this-pull.example.com' }],
      },
    ]);
    expect(explicitlyEmpty.edges).toHaveLength(0);

    // ...and this DISCRIMINATES: omitting the field entirely is a different
    // input, and still admits by default. If both cases returned 0 the
    // assertion above would be passing on an unrelated property.
    const omitted = extractFromContainerAppEnv([
      {
        appResourceId: CONSOLE_ARM,
        env: [{ name: 'SOME_URL', value: 'https://not-in-this-pull.example.com' }],
      },
    ]);
    expect(omitted.edges).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The population must SAY what it could not reach
// ---------------------------------------------------------------------------

describe('the extractor reports its own recall bound', () => {
  it('the population counts what it SAW, not only what it admitted', () => {
    const r = extractFromContainerAppEnv([
      {
        appResourceId: CONSOLE_ARM,
        alwaysConsiderNames: ['LOOM_BROKER_URL'],
        estateTargets: targets([RISINGWAVE_FQDN]),
        env: [
          { name: 'LOOM_BROKER_URL', value: '' },
          { name: 'LOOM_RISINGWAVE_URL', value: RISINGWAVE_WIRE },
          { name: 'LOOM_AOAI_ENDPOINT', value: 'https://contoso.openai.azure.com/' },
          { name: 'LOOM_LOG_LEVEL', value: 'info' },
        ],
      },
    ]);
    expect(r.population.scope).toMatch(/4 env entr\(ies\) SEEN/);
    expect(r.population.scope).toMatch(/2 considered \(1 by name, 1 by VALUE/);
    expect(r.population.scope).toMatch(/2 declined — value named nothing discovered/);
  });

  it('declined entries produce a NAMED skip record, never a silent `continue`', () => {
    const r = extractFromContainerAppEnv([
      {
        appResourceId: CONSOLE_ARM,
        alwaysConsiderNames: ['LOOM_BROKER_URL'],
        estateTargets: targets([RISINGWAVE_FQDN]),
        env: [{ name: 'LOOM_AOAI_ENDPOINT', value: 'https://contoso.openai.azure.com/' }],
      },
    ]);
    const bound = r.skipped.find((s) => s.reason.includes('names NOTHING this pull discovered'));
    expect(bound).toBeDefined();
    expect(bound!.reason).toMatch(/bounded by what this pull discovered/);
  });

  it('a name list with NO estateTargets is reported as the #4258 blind configuration', () => {
    const r = extractFromContainerAppEnv([
      {
        appResourceId: CONSOLE_ARM,
        onlyNames: ['LOOM_BROKER_URL'],
        env: [
          { name: 'LOOM_BROKER_URL', value: '' },
          { name: 'LOOM_RISINGWAVE_URL', value: RISINGWAVE_WIRE },
        ],
      },
    ]);
    const blind = r.skipped.find((s) => s.subject.includes('no estateTargets supplied'));
    expect(blind).toBeDefined();
    expect(blind!.reason).toMatch(/HARD FILTER/);
    expect(blind!.reason).toMatch(/vacuously "unreachable"/);
  });

  it('and that record is ABSENT when the index IS supplied — it discriminates', () => {
    const r = extractFromContainerAppEnv([
      {
        appResourceId: CONSOLE_ARM,
        alwaysConsiderNames: ['LOOM_BROKER_URL'],
        estateTargets: targets([RISINGWAVE_FQDN]),
        env: [{ name: 'LOOM_BROKER_URL', value: '' }],
      },
    ]);
    expect(r.skipped.find((s) => s.subject.includes('no estateTargets supplied'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildLiveGraph — the whole path the console actually runs
// ---------------------------------------------------------------------------

function risingwaveEstate(opts?: { readonly fqdn?: string | null }): ResourceGraphRow[] {
  return [
    managedEnvRow(SUB_A, 'loom-cae'),
    containerAppRow({
      name: 'loom-console',
      minReplicas: 2,
      external: true,
      env: [
        // The real bicep line, verbatim in shape.
        { name: 'LOOM_RISINGWAVE_URL', value: RISINGWAVE_WIRE },
        // The CONTROL: a binding-table variable, wired. Must keep resolving.
        {
          name: 'LOOM_DIRECTLAKE_URL',
          value: 'https://loom-directlake.internal.example.azurecontainerapps.io',
        },
        // Noise that must remain noise.
        { name: 'LOOM_ENABLE_SOMETHING', value: 'false' },
        { name: 'LOOM_LOG_LEVEL', value: 'info' },
      ],
    }),
    containerAppRow({
      name: 'loom-risingwave',
      minReplicas: 1,
      external: false,
      ...(opts?.fqdn === undefined ? {} : { fqdn: opts.fqdn }),
    }),
    containerAppRow({ name: 'loom-directlake', minReplicas: 1, external: false }),
  ];
}

describe('buildLiveGraph — loom-risingwave is no longer a false positive', () => {
  const live = buildLiveGraph(risingwaveEstate());

  it('gains an inbound RESOLVED configured edge from the console', () => {
    expect(live.graph.inboundEdges(RISINGWAVE_ID, 'configured').result).toHaveLength(1);
  });

  it('is ABSENT from the unreachable set the cost detector ranges over', () => {
    const q = nodesWithNoInboundEdge(live.graph, 'configured', {
      resourceType: 'Microsoft.App/containerApps',
      describe: 'Container Apps',
    });
    expect(q.result.map((n) => n.id)).not.toContain(RISINGWAVE_ID);
    // The query is not vacuous: it still finds the app nothing wires.
    expect(q.population.examined).toBeGreaterThan(1);
  });

  it('the CONTROL still resolves — the change did not simply make everything reachable', () => {
    expect(live.graph.inboundEdges(DIRECTLAKE_ID, 'configured').result).toHaveLength(1);
  });

  it('the console itself, which nothing wires, is STILL unreachable-by-configured', () => {
    // Without this, "risingwave is reachable" would be satisfied by a change
    // that made every node reachable.
    const consoleId = azureResourceNodeId(CONSOLE_ARM);
    expect(live.graph.inboundEdges(consoleId, 'configured').result).toHaveLength(0);
  });

  it('the value-matched wire is COUNTED, so the recall gain is visible', () => {
    expect(live.env.entriesMatchedByValue).toBeGreaterThan(0);
  });

  it('coverage states how a wire is found — by VALUE, not by a list of names', () => {
    expect(live.coverage.configured.collected).toBe(true);
    expect(live.coverage.configured.note).toMatch(/found by its VALUE/);
    expect(live.coverage.configured.note).toMatch(/derived from the measured estate/);
  });
});

describe('buildLiveGraph reports the population shortfall rather than implying coverage', () => {
  it('every app nameable: coverage says so, and appsAddressable equals appsJudged', () => {
    const live = buildLiveGraph(risingwaveEstate());
    expect(live.env.appsJudged).toBe(3);
    expect(live.env.appsAddressable).toBe(3);
    expect(live.coverage.configured.note).toMatch(/RECALL: all 3 Container App\(s\)/);
  });

  it('an app with NO readable ingress FQDN is declared UNNAMEABLE, not silently judged', () => {
    // This is the honest half of the fix: the widening removes one bound, and
    // where a bound REMAINS it is stated. An app with no ingress FQDN cannot be
    // named by any URL-valued env var, so "zero inbound edges" for it is a fact
    // about the graph's reach.
    const live = buildLiveGraph(risingwaveEstate({ fqdn: null }));
    expect(live.env.appsJudged).toBe(3);
    expect(live.env.appsAddressable).toBe(2);
    expect(live.coverage.configured.note).toMatch(/RECALL BOUND: of 3 Container App\(s\)/);
    expect(live.coverage.configured.note).toMatch(
      /cannot be named by ANY env URL value/,
    );
  });

  it('the shortfall statement is ABSENT when there is no shortfall — it discriminates', () => {
    const live = buildLiveGraph(risingwaveEstate());
    expect(live.coverage.configured.note).not.toMatch(/RECALL BOUND/);
  });
});

// ---------------------------------------------------------------------------
// The inverse lie: an edge that is not real
// ---------------------------------------------------------------------------

/**
 * #4258 was a FALSE POSITIVE from an edge the extractor could not see. Widening
 * admission by VALUE opens the mirror-image failure: an always-on internal app
 * carrying its OWN ingress FQDN in an env var — `RW_ADVERTISE_ADDR`,
 * `KAFKA_ADVERTISED_LISTENERS`, `TRINO_DISCOVERY_URI`, `<X>_NODE_URL`, standard
 * for the distributed-systems images this estate runs — now names something the
 * pull discovered, is admitted, and resolves to ITSELF. `unreachable-service`
 * asks only `inbound(graph, id, 'configured').length === 0`, so that one
 * `from === to` edge would CLEAR the app on the strength of the app pointing at
 * itself: a FALSE NEGATIVE from an edge that is not real.
 *
 * The fixture deliberately OMITS `selfFqdn`, which disables the extractor's own
 * self-reference decline. What is under test here is the graph-level guard —
 * `BrainGraph` refuses to index a resolved `from === to` edge into `inbound` —
 * which keys on the SHAPE rather than on one extractor's spelling, so every
 * other extractor and every caller that omits `selfFqdn` inherits it.
 */
describe('a node pointing at ITSELF is not inbound reachability', () => {
  const SELF_VAR = 'RW_ADVERTISE_ADDR';
  const DIRECTLAKE_FQDN = 'loom-directlake.internal.example.azurecontainerapps.io';

  function selfAdvertisingGraph() {
    const resources = extractFromResourceGraph([
      managedEnvRow(SUB_A, 'loom-cae'),
      containerAppRow({ name: 'loom-console', minReplicas: 2, external: true }),
      containerAppRow({ name: 'loom-risingwave', minReplicas: 1, fqdn: RISINGWAVE_FQDN }),
      containerAppRow({ name: 'loom-directlake', minReplicas: 1 }),
    ]);
    const env = extractFromContainerAppEnv([
      {
        // THE SUBJECT: always-on, internal, wired by nothing, and advertising
        // its own address. `selfFqdn` is omitted on purpose (see above).
        appResourceId: RISINGWAVE_ARM,
        alwaysConsiderNames: ['A_NAME_THAT_IS_NOT_PRESENT'],
        estateTargets: targets([RISINGWAVE_FQDN, DIRECTLAKE_FQDN]),
        env: [{ name: SELF_VAR, value: RISINGWAVE_WIRE }],
      },
      {
        // A REAL wire, so the graph holds at least one resolved `configured`
        // edge. Without it the detector is VACUOUS and reports nothing at all —
        // the assertions below would then pass for the wrong reason.
        appResourceId: CONSOLE_ARM,
        estateTargets: targets([DIRECTLAKE_FQDN]),
        env: [{ name: 'LOOM_DIRECTLAKE_URL', value: `https://${DIRECTLAKE_FQDN}` }],
      },
    ]);
    return { env, graph: buildGraph([resources, env]) };
  }

  it('the extractor DID mint the self-edge — the graph is what refuses it', () => {
    const { env } = selfAdvertisingGraph();
    // The premise. If this ever goes false the spec below stops testing the
    // graph guard and starts passing because no edge existed to reject.
    expect(env.edges.some((e) => e.from === RISINGWAVE_ID && e.targetRef === RISINGWAVE_WIRE)).toBe(true);
  });

  it('a self-advertised address does NOT clear the unreachable-always-on detector', () => {
    const { graph } = selfAdvertisingGraph();

    // It resolved to itself...
    expect(graph.edges.some((e) => e.resolution === 'resolved' && e.from === RISINGWAVE_ID && e.to === RISINGWAVE_ID)).toBe(true);
    // ...and the reachability index still shows ZERO inbound configured edges.
    expect(graph.inboundEdges(RISINGWAVE_ID, 'configured').result).toHaveLength(0);

    const findings = unreachableService(graph).findings;
    expect(findings.some((f) => f.subjects.includes(RISINGWAVE_ID))).toBe(true);

    // DISCRIMINATING: the app the console genuinely wires is still cleared, so
    // the guard suppressed a self-edge rather than suppressing edges generally.
    expect(findings.some((f) => f.subjects.includes(DIRECTLAKE_ID))).toBe(false);
  });

  it('the refusal is REPORTED, not silent', () => {
    const { graph } = selfAdvertisingGraph();
    expect(
      graph.report.skipped.some((s) => /source and target are the SAME node/.test(s.subject)),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ...and the extractor declines it at the SOURCE, so the accounting is local
// ---------------------------------------------------------------------------

/**
 * The graph-level guard above keys on the SHAPE (`from === to`) and therefore
 * covers every extractor. This block covers the FIRST layer: `container-app-env`
 * declines a value naming the app it was read FROM, counts it in a
 * `selfReference` tally, and emits a named skip record — so the decline is
 * stated where the evidence is, not inferred two layers later from a graph
 * report. Deleting that block must redden these specs.
 *
 * The scheme/port/case variants are here because `hostOf` normalization is what
 * makes the check work at all: the real wires are bare `host:port`
 * (`RW_ADVERTISE_ADDR`), scheme+path (`TRINO_DISCOVERY_URI`), and comma-free
 * `host:port` lists (`KAFKA_ADVERTISED_LISTENERS`). A self-check that only
 * matched an exact string would pass a spec written with one spelling and let
 * every other spelling through.
 */
describe('the extractor declines a SELF-advertised address at the source', () => {
  const SELF_TARGETS = targets([RISINGWAVE_FQDN], [RISINGWAVE_ARM]);

  const SPELLINGS: readonly (readonly [string, string])[] = [
    ['bare host:port — the RW_ADVERTISE_ADDR shape', RISINGWAVE_WIRE],
    ['scheme + host', `https://${RISINGWAVE_FQDN}`],
    ['scheme + host + port + path — the TRINO_DISCOVERY_URI shape', `http://${RISINGWAVE_FQDN}:8080/v1/info`],
    ['UPPERCASE with a trailing dot', `HTTPS://${RISINGWAVE_FQDN.toUpperCase()}./`],
  ];

  for (const [label, value] of SPELLINGS) {
    it(`declines it, and COUNTS the decline: ${label}`, () => {
      const r = extractFromContainerAppEnv([
        {
          appResourceId: RISINGWAVE_ARM,
          estateTargets: SELF_TARGETS,
          selfFqdn: RISINGWAVE_FQDN,
          env: [{ name: 'RW_ADVERTISE_ADDR', value }],
        },
      ]);
      expect(r.edges).toHaveLength(0);
      expect(r.population.scope).toMatch(/1 declined — value named the app it was read FROM/);
      expect(r.skipped.some((s) => /read FROM/.test(s.subject))).toBe(true);
    });
  }

  it('the ARM-id spelling is declined even when `selfFqdn` is NOT supplied', () => {
    // That branch compares against `from`, so it needs no extra input. This is
    // the half of the guard a caller cannot accidentally disable.
    const r = extractFromContainerAppEnv([
      {
        appResourceId: RISINGWAVE_ARM,
        estateTargets: SELF_TARGETS,
        env: [{ name: 'SELF_RESOURCE_ID', value: RISINGWAVE_ARM }],
      },
    ]);
    expect(r.edges).toHaveLength(0);
    expect(r.population.scope).toMatch(/1 declined — value named the app it was read FROM/);
  });

  it('DISCRIMINATES: the SAME value read from a DIFFERENT app is still a wire', () => {
    // Otherwise the assertions above would pass on a guard that simply refused
    // every value in the index.
    const r = extractFromContainerAppEnv([
      {
        appResourceId: CONSOLE_ARM,
        estateTargets: SELF_TARGETS,
        selfFqdn: 'loom-console.example.azurecontainerapps.io',
        env: [{ name: 'RW_ADVERTISE_ADDR', value: RISINGWAVE_WIRE }],
      },
    ]);
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]!.targetRef).toBe(RISINGWAVE_WIRE);
    expect(r.population.scope).not.toMatch(/1 declined — value named the app it was read FROM/);
  });

  it('namesSelf normalizes scheme, port, path, case and a trailing dot', () => {
    const id = RISINGWAVE_ID;
    expect(namesSelf(RISINGWAVE_WIRE, id, RISINGWAVE_FQDN)).toBe(true);
    expect(namesSelf(`https://${RISINGWAVE_FQDN.toUpperCase()}./x?q=1`, id, RISINGWAVE_FQDN)).toBe(true);
    expect(namesSelf(RISINGWAVE_ARM, id, undefined)).toBe(true);
    // ...and it is not a prefix match, nor true for an unrelated host.
    expect(namesSelf(`https://not-${RISINGWAVE_FQDN}`, id, RISINGWAVE_FQDN)).toBe(false);
    expect(namesSelf('', id, RISINGWAVE_FQDN)).toBe(false);
  });

  it('buildLiveGraph supplies each app its own FQDN, so the guard fires on the LIVE path', () => {
    const live = buildLiveGraph([
      managedEnvRow(SUB_A, 'loom-cae'),
      containerAppRow({ name: 'loom-console', minReplicas: 2, external: true }),
      containerAppRow({
        name: 'loom-risingwave',
        minReplicas: 1,
        fqdn: RISINGWAVE_FQDN,
        env: [{ name: 'RW_ADVERTISE_ADDR', value: RISINGWAVE_WIRE }],
      }),
    ]);
    // Without `selfFqdn` reaching the extractor this decline cannot happen —
    // `namesSelf`'s host branch returns false with no self address in hand.
    expect(live.graph.report.skipped.some((s) => /read FROM/.test(s.subject))).toBe(true);
    expect(live.graph.inboundEdges(RISINGWAVE_ID, 'configured').result).toHaveLength(0);
    // And the PUBLISHED count agrees with the edges (R7). The value passes
    // `namesADiscoveredTarget`, so a count that ignored self-reference would
    // report 1 admission on an estate that admitted none.
    expect(live.env.entriesMatchedByValue).toBe(0);
  });
});
