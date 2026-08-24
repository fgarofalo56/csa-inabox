/**
 * LOOM BRAIN — extractor: Azure Resource Graph → resource nodes + `owns` edges.
 *
 * PURE and READ-ONLY. This module takes rows that a caller has ALREADY fetched
 * and turns them into graph elements. It holds no client, issues no request, and
 * has no code path that could write to Azure — which is how the program's
 * non-negotiable "recommend only, no mutation" rule is satisfied structurally
 * rather than by policy.
 *
 * ── OWNERSHIP IS A POSITIVE TEST, AND IT IS THE DANGEROUS PART ─────────────
 * PRP §1 decision 1, measured: of the 13 Container App environments visible
 * across these six subscriptions, exactly ONE is Loom's. The other 12 are the
 * operator's blog, Sentinel, two Atlas estates, simplechat, imgrotator, dabdemo,
 * assurancenet, forzelite and artemis. A wrong ownership inference here is how a
 * cleanup recommendation ends up pointed at someone else's production.
 *
 * So this extractor follows the rules `lib/estate/pause-inventory.ts` already
 * encodes for the same estate, for the same reason:
 *
 *   • Ownership comes from an explicit tag, `loom-estate-id`, whose VALUE names
 *     the estate. Nothing else confers it.
 *   • Resource-group NAME is never read. `/loom/i` over RG names is measurably
 *     wrong in BOTH directions on this estate: `rg-dlz-aiml-stack-dev` holds a
 *     genuine Loom component and contains no "loom", while any RG named for a
 *     customer called Loomis matches and would be swept in.
 *   • `tags === null` is INDETERMINATE (the tags could not be read), never "no
 *     tags". It produces a skip with a reason, not a not-owned verdict.
 *
 * REPORTS COVER ALL SUBSCRIPTIONS; ownership only scopes what may be
 * RECOMMENDED (PRP §1 decision 4). So a non-Loom resource still becomes a NODE —
 * the graph is estate-wide — it simply gets no `owns` edge.
 *
 * ── MEASURED 2026-08-23: NOTHING ON THIS ESTATE CARRIES THE TAG ────────────
 * A read-only Resource Graph pull across all six subscriptions returned 105
 * container-tier resources (63 container apps, 13 managed environments, 29
 * jobs). Of those, **ZERO carry `loom-estate-id`**, and 29 returned no tags at
 * all (indeterminate). The tags that DO appear are `CSA_Loom` (31),
 * `loom-next-level` (16), `csa-loom` (3), `loom-band` (1), `loom-item` (1).
 *
 * Two consequences a follow-on author must not trip over:
 *
 *   1. `owns` edge count is 0 TODAY. That is a true measurement, not a broken
 *      extractor. Any detector built on `owns` is therefore GREEN AND BLIND
 *      right now — it must read `population.byProvenance.owns` and say so
 *      rather than reporting a clean estate.
 *   2. DO NOT "fix" this by widening the key to `CSA_Loom` or matching
 *      `/loom/i` over tag keys. `loom-item` explicitly confers nothing (a Loom
 *      ITEM id does not name which ESTATE the item is in — see
 *      `lib/estate/pause-inventory.ts`, which measured a resource being claimed
 *      by two unrelated estates), and the others are not estate-scoped either.
 *      The fix is for the DEPLOY to stamp `loom-estate-id`, which is the same
 *      prerequisite the estate pause machinery already has.
 */

import type {
  AzureResourceNode,
  DeployArtifactNode,
  ExtractionResult,
  IngressFacts,
  PendingEdge,
  ScaleFacts,
  SkippedSubject,
} from '../../types';
import { azureResourceNodeId, deployArtifactNodeId } from '../node-id';
import { makePopulation } from '../graph';

/**
 * The estate ownership tag. Same key `lib/estate/pause-inventory.ts` uses —
 * deliberately, so the Brain and the pause machinery cannot disagree about who
 * owns what. Its VALUE is the estate id, so two Loom estates sharing a
 * subscription cannot claim each other's resources.
 */
export const LOOM_ESTATE_TAG_KEY = 'loom-estate-id';

