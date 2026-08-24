/**
 * LOOM BRAIN W10 — the LIVE graph source for the scheduled run (#3936).
 *
 * Pulls the container tier from Azure Resource Graph and assembles the same
 * graph the detectors are proven against, using the SAME extractors the console
 * uses (`lib/brain/graph`). It does NOT re-implement the extraction: one graph
 * model, one set of extractors, one truth.
 *
 * ── WHAT THIS RUNTIME CAN AND CANNOT COLLECT ───────────────────────────────
 * The scheduled run executes from a checkout, not from the console image, so its
 * coverage is not identical to the console's. It is stated as DATA
 * ({@link GraphSourceResult.collectedProvenances}) rather than inferred from an
 * edge count, because a count of zero cannot distinguish "the extractor ran and
 * found none" from "the extractor is not present in this build":
 *
 *     configured   COLLECTED   live container env, from this ARG pull
 *     owns         COLLECTED   the `loom-estate-id` tag, from this ARG pull
 *     declared     NOT COLLECTED   the bicep extractor is not wired here yet
 *     imports      NOT COLLECTED   no source extractor is wired here yet
 *     observed     NOT COLLECTED   no telemetry extractor exists (PRP §3.1)
 *
 * That distinction is not cosmetic. `nodesWithNoInboundEdge(g, 'declared')` over
 * a graph with zero `declared` edges returns EVERY NODE — the node set was not
 * empty, so `population.blind` is FALSE, and the result is a screen of confident
 * findings every one of which is vacuously true. W9's diff also intersects on
 * this list, so getting it wrong makes the next capture report an entire
 * provenance as added or removed.
 *
 * ── THE BINDING TABLE IS SUPPLIED, NOT RE-DECLARED ─────────────────────────
 * An empty env value destroys the evidence of its own intent
 * (`{ name: 'LOOM_BROKER_URL', value: '' }` names nothing), so the intent lives
 * in a table. That table is `app/api/admin/brain/_lib/wire-bindings.ts` and it is
 * PASSED IN rather than copied here — a second copy would drift, and the two
 * copies would disagree about which service a dead wire was meant to reach,
 * which is the entire evidence chain of the founding finding.
 */

import {
  azureResourceNodeId,
  buildGraph,
  extractFromContainerAppEnv,
  extractFromResourceGraph,
  type ContainerAppEnvEntry,
  type ContainerAppEnvInput,
  type EdgeProvenance,
  type NodeId,
  type ResourceGraphRow,
} from '../../graph';
import type { GraphSource, GraphSourceResult } from '../ports';
import type { ProbeFailure } from '../model';
import type { FetchLike } from './arm-probe';

const RESOURCE_GRAPH_API = '2022-10-01';
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
const CONTAINER_APP_TYPE = 'microsoft.app/containerapps';

/**
 * The full graph query. Projects `properties` wholesale on purpose: one pull
 * feeds BOTH extractors, so the resource facts (scale, ingress, tags) and the
 * live `configured` wires come from the same read at the same instant. Two pulls
 * could observe an app mid-revision and produce a graph whose scale and env
 * disagree — a contradiction with no signal.
 */
export const GRAPH_QUERY = [
  'Resources',
  "| where type =~ 'Microsoft.App/containerApps'",
  "   or type =~ 'Microsoft.App/jobs'",
  "   or type =~ 'Microsoft.App/managedEnvironments'",
  '| project id, name, type, resourceGroup, subscriptionId, location, tags, properties',
  '| order by id asc',
].join('\n');

/** A row in the binding table. Structurally identical to `_lib/wire-bindings`. */
export interface WireBindingRow {
  readonly envVar: string;
  readonly targetAppName: string;
}

/** A collection failure that knows WHAT it established. Never "no resources". */
export class GraphCollectionError extends Error {
  readonly failure: ProbeFailure;
  constructor(failure: ProbeFailure) {
    super(
      `the Brain scan could not assemble a graph: [${failure.stage}] ${failure.target} ` +
        `(${failure.classification}, ` +
        `${failure.httpStatus === null ? 'no HTTP response' : `HTTP ${failure.httpStatus}`}). ` +
        `${failure.detail} NO version was written and NO finding state was changed.`,
    );
    this.name = 'GraphCollectionError';
    this.failure = failure;
  }
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Every container's env list off an ARG `properties` blob.
 *
 * ALL containers, not `containers[0]`: a wire declared on a sidecar is still a
 * wire, and reading only the first would silently miss it. `''` is preserved
 * deliberately — an empty wire is a REAL state and coercing it away would turn
 * the founding finding's evidence into "entry carries no value field".
 */
export function readEnvEntries(properties: unknown): ContainerAppEnvEntry[] {
  const template = obj(obj(properties)?.template);
  const containers = Array.isArray(template?.containers) ? template.containers : [];
  const out: ContainerAppEnvEntry[] = [];
  for (const c of containers) {
    const env = obj(c)?.env;
    if (!Array.isArray(env)) continue;
    for (const e of env) {
      const entry = obj(e);
      const name = entry?.name;
      if (typeof name !== 'string' || name === '') continue;
      const value = entry?.value;
      const secretRef = entry?.secretRef;
      out.push({
        name,
        ...(typeof value === 'string' ? { value } : {}),
        ...(typeof secretRef === 'string' ? { secretRef } : {}),
      });
    }
  }
  return out;
}

export interface ArgGraphSourceOptions {
  readonly armBase: string;
  readonly armScope: string;
  readonly getToken: (scope: string) => Promise<string | null>;
  readonly fetchImpl: FetchLike;
  /** Scopes `owns` edges to one estate. Without it, ANY estate tag counts as owned. */
  readonly estateId: string;
  /** From `app/api/admin/brain/_lib/wire-bindings.ts`. Never re-declared here. */
  readonly bindings: readonly WireBindingRow[];
  readonly subscriptions?: readonly string[];
}

/** Build the live graph from a Resource Graph pull. */
export class ArgGraphSource implements GraphSource {
  constructor(private readonly opts: ArgGraphSourceOptions) {}

  async build(): Promise<GraphSourceResult> {
    const rows = await this.pull();

    const resourceExtraction = extractFromResourceGraph(rows, { estateId: this.opts.estateId });

    // Resolve the binding table against what was actually discovered. The table
    // names container apps; a NodeId is an ARM id. The join happens on MEASURED
    // data, so a binding row naming a service that is not deployed resolves to
    // NOTHING rather than to a fabricated node.
    const appIdByName = new Map<string, string>();
    for (const row of rows) {
      if ((row.type ?? row.resourceType ?? '').toLowerCase() !== CONTAINER_APP_TYPE) continue;
      const armId = row.id ?? row.resourceId ?? '';
      const name = row.name ?? armId.split('/').filter(Boolean).pop() ?? '';
      if (armId && name) appIdByName.set(name.toLowerCase(), armId);
    }

    const envVarBindings: Record<string, NodeId> = {};
    const unresolved: string[] = [];
    for (const b of this.opts.bindings) {
      const armId = appIdByName.get(b.targetAppName.toLowerCase());
      if (armId) envVarBindings[b.envVar] = azureResourceNodeId(armId);
      else
        unresolved.push(
          `${b.envVar} -> '${b.targetAppName}': no Container App with that name in this pull. ` +
            'The wire cannot be attributed to a node; the row is either stale or the service ' +
            'is not deployed here.',
        );
    }

    const boundNames = this.opts.bindings.map((b) => b.envVar);
    const envInputs: ContainerAppEnvInput[] = [];
    for (const row of rows) {
      if ((row.type ?? row.resourceType ?? '').toLowerCase() !== CONTAINER_APP_TYPE) continue;
      const armId = row.id ?? row.resourceId ?? '';
      if (!armId) continue;
      const env = readEnvEntries(row.properties);
      if (env.length === 0) continue;
      envInputs.push({
        appResourceId: armId,
        env,
        envVarBindings,
        // Without this filter every `LOOM_ENABLE_X=false` becomes an
        // `unresolved-target` dangling edge and buries the wires that matter.
        onlyNames: boundNames,
      });
    }

    const graph = buildGraph([resourceExtraction, extractFromContainerAppEnv(envInputs)]);

    const collected: readonly EdgeProvenance[] = ['configured', 'owns'];
    const notes = [
      `Resource Graph pull: ${rows.length} row(s); ${envInputs.length} app(s) with env; ` +
        `${boundNames.length} bound env var name(s).`,
      'COLLECTED provenances: configured, owns. NOT COLLECTED: declared (no bicep extractor ' +
        'wired into this lane), imports (no source extractor wired), observed (no telemetry ' +
        'extractor exists — PRP §3.1). A query over an uncollected provenance is vacuously ' +
        'true of every node, so detectors depending on one emit nothing rather than a screen ' +
        'of confident findings.',
      ...unresolved.map((u) => `unresolved binding: ${u}`),
    ];

    return { graph, collectedProvenances: collected, notes };
  }