/**
 * One row as Azure Resource Graph returns it.
 *
 * Accepts BOTH the ARG-native field names (`id`, `type`) and the
 * `DiscoveredResource` names (`resourceId`, `resourceType`) used by
 * `lib/estate/pause-inventory.ts`, so a caller holding either shape can feed
 * this without a conversion step that could drop a field.
 *
 * `properties` is `unknown` on purpose: ARG returns a different shape per
 * resource type, and typing it as `any` would let a typo read `undefined`
 * silently. Everything is read through the checked accessors below.
 */
export interface ResourceGraphRow {
  readonly id?: string;
  readonly resourceId?: string;
  readonly type?: string;
  readonly resourceType?: string;
  readonly name?: string;
  readonly resourceGroup?: string;
  readonly subscriptionId?: string;
  readonly location?: string;
  /** `null` means the tags could NOT be read. `{}` means read, and empty. */
  readonly tags?: Readonly<Record<string, string>> | null;
  readonly tagsError?: string;
  readonly properties?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Container Apps scale facts from `properties.template.scale`.
 *
 * Returns `undefined` when the shape is absent — which the graph reads as NOT
 * MEASURED, never as `minReplicas: 0`. A resource whose scale could not be read
 * must not be silently exonerated by an always-on query.
 */
function readScale(properties: unknown): ScaleFacts | undefined {
  const p = obj(properties);
  const template = obj(p?.template);
  const scale = obj(template?.scale);
  const minReplicas = num(scale?.minReplicas);
  if (minReplicas === undefined) return undefined;

  // CPU/memory live per-container, not on scale. Read the FIRST container only
  // and say so: a multi-container app's true cost is the sum, and reporting one
  // container's numbers as the app's would understate it. The `source` field
  // plus this comment keep that visible rather than implied.
  const containers = Array.isArray(template?.containers) ? template!.containers : [];
  const first = obj(containers[0]);
  const resources = obj(first?.resources);

  return {
    minReplicas,
    maxReplicas: num(scale?.maxReplicas),
    cpu: num(resources?.cpu),
    memory: str(resources?.memory),
    source: 'resource-graph',
  };
}

/** Ingress facts from `properties.configuration.ingress`. */
function readIngress(properties: unknown): IngressFacts | undefined {
  const p = obj(properties);
  const configuration = obj(p?.configuration);
  const ingress = obj(configuration?.ingress);
  if (!ingress) return undefined;
  const external = ingress.external;
  return {
    // An absent `external` defaults to false in Container Apps, and false is
    // also the interesting case (an INTERNAL endpoint), so this default does not
    // flatter the result.
    external: typeof external === 'boolean' ? external : false,
    fqdn: str(ingress.fqdn) ?? null,
    targetPort: num(ingress.targetPort),
  };
}

/** Derive `subscriptionId` / `resourceGroup` from an ARM id when the row omits them. */
function fromArmId(armId: string): { subscriptionId?: string; resourceGroup?: string; name?: string } {
  const m = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\//i.exec(armId);
  const name = armId.split('/').filter(Boolean).pop();
  return { subscriptionId: m?.[1], resourceGroup: m?.[2], name };
}

export interface ResourceGraphExtractionOptions {
  /**
   * The estate id to test ownership against. When supplied, a resource is
   * Loom-owned iff `tags['loom-estate-id'] === estateId`.
   *
   * When OMITTED, any non-empty `loom-estate-id` value counts as owned and the
   * owner node is that value — which is right for an estate-wide report but is
   * NOT sufficient for a cleanup recommendation, because it cannot tell two Loom
   * estates apart. Callers that will recommend a mutation must pass it.
   */
  readonly estateId?: string;
}

/**
 * Turn Resource Graph rows into nodes and `owns` edges.
 *
 * Every row becomes a node — the report is estate-wide across all six
 * subscriptions. Only rows carrying the ownership tag get an `owns` edge, and
 * that edge is what a cleanup recommendation must be scoped by.
 */
export function extractFromResourceGraph(
  rows: readonly ResourceGraphRow[],
  options: ResourceGraphExtractionOptions = {},
): ExtractionResult {
  const nodes: (AzureResourceNode | DeployArtifactNode)[] = [];
  const edges: PendingEdge[] = [];
  const skipped: SkippedSubject[] = [];
  const ownerNodes = new Map<string, DeployArtifactNode>();

  for (const row of rows) {
    const armId = str(row.id) ?? str(row.resourceId);
    if (!armId) {
      skipped.push({
        subject: JSON.stringify(row).slice(0, 200),
        reason: 'row has neither `id` nor `resourceId`; a resource with no ARM id has no identity',
      });
      continue;
    }
    const resourceType = str(row.type) ?? str(row.resourceType);
    if (!resourceType) {
      skipped.push({ subject: armId, reason: 'row has neither `type` nor `resourceType`' });
      continue;
    }

    const derived = fromArmId(armId);
    const name = str(row.name) ?? derived.name ?? armId;
    const subscriptionId = str(row.subscriptionId) ?? derived.subscriptionId;
    const resourceGroup = str(row.resourceGroup) ?? derived.resourceGroup;

    if (!subscriptionId || !resourceGroup) {
      skipped.push({
        subject: armId,
        reason:
          'subscriptionId/resourceGroup could not be established from the row or its ARM id ' +
          '(non-standard scope, e.g. a subscription- or tenant-level resource)',
      });
      continue;
    }

    const id = azureResourceNodeId(armId);
    const node: AzureResourceNode = {
      id,
      kind: 'azure-resource',
      displayName: name,
      source: 'resource-graph',
      resourceId: armId,
      resourceType,
      subscriptionId,
      resourceGroup,
      location: str(row.location),
      tags: row.tags === undefined ? null : row.tags,
      tagsError:
        row.tagsError ??
        (row.tags === undefined
          ? 'row carried no `tags` field; tags were NOT read (indeterminate, not "no tags")'
          : undefined),
      scale: readScale(row.properties),
      ingress: readIngress(row.properties),
      provisioningState: str(obj(row.properties)?.provisioningState),
    };
    nodes.push(node);

    // ── Ownership ─────────────────────────────────────────────────────────
    if (node.tags === null) {
      skipped.push({
        subject: armId,
        reason: `ownership INDETERMINATE: ${node.tagsError ?? 'tags could not be read'}. No owns edge emitted.`,
      });
      continue;
    }

    // Tag keys are case-insensitive in Azure; look the key up case-insensitively
    // rather than assuming the casing survived whatever produced the row.
    let estateValue: string | undefined;
    for (const [k, v] of Object.entries(node.tags)) {
      if (k.toLowerCase() === LOOM_ESTATE_TAG_KEY) {
        estateValue = str(v);
        break;
      }
    }
    if (!estateValue) continue; // Not Loom's. Still a node; no owns edge. Correct.

    if (options.estateId !== undefined && estateValue !== options.estateId) {
      skipped.push({
        subject: armId,
        reason:
          `carries ${LOOM_ESTATE_TAG_KEY}='${estateValue}' which is a DIFFERENT estate from ` +
          `'${options.estateId}'. Not owned by the estate under analysis.`,
      });
      continue;
    }

    const ownerKey = `estate/${estateValue}`;
    let owner = ownerNodes.get(ownerKey);
    if (!owner) {
      owner = {
        id: deployArtifactNodeId(ownerKey),
        kind: 'deploy-artifact',
        displayName: `Loom estate ${estateValue}`,
        source: 'resource-graph',
        path: ownerKey,
        artifactKind: 'manifest',
      };
      ownerNodes.set(ownerKey, owner);
      nodes.push(owner);
    }

    edges.push({
      provenance: 'owns',
      from: owner.id,
      targetRef: armId,
      emptyValue: false,
      intendedTo: id,
      evidence: {
        artifact: armId,
        symbol: LOOM_ESTATE_TAG_KEY,
        rawValue: estateValue,
        extractor: 'resource-graph',
      },
    });
  }

  return {
    source: 'resource-graph',
    nodes,
    edges,
    population: makePopulation({
      subject: 'nodes',
      nodes,
      edges,
      scope:
        `${rows.length} Resource Graph row(s) in; ${nodes.length} node(s) out, ` +
        `${edges.length} owns edge(s), ${skipped.length} skipped`,
    }),
    skipped,
  };
}