  private async pull(): Promise<readonly ResourceGraphRow[]> {
    const base = this.opts.armBase.replace(/\/+$/, '');
    const token = await this.opts.getToken(this.opts.armScope);
    if (token === null || token === '') {
      throw new GraphCollectionError({
        stage: 'discovery',
        target: 'token acquisition',
        classification: 'auth',
        httpStatus: null,
        detail: `no ARM token was issued for scope '${this.opts.armScope}'; NO query was issued.`,
      });
    }

    const rows: ResourceGraphRow[] = [];
    let skipToken: string | undefined;
    let pages = 0;
    let totalRecords: number | null = null;

    for (;;) {
      if (pages >= MAX_PAGES) {
        throw new GraphCollectionError({
          stage: 'discovery',
          target: 'Microsoft.ResourceGraph/resources',
          classification: 'arm-error',
          httpStatus: null,
          detail: `pagination hit the ${MAX_PAGES}-page cap with a token outstanding.`,
        });
      }

      const url = `${base}/providers/Microsoft.ResourceGraph/resources?api-version=${RESOURCE_GRAPH_API}`;
      const res = await this.opts.fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          query: GRAPH_QUERY,
          options: {
            resultFormat: 'objectArray',
            $top: PAGE_SIZE,
            ...(skipToken ? { $skipToken: skipToken } : {}),
          },
          ...(this.opts.subscriptions?.length ? { subscriptions: this.opts.subscriptions } : {}),
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new GraphCollectionError({
          stage: 'discovery',
          target: `Microsoft.ResourceGraph/resources (page ${pages + 1})`,
          classification: res.status === 401 || res.status === 403 ? 'auth' : 'arm-error',
          httpStatus: res.status,
          detail: body.slice(0, 600),
        });
      }

      const json = (await res.json()) as {
        data?: unknown;
        totalRecords?: unknown;
        $skipToken?: unknown;
      };
      const page = Array.isArray(json.data)
        ? json.data.filter((r): r is ResourceGraphRow => typeof r === 'object' && r !== null)
        : [];
      rows.push(...page);
      pages += 1;
      if (totalRecords === null && typeof json.totalRecords === 'number') {
        totalRecords = json.totalRecords;
      }
      const next = typeof json.$skipToken === 'string' ? json.$skipToken : '';
      if (!next || page.length === 0) break;
      skipToken = next;
    }

    if (totalRecords !== null && totalRecords !== rows.length) {
      throw new GraphCollectionError({
        stage: 'discovery',
        target: 'Microsoft.ResourceGraph/resources',
        classification: 'arm-error',
        httpStatus: null,
        detail:
          `totalRecords=${totalRecords} but ${rows.length} row(s) were read across ${pages} ` +
          'page(s). Refusing to build a graph over a partial estate: every node in the ' +
          'unread remainder would be found with zero inbound edges, which renders a ' +
          'page-boundary artifact as a fleet of unreachable services.',
      });
    }

    return rows;
  }
}
