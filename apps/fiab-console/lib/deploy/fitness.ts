/**
 * fitness — is an ADOPTED Azure resource actually usable by Loom?
 *
 * Discovery answers *does it exist*. This answers *can Loom drive it*, and it is
 * BLOCKING: `assertPlanIsDeployable()` runs before a single resource is created
 * — called by POST /api/setup/deploy at the submit choke point, ahead of every
 * deploy tier (#3014) — so an unusable adoption costs ~20 seconds instead of a
 * half-built estate. The guard test
 * `app/api/setup/__tests__/deploy-fitness-gate.test.ts` goes red if that caller
 * is removed; this suite being a well-tested library nothing calls is the
 * measured defect it recovers from.
 *
 * THREE RULES THIS MODULE ENFORCES
 * -------------------------------
 * 1. `established` is MANDATORY on every check. It records WHAT THE CODE ACTUALLY
 *    OBSERVED — the field, the value, the API version — and a check's `what` may
 *    only assert something that field supports. This is the deploy-integrity R7
 *    enforcement point, and `scripts/ci/check-fitness-messages.mjs` fails the
 *    build on any check literal missing it.
 *
 * 2. `unknown` is a FIRST-CLASS verdict and is NEVER rendered as `unusable`.
 *    "I could not read the SKU" and "the SKU is wrong" are different facts. On
 *    2026-08-05 a roll reported "the tag does not exist" when the truth was "I
 *    could not reach the registry"; that message sent two investigations down the
 *    wrong path. An `unknown` blocks adoption and names what would let Loom verify.
 *
 * 3. A remediation the PLATFORM could perform is not a message to the operator.
 *    `remediation.kind === 'platform-will-fix'` means the deploy does it —
 *    creating the private endpoint and DNS record, adding the firewall rule,
 *    granting the role with the operator's own token (auto-bind-by-default §5).
 *    `operator-action` is reserved for things Loom genuinely cannot do.
 */

import {
  getServiceDef,
  type AdoptableServiceDef,
} from './adoption-catalog';

export type CheckVerdict = 'pass' | 'warn' | 'fail' | 'unknown';

export type FitnessVerdict = 'usable' | 'usable-with-changes' | 'unusable' | 'unknown';

/** Network posture as OBSERVED on the resource, never inferred from its type. */
export type NetworkPosture = 'public' | 'public-restricted' | 'private-endpoint' | 'unknown';

export type Remediation =
  /** The deploy performs this itself. No operator step. */
  | { kind: 'platform-will-fix'; description: string }
  /** Loom genuinely cannot do it. Carries the exact command / role / portal action. */
  | {
      kind: 'operator-action';
      description: string;
      command?: string;
      portalUrl?: string;
      role?: { name: string; scope: string };
    }
  /** Nothing can fix it on this resource. Names the alternative. */
  | { kind: 'not-remediable'; description: string; alternative: string };

export interface FitnessCheck {
  /** Stable id, `<service>.<check>` — e.g. 'adls.hns'. */
  id: string;
  verdict: CheckVerdict;
  /** The defect, stated plainly. */
  what: string;
  /** Why Loom cares — what breaks if this stays as it is. */
  why: string;
  /**
   * WHAT THE CODE OBSERVED. Mandatory. Field, value and source, e.g.
   * "properties.isHnsEnabled=false from Microsoft.Storage/storageAccounts@2023-05-01".
   * When the observation FAILED, that is what this says — and the verdict is
   * 'unknown', never 'fail'.
   */
  established: string;
  remediation?: Remediation;
}

export interface FitnessResult {
  verdict: FitnessVerdict;
  checks: FitnessCheck[];
}

/** The resource being validated, as returned by discovery or typed by hand. */
export interface FitnessSubject {
  serviceKey: string;
  name: string;
  resourceGroup: string;
  subscriptionId: string;
  /** Absent means discovery could not read it — drives an `unknown`, not a `fail`. */
  location?: string;
  sku?: { name?: string; tier?: string; capacity?: number };
  kind?: string;
  networkPosture?: NetworkPosture;
  /** Arbitrary observed properties, keyed by the family-check ids that read them. */
  properties?: Record<string, unknown>;
  /** The tenant the resource lives in, when discovery could establish it. */
  tenantId?: string;
}

/** Everything the checks compare the subject against. */
export interface FitnessContext {
  hubRegion: string;
  hubTenantId: string;
  /** Whether the deploy identity already holds the catalog role at this scope. */
  rbac?: { holdsRole: boolean | 'unknown'; canGrant: boolean | 'unknown' };
  /** Whether the Console egress can already reach the resource's data plane. */
  reachable?: boolean | 'unknown';
}

const WORST: Record<CheckVerdict, number> = { pass: 0, warn: 1, unknown: 2, fail: 3 };

/**
 * Roll the individual checks into one verdict.
 *
 * `unknown` outranks `warn` and is reported DISTINCTLY from `unusable` — an
 * operator who is told "I could not verify X" can go make X verifiable; one who
 * is told "X is unusable" goes and replaces a resource that was probably fine.
 */
export function rollUpVerdict(checks: FitnessCheck[]): FitnessVerdict {
  let worst: CheckVerdict = 'pass';
  for (const c of checks) if (WORST[c.verdict] > WORST[worst]) worst = c.verdict;
  switch (worst) {
    case 'fail': return 'unusable';
    case 'unknown': return 'unknown';
    case 'warn': return 'usable-with-changes';
    default: return 'usable';
  }
}

// ---------------------------------------------------------------------------
// C1 — SKU / tier
// ---------------------------------------------------------------------------
function checkSku(def: AdoptableServiceDef, s: FitnessSubject): FitnessCheck | null {
  const spec = def.fitness;
  if (!spec.allowedSkuTiers?.length && !spec.forbiddenSkus?.length) return null;

  const observedTier = (s.sku?.tier ?? '').toLowerCase();
  const observedName = (s.sku?.name ?? '').toLowerCase();
  if (!observedTier && !observedName) {
    return {
      id: `${def.key}.sku`,
      verdict: 'unknown',
      what: `Loom could not read the SKU of ${def.label} "${s.name}"`,
      why: `${def.label} adoption depends on the tier: ${skuRequirementSentence(def)}.`,
      established: 'sku.name and sku.tier were both absent from the discovered resource',
      remediation: {
        kind: 'operator-action',
        description:
          'Grant the scanning identity Reader on this resource so its SKU can be read, then re-run discovery.',
        role: { name: 'Reader', scope: `${s.resourceGroup}/${s.name}` },
      },
    };
  }

  const forbidden = spec.forbiddenSkus?.find(
    (f) => observedTier === f.match.toLowerCase() || observedName === f.match.toLowerCase(),
  );
  if (forbidden) {
    return {
      id: `${def.key}.sku`,
      verdict: 'fail',
      what: `${def.label} "${s.name}" is on the ${s.sku?.tier ?? s.sku?.name} tier, which Loom cannot use`,
      why: forbidden.why,
      established: `sku.tier=${JSON.stringify(s.sku?.tier ?? null)} sku.name=${JSON.stringify(s.sku?.name ?? null)}`,
      remediation: {
        kind: 'not-remediable',
        description: 'Loom will not change the tier of a resource you own.',
        alternative: `Point Loom at a ${skuRequirementSentence(def)} instance, or let Loom deploy its own.`,
      },
    };
  }

  if (spec.allowedSkuTiers?.length) {
    const ok = spec.allowedSkuTiers.some((t) => observedTier === t.toLowerCase() || observedName === t.toLowerCase());
    if (!ok) {
      return {
        id: `${def.key}.sku`,
        verdict: 'fail',
        what: `${def.label} "${s.name}" is on the ${s.sku?.tier ?? s.sku?.name} tier`,
        why: `Loom requires ${skuRequirementSentence(def)}.`,
        established: `sku.tier=${JSON.stringify(s.sku?.tier ?? null)} sku.name=${JSON.stringify(s.sku?.name ?? null)}`,
        remediation: {
          kind: 'not-remediable',
          description: 'Loom will not change the tier of a resource you own.',
          alternative: `Point Loom at a ${skuRequirementSentence(def)} instance, or let Loom deploy its own.`,
        },
      };
    }
  }

  return {
    id: `${def.key}.sku`,
    verdict: 'pass',
    what: `${def.label} "${s.name}" is on a supported tier`,
    why: `Loom requires ${skuRequirementSentence(def)}.`,
    established: `sku.tier=${JSON.stringify(s.sku?.tier ?? null)} sku.name=${JSON.stringify(s.sku?.name ?? null)}`,
  };
}

function skuRequirementSentence(def: AdoptableServiceDef): string {
  const allowed = def.fitness.allowedSkuTiers?.length
    ? `the ${def.fitness.allowedSkuTiers.join(' or ')} tier`
    : '';
  const forbidden = def.fitness.forbiddenSkus?.length
    ? `anything other than ${def.fitness.forbiddenSkus.map((f) => f.match).join(' or ')}`
    : '';
  return allowed || forbidden || 'any tier';
}

// ---------------------------------------------------------------------------
// C2 — region
// ---------------------------------------------------------------------------
function checkRegion(def: AdoptableServiceDef, s: FitnessSubject, ctx: FitnessContext): FitnessCheck | null {
  if (def.fitness.regionPolicy === 'any') return null;

  if (!s.location) {
    return {
      id: `${def.key}.region`,
      verdict: 'unknown',
      what: `Loom could not read the region of ${def.label} "${s.name}"`,
      why: `${def.label} must sit in the hub region (${ctx.hubRegion}) for the data path to work without cross-region egress.`,
      established: 'location was absent from the discovered resource',
    };
  }

  const same = s.location.toLowerCase() === ctx.hubRegion.toLowerCase();
  if (same) {
    return {
      id: `${def.key}.region`,
      verdict: 'pass',
      what: `${def.label} "${s.name}" is in the hub region`,
      why: 'Co-location keeps the data path in-region.',
      established: `location=${s.location}, hub region=${ctx.hubRegion}`,
    };
  }

  const blocking = def.fitness.regionPolicy === 'must-match-hub';
  return {
    id: `${def.key}.region`,
    verdict: blocking ? 'fail' : 'warn',
    what: `${def.label} "${s.name}" is in ${s.location}, the Loom hub is in ${ctx.hubRegion}`,
    why: blocking
      ? `Loom drives this service on the hub data path; a cross-region instance adds egress cost and latency to every call and, for ${def.family} services, is not supported.`
      : 'Cross-region works, but every call pays egress and added latency.',
    established: `location=${s.location}, hub region=${ctx.hubRegion}`,
    remediation: blocking
      ? {
          kind: 'not-remediable',
          description: 'Loom cannot move a resource between regions.',
          alternative: `Point Loom at an instance in ${ctx.hubRegion}, or let Loom deploy its own there.`,
        }
      : {
          kind: 'operator-action',
          description: `Accept the cross-region cost, or point Loom at an instance in ${ctx.hubRegion}.`,
        },
  };
}

// ---------------------------------------------------------------------------
// C3 — network reachability. Evaluated CONCRETELY, never assumed from the type.
// ---------------------------------------------------------------------------
function checkNetwork(def: AdoptableServiceDef, s: FitnessSubject): FitnessCheck | null {
  const posture = s.networkPosture ?? 'unknown';
  const base = { id: `${def.key}.network`, why: `The Console egress must reach the ${def.label} data plane or every call from Loom fails at runtime, not at deploy time.` };

  switch (posture) {
    case 'public':
      return {
        ...base,
        verdict: 'pass',
        what: `${def.label} "${s.name}" accepts traffic from the Loom Console`,
        established: 'publicNetworkAccess=Enabled with no IP or VNet rules observed',
      };
    case 'public-restricted':
      return {
        ...base,
        verdict: 'warn',
        what: `${def.label} "${s.name}" restricts access to specific networks, and the Loom Console is not among them`,
        established: 'publicNetworkAccess=Enabled with networkAcls IP/VNet rules present that do not include the Console egress',
        remediation: {
          kind: 'platform-will-fix',
          description:
            "The deploy adds the Console environment's egress to this resource's network rules. If Loom is not permitted to write to the resource, it will name the exact rule to add instead.",
        },
      };
    case 'private-endpoint':
      return {
        ...base,
        verdict: 'warn',
        what: `${def.label} "${s.name}" is reachable only through a private endpoint that is not in the Loom hub network`,
        established: 'publicNetworkAccess=Disabled with private endpoint connections present, none resolving into the hub VNet or a peer',
        remediation: {
          kind: 'platform-will-fix',
          description:
            'The deploy creates a private endpoint into the hub network and the matching Private DNS record. This needs Network Contributor on the resource group holding the resource; if that is missing the deploy names the role rather than half-creating the link.',
        },
      };
    default:
      return {
        ...base,
        verdict: 'unknown',
        what: `Loom could not establish how ${def.label} "${s.name}" is reached`,
        established: 'the network posture could not be derived — publicNetworkAccess and networkAcls were not readable',
        remediation: {
          kind: 'operator-action',
          description:
            'Grant the scanning identity Reader on this resource so its network configuration can be read, then re-run validation.',
          role: { name: 'Reader', scope: `${s.resourceGroup}/${s.name}` },
        },
      };
  }
}

// ---------------------------------------------------------------------------
// C4 — RBAC. Established by ARM, never inferred.
// ---------------------------------------------------------------------------
function checkRbac(def: AdoptableServiceDef, s: FitnessSubject, ctx: FitnessContext): FitnessCheck | null {
  if (!def.roleName) return null;
  const scope = `${s.resourceGroup}/${s.name}`;
  const r = ctx.rbac;

  if (!r || r.holdsRole === 'unknown') {
    return {
      id: `${def.key}.rbac`,
      verdict: 'unknown',
      what: `Loom could not establish whether it holds ${def.roleName} on ${def.label} "${s.name}"`,
      why: `Without ${def.roleName} at this scope, every Loom call against ${def.label} fails with AuthorizationFailed after the deploy has already run.`,
      established:
        'the Microsoft.Authorization/permissions call at the resource scope did not return a readable result',
      remediation: {
        kind: 'operator-action',
        description: `Grant the deploying identity Reader on this scope so the permission check can run, or grant ${def.roleName} directly.`,
        role: { name: def.roleName, scope },
      },
    };
  }

  if (r.holdsRole === true) {
    return {
      id: `${def.key}.rbac`,
      verdict: 'pass',
      what: `Loom already holds ${def.roleName} on ${def.label} "${s.name}"`,
      why: `${def.roleName} is what Loom needs to drive ${def.label}.`,
      established: `Microsoft.Authorization/permissions at the resource scope returned an assignment covering ${def.roleName}`,
    };
  }

  if (r.canGrant === true) {
    return {
      id: `${def.key}.rbac`,
      verdict: 'warn',
      what: `Loom does not yet hold ${def.roleName} on ${def.label} "${s.name}"`,
      why: `${def.roleName} is what Loom needs to drive ${def.label}.`,
      established:
        'the permission check returned no matching assignment, and the signed-in identity does hold Microsoft.Authorization/roleAssignments/write at this scope',
      remediation: {
        kind: 'platform-will-fix',
        description: `The deploy creates the ${def.roleName} assignment for the Console identity at this scope using your own token, before any resource is created.`,
      },
    };
  }

  return {
    id: `${def.key}.rbac`,
    verdict: 'fail',
    what: `Loom cannot obtain ${def.roleName} on ${def.label} "${s.name}"`,
    why: `${def.roleName} is what Loom needs to drive ${def.label}, and neither the Console identity nor you can create the assignment.`,
    established:
      'the permission check returned no matching assignment, and Microsoft.Authorization/roleAssignments/write is not held at this scope either',
    remediation: {
      kind: 'operator-action',
      description: `An Owner or User Access Administrator on this scope must grant ${def.roleName} to the Loom Console identity.`,
      role: { name: def.roleName, scope },
      command: `az role assignment create --role "${def.roleName}" --assignee <console-identity-object-id> --scope <this resource>`,
    },
  };
}

// ---------------------------------------------------------------------------
// C5 — family-specific. Each reads a NAMED property and says what it read.
// ---------------------------------------------------------------------------
type FamilyCheckFn = (def: AdoptableServiceDef, s: FitnessSubject, ctx: FitnessContext) => FitnessCheck;

/** Read a property, distinguishing "absent" (unknown) from "false" (a real answer). */
function prop(s: FitnessSubject, key: string): unknown {
  return s.properties?.[key];
}

function unknownProp(id: string, label: string, name: string, propName: string, why: string): FitnessCheck {
  return {
    id,
    verdict: 'unknown',
    what: `Loom could not read ${propName} on ${label} "${name}"`,
    why,
    established: `${propName} was absent from the discovered resource — this is "not read", which is a different fact from "false"`,
    remediation: {
      kind: 'operator-action',
      description: `Grant the scanning identity Reader on this resource so ${propName} can be read, then re-run validation.`,
    },
  };
}

const FAMILY_CHECKS: Record<string, FamilyCheckFn> = {
  // --- Purview -------------------------------------------------------------
  'purview.sameTenant': (def, s, ctx) => {
    if (!s.tenantId) {
      return unknownProp('purview.sameTenant', def.label, s.name, 'the owning tenant id',
        "Purview is tenant-scoped and Loom's identity model is single-tenant, so a cross-tenant account cannot be driven at all.");
    }
    const same = s.tenantId === ctx.hubTenantId;
    return {
      id: 'purview.sameTenant',
      verdict: same ? 'pass' : 'fail',
      what: same
        ? `Purview account "${s.name}" is in this tenant`
        : `Purview account "${s.name}" is in a different tenant`,
      why: "Purview is tenant-scoped and the Loom Console identity cannot hold a role in another tenant without a B2B or Lighthouse arrangement Loom does not model.",
      established: `resource tenantId=${s.tenantId}, hub tenantId=${ctx.hubTenantId}`,
      remediation: same
        ? undefined
        : {
            kind: 'not-remediable',
            description: 'Loom cannot drive a Purview account in another tenant.',
            alternative: 'Use a Purview account in this tenant, or let Loom deploy one.',
          },
    };
  },
  'purview.rootCollectionAdmin': (def, s) => {
    const v = prop(s, 'rootCollectionAdmin');
    if (v === undefined) {
      return unknownProp('purview.rootCollectionAdmin', def.label, s.name, 'the root collection administrator list',
        'Without collection-administrator rights on the root collection, Loom cannot register any data source and the whole catalog stays empty.');
    }
    return {
      id: 'purview.rootCollectionAdmin',
      verdict: v === true ? 'pass' : 'warn',
      what: v === true
        ? `The Loom identity is a collection administrator on "${s.name}"`
        : `The Loom identity is not a collection administrator on Purview account "${s.name}"`,
      why: 'Without collection-administrator rights on the root collection, Loom cannot register data sources and the catalog stays empty.',
      established: `properties.rootCollectionAdmin resolved to ${JSON.stringify(v)}`,
      remediation: v === true ? undefined : {
        kind: 'platform-will-fix',
        description: 'The deploy adds the Console identity as a collection administrator on the root collection using your own token.',
      },
    };
  },
  'purview.capacityUnits': (def, s) => {
    const v = prop(s, 'freeCapacityUnits');
    if (v === undefined) {
      return unknownProp('purview.capacityUnits', def.label, s.name, 'the free capacity-unit count',
        'Loom scans need at least one free capacity unit or every scan queues indefinitely.');
    }
    const n = Number(v);
    return {
      id: 'purview.capacityUnits',
      verdict: n >= 1 ? 'pass' : 'warn',
      what: n >= 1
        ? `Purview account "${s.name}" has ${n} free capacity unit(s)`
        : `Purview account "${s.name}" has no free capacity units`,
      why: 'Loom scans need at least one free capacity unit or every scan queues indefinitely.',
      established: `properties.freeCapacityUnits=${JSON.stringify(v)}`,
      remediation: n >= 1 ? undefined : {
        kind: 'operator-action',
        description: 'Raise the capacity of the Purview account, or expect Loom scans to queue behind your existing ones.',
      },
    };
  },

  // --- AI Search -----------------------------------------------------------
  'aisearch.indexHeadroom': (def, s) => {
    const v = prop(s, 'indexCount');
    const limit = prop(s, 'indexLimit');
    if (v === undefined || limit === undefined) {
      return unknownProp('aisearch.indexHeadroom', def.label, s.name, 'the index count and quota',
        'Loom creates four indexes; without headroom the index creation fails after the deploy has already run.');
    }
    const free = Number(limit) - Number(v);
    return {
      id: 'aisearch.indexHeadroom',
      verdict: free >= 4 ? 'pass' : 'fail',
      what: free >= 4
        ? `AI Search service "${s.name}" has room for Loom's four indexes`
        : `AI Search service "${s.name}" has room for ${free} more index(es); Loom needs 4`,
      why: "Loom creates loom-docs, loom-catalog, loom-items and loom-help. Without headroom, index creation fails after the rest of the estate is already deployed.",
      established: `indexCount=${JSON.stringify(v)} of indexLimit=${JSON.stringify(limit)}`,
      remediation: free >= 4 ? undefined : {
        kind: 'not-remediable',
        description: 'Loom will not delete indexes you own to make room.',
        alternative: 'Point Loom at a service with four free index slots, or let Loom deploy its own.',
      },
    };
  },

  // --- Foundry / AOAI ------------------------------------------------------
  'foundry.kind': (def, s) => {
    const k = (s.kind ?? '').toLowerCase();
    if (!s.kind) {
      return unknownProp('foundry.kind', def.label, s.name, 'the account kind',
        'Loom needs an AIServices-kind Cognitive Services account; a Maps or generic Cognitive account exposes none of the inference surface.');
    }
    const ok = k.includes('aiservices') || k.includes('openai');
    return {
      id: 'foundry.kind',
      verdict: ok ? 'pass' : 'fail',
      what: ok
        ? `Account "${s.name}" is an AI Services account`
        : `Account "${s.name}" is a "${s.kind}" Cognitive Services account, not an AI Services / OpenAI account`,
      why: 'Loom calls the AOAI inference surface, which only an AIServices or OpenAI kind account exposes.',
      established: `kind=${JSON.stringify(s.kind)}`,
      remediation: ok ? undefined : {
        kind: 'not-remediable',
        description: 'The kind of a Cognitive Services account is fixed at creation.',
        alternative: 'Point Loom at an AI Services account, or let Loom deploy one.',
      },
    };
  },
  'foundry.chatDeployment': (def, s) => deploymentCheck(def, s, 'chatDeployment', 'chat'),
  'foundry.embedDeployment': (def, s) => deploymentCheck(def, s, 'embedDeployment', 'embedding'),

  // --- ADX -----------------------------------------------------------------
  'adx.streamingIngestion': (def, s) => {
    const v = prop(s, 'enableStreamingIngest');
    if (v === undefined) {
      return unknownProp('adx.streamingIngestion', def.label, s.name, 'enableStreamingIngest',
        'The eventhouse and real-time dashboard paths ingest through streaming ingestion.');
    }
    return {
      id: 'adx.streamingIngestion',
      verdict: v === true ? 'pass' : 'warn',
      what: v === true
        ? `Streaming ingestion is enabled on cluster "${s.name}"`
        : `Streaming ingestion is disabled on cluster "${s.name}"`,
      why: 'The eventhouse and real-time dashboard paths ingest through streaming ingestion; without it, rows land on the batch policy instead and dashboards look frozen.',
      established: `properties.enableStreamingIngest=${JSON.stringify(v)}`,
      remediation: v === true ? undefined : {
        kind: 'platform-will-fix',
        description: 'The deploy enables streaming ingestion on the cluster. This restarts ingestion briefly but does not affect stored data.',
      },
    };
  },
  'adx.databaseHeadroom': (def, s) => {
    const v = prop(s, 'databaseCount');
    if (v === undefined) {
      return unknownProp('adx.databaseHeadroom', def.label, s.name, 'the database count',
        'Loom creates loomdb_default on the cluster.');
    }
    return {
      id: 'adx.databaseHeadroom',
      verdict: 'pass',
      what: `Cluster "${s.name}" carries ${Number(v)} database(s); Loom adds loomdb_default`,
      why: 'Loom creates its own database on the cluster rather than writing into yours.',
      established: `databaseCount=${JSON.stringify(v)}`,
    };
  },

  // --- Synapse -------------------------------------------------------------
  'synapse.managedVnetPrivateEndpoint': (def, s) => managedVnetCheck(def, s, 'synapse.managedVnetPrivateEndpoint'),
  'synapse.sqlAdminSettable': (def, s) => {
    const v = prop(s, 'sqlAdminSettable');
    if (v === undefined) {
      return unknownProp('synapse.sqlAdminSettable', def.label, s.name, 'the SQL administrator configuration',
        'Loom sets the Console identity as a Synapse SQL administrator; without it every serverless SQL query from Loom fails to authenticate.');
    }
    return {
      id: 'synapse.sqlAdminSettable',
      verdict: v === true ? 'pass' : 'warn',
      what: v === true
        ? `The Synapse SQL administrator on "${s.name}" can be set to the Loom identity`
        : `The Synapse SQL administrator on "${s.name}" cannot be changed by the deploying identity`,
      why: 'Loom sets the Console identity as a Synapse SQL administrator; without it every serverless SQL query from Loom fails to authenticate.',
      established: `sqlAdminSettable resolved to ${JSON.stringify(v)}`,
      remediation: v === true ? undefined : {
        kind: 'operator-action',
        description: 'A workspace administrator must add the Loom Console identity as the Entra SQL administrator on this workspace.',
      },
    };
  },

  // --- Databricks ----------------------------------------------------------
  'databricks.metastoreAssignment': (def, s) => {
    const v = prop(s, 'metastoreId');
    const loomMetastore = prop(s, 'loomMetastoreId');
    if (v === undefined) {
      return unknownProp('databricks.metastoreAssignment', def.label, s.name, 'the Unity Catalog metastore assignment',
        'Metastore assignment is one per account per region and reassignment destroys the existing Unity Catalog objects, so Loom must know the current assignment before it touches the workspace.');
    }
    const unassigned = v === null || v === '';
    const isLoom = !!loomMetastore && v === loomMetastore;
    const ok = unassigned || isLoom;
    return {
      id: 'databricks.metastoreAssignment',
      verdict: ok ? 'pass' : 'fail',
      what: unassigned
        ? `Databricks workspace "${s.name}" is not assigned to a Unity Catalog metastore`
        : isLoom
          ? `Databricks workspace "${s.name}" is already on the Loom metastore`
          : `Databricks workspace "${s.name}" is assigned to a different Unity Catalog metastore`,
      why: 'A region has one metastore per account and reassignment is destructive to every Unity Catalog object already in it. Loom will not reassign a workspace away from a metastore you are using.',
      established: `metastoreId=${JSON.stringify(v)}, Loom metastore=${JSON.stringify(loomMetastore ?? null)}`,
      remediation: ok ? undefined : {
        kind: 'not-remediable',
        description: 'Reassigning the metastore would destroy the Unity Catalog objects already registered against it.',
        alternative: 'Adopt an unassigned workspace, adopt one already on the Loom metastore, or let Loom deploy its own.',
      },
    };
  },

  // --- ADF -----------------------------------------------------------------
  'adf.managedVnetPrivateEndpoint': (def, s) => managedVnetCheck(def, s, 'adf.managedVnetPrivateEndpoint'),
  'adf.pipelineNameCollision': (def, s) => nameCollisionCheck(def, s, 'adf.pipelineNameCollision', 'pipelineNames', 'pipeline'),

  // --- Event Hubs ----------------------------------------------------------
  'eventhubs.throughputHeadroom': (def, s) => {
    const v = prop(s, 'throughputUnits');
    if (v === undefined) {
      return unknownProp('eventhubs.throughputHeadroom', def.label, s.name, 'the throughput-unit count',
        'Loom adds its own event hubs and consumer groups to the namespace and needs at least one throughput unit of headroom.');
    }
    const n = Number(v);
    return {
      id: 'eventhubs.throughputHeadroom',
      verdict: n >= 1 ? 'pass' : 'warn',
      what: n >= 1
        ? `Namespace "${s.name}" has ${n} throughput unit(s)`
        : `Namespace "${s.name}" reports no throughput units`,
      why: 'Loom adds its own event hubs and consumer groups; without throughput headroom, ingestion throttles under load.',
      established: `properties.throughputUnits=${JSON.stringify(v)}`,
      remediation: n >= 1 ? undefined : {
        kind: 'operator-action',
        description: 'Raise the throughput units on the namespace, or expect Loom ingestion to share your existing budget.',
      },
    };
  },

  // --- Stream Analytics ----------------------------------------------------
  'asa.jobStopped': (def, s) => {
    const v = prop(s, 'jobState');
    if (v === undefined) {
      return unknownProp('asa.jobStopped', def.label, s.name, 'the job state',
        'Loom REPLACES the query of an adopted job. Doing that to a running production job stops it and discards its output.');
    }
    const state = String(v).toLowerCase();
    const stopped = state === 'stopped' || state === 'created';
    return {
      id: 'asa.jobStopped',
      verdict: stopped ? 'pass' : 'warn',
      what: stopped
        ? `Stream Analytics job "${s.name}" is ${state}`
        : `Stream Analytics job "${s.name}" is ${state} and Loom would replace its query`,
      why: 'Loom REPLACES the query of an adopted job with the Loom transform. On a running production job that stops it and discards its current output.',
      established: `properties.jobState=${JSON.stringify(v)}`,
      remediation: stopped ? undefined : {
        kind: 'operator-action',
        description: 'Confirm explicitly that Loom may take over this running job, or point Loom at a stopped job, or let Loom deploy its own.',
      },
    };
  },

  // --- Cosmos --------------------------------------------------------------
  'cosmos.serverlessAutoscale': (def, s) => {
    const v = prop(s, 'capabilities');
    if (v === undefined) {
      return unknownProp('cosmos.serverlessAutoscale', def.label, s.name, 'the account capabilities',
        'Loom provisions autoscale throughput on its database, which a serverless account does not support.');
    }
    const caps = Array.isArray(v) ? v.map((c) => String(c).toLowerCase()) : [];
    const serverless = caps.includes('enableserverless');
    return {
      id: 'cosmos.serverlessAutoscale',
      verdict: serverless ? 'fail' : 'pass',
      what: serverless
        ? `Cosmos account "${s.name}" is serverless`
        : `Cosmos account "${s.name}" supports provisioned autoscale throughput`,
      why: 'Loom provisions autoscale throughput on its database. A serverless account cannot carry it, and Loom will not restructure your throughput model.',
      established: `properties.capabilities=${JSON.stringify(v)}`,
      remediation: serverless ? {
        kind: 'not-remediable',
        description: 'The serverless capability is fixed at account creation.',
        alternative: 'Point Loom at a provisioned-throughput account, or let Loom deploy its own.',
      } : undefined,
    };
  },
  'cosmos.containerNameCollision': (def, s) => nameCollisionCheck(def, s, 'cosmos.containerNameCollision', 'containerNames', 'container'),

  // --- APIM ----------------------------------------------------------------
  'apim.vnetMode': (def, s) => {
    const v = prop(s, 'virtualNetworkType');
    if (v === undefined) {
      return unknownProp('apim.vnetMode', def.label, s.name, 'virtualNetworkType',
        'An Internal-mode APIM is only reachable from its own VNet, so the Console must be in that VNet or one peered to it.');
    }
    const mode = String(v).toLowerCase();
    const internal = mode === 'internal';
    const peered = prop(s, 'peeredToHub') === true;
    return {
      id: 'apim.vnetMode',
      verdict: !internal || peered ? 'pass' : 'warn',
      what: !internal
        ? `APIM "${s.name}" is in ${v} mode and reachable from the Console`
        : peered
          ? `APIM "${s.name}" is Internal-mode in a network the hub can reach`
          : `APIM "${s.name}" is Internal-mode in a VNet the Loom hub is not peered to`,
      why: 'An Internal-mode APIM is only reachable from its own VNet; without peering, every Loom call to it times out at runtime.',
      established: `properties.virtualNetworkType=${JSON.stringify(v)}, peeredToHub=${JSON.stringify(prop(s, 'peeredToHub') ?? null)}`,
      remediation: !internal || peered ? undefined : {
        kind: 'platform-will-fix',
        description: 'The deploy peers the hub VNet to the APIM VNet. This needs Network Contributor on both; if that is missing the deploy names the role rather than half-creating the peering.',
      },
    };
  },

  // --- Maps ----------------------------------------------------------------
  'maps.authMode': (def, s) => {
    const v = prop(s, 'disableLocalAuth');
    if (v === undefined) {
      return unknownProp('maps.authMode', def.label, s.name, 'disableLocalAuth',
        'Loom authenticates to Maps with its managed identity, which requires Entra auth to be available on the account.');
    }
    return {
      id: 'maps.authMode',
      verdict: 'pass',
      what: `Maps account "${s.name}" reports disableLocalAuth=${JSON.stringify(v)}`,
      why: 'Loom authenticates to Maps with its managed identity; both auth modes leave that path available.',
      established: `properties.disableLocalAuth=${JSON.stringify(v)}`,
    };
  },

  // --- AML -----------------------------------------------------------------
  'aml.computeQuota': (def, s) => {
    const v = prop(s, 'availableComputeCores');
    if (v === undefined) {
      return unknownProp('aml.computeQuota', def.label, s.name, 'the available compute-core quota',
        'Loom creates a default compute instance for notebooks; with no quota the notebook path honest-gates instead of running.');
    }
    const n = Number(v);
    return {
      id: 'aml.computeQuota',
      verdict: n > 0 ? 'pass' : 'warn',
      what: n > 0
        ? `Workspace "${s.name}" has ${n} compute core(s) of quota available`
        : `Workspace "${s.name}" has no compute-core quota available`,
      why: 'Loom creates a default compute instance for notebooks; with no quota, the notebook path honest-gates instead of running.',
      established: `availableComputeCores=${JSON.stringify(v)}`,
      remediation: n > 0 ? undefined : {
        kind: 'operator-action',
        description: 'Request a compute-core quota increase for this region, or expect the AML notebook path to honest-gate.',
        portalUrl: 'https://portal.azure.com/#view/Microsoft_Azure_Capacity/QuotaMenuBlade',
      },
    };
  },

  // --- ADLS (attach-in-place, but validated the same way) ------------------
  'adls.hns': (def, s) => {
    const v = prop(s, 'isHnsEnabled');
    if (v === undefined) {
      return unknownProp('adls.hns', def.label, s.name, 'isHnsEnabled',
        'Loom writes Delta tables through the ADLS Gen2 API, which only exists on an account with a hierarchical namespace.');
    }
    return {
      id: 'adls.hns',
      verdict: v === true ? 'pass' : 'fail',
      what: v === true
        ? `Storage account "${s.name}" has a hierarchical namespace`
        : `Storage account "${s.name}" does not have a hierarchical namespace enabled`,
      why: 'Loom writes Delta tables through the ADLS Gen2 API, which only exists on an account with a hierarchical namespace.',
      established: `properties.isHnsEnabled=${JSON.stringify(v)} from Microsoft.Storage/storageAccounts`,
      remediation: v === true ? undefined : {
        kind: 'not-remediable',
        description: 'isHnsEnabled is set at account creation and cannot be turned on afterwards.',
        alternative: 'Point Loom at an account created with a hierarchical namespace, or let Loom create one.',
      },
    };
  },
  'adls.premiumPageBlob': (def, s) => {
    const v = prop(s, 'skuKind');
    if (v === undefined) {
      return unknownProp('adls.premiumPageBlob', def.label, s.name, 'the account kind',
        'A Premium page-blob account cannot hold block blobs, which is what Delta files are.');
    }
    const kind = String(v).toLowerCase();
    const bad = kind === 'storage' || kind === 'premium_pageblob';
    return {
      id: 'adls.premiumPageBlob',
      verdict: bad ? 'fail' : 'pass',
      what: bad
        ? `Storage account "${s.name}" is a ${v} account, which cannot hold Delta block blobs`
        : `Storage account "${s.name}" is a ${v} account and can hold Delta block blobs`,
      why: 'Delta files are block blobs; a Premium page-blob or classic Storage account cannot hold them.',
      established: `kind=${JSON.stringify(v)}`,
      remediation: bad ? {
        kind: 'not-remediable',
        description: 'The account kind is fixed at creation.',
        alternative: 'Point Loom at a StorageV2 account with a hierarchical namespace, or let Loom create one.',
      } : undefined,
    };
  },
};

function deploymentCheck(def: AdoptableServiceDef, s: FitnessSubject, key: string, label: string): FitnessCheck {
  const v = prop(s, key);
  const id = `foundry.${key}`;
  if (v === undefined) {
    return unknownProp(id, def.label, s.name, `the ${label} deployment list`,
      `Loom calls a ${label} deployment on this account. Adopting an account whose deployments Loom cannot read means the failure surfaces at the first Copilot turn instead of here.`);
  }
  const has = typeof v === 'string' && v.length > 0;
  return {
    id,
    verdict: has ? 'pass' : 'fail',
    what: has
      ? `Account "${s.name}" exposes the ${label} deployment "${v}"`
      : `Account "${s.name}" has no ${label} deployment`,
    why: `Loom calls a ${label} deployment on this account. Adopting an account with none is not a bind failure to discover later — nothing that needs ${label} works at all.`,
    established: `${key}=${JSON.stringify(v)}`,
    remediation: has ? undefined : {
      kind: 'operator-action',
      description: `Create a ${label} deployment on this account and name it on the adoption row, or let Loom deploy its own Foundry account.`,
    },
  };
}

function managedVnetCheck(def: AdoptableServiceDef, s: FitnessSubject, id: string): FitnessCheck {
  const managed = prop(s, 'managedVnet');
  const pe = prop(s, 'managedPrivateEndpointToLake');
  if (managed === undefined) {
    return unknownProp(id, def.label, s.name, 'the managed virtual-network setting',
      'A managed-VNet workspace reaches the lake only through a managed private endpoint; without one, every job hangs rather than failing.');
  }
  if (managed !== true) {
    return {
      id,
      verdict: 'pass',
      what: `${def.label} "${s.name}" does not use a managed virtual network`,
      why: 'Without a managed VNet the workspace reaches the lake directly.',
      established: `managedVirtualNetwork=${JSON.stringify(managed)}`,
    };
  }
  const ok = pe === true;
  return {
    id,
    verdict: ok ? 'pass' : 'warn',
    what: ok
      ? `${def.label} "${s.name}" already has a managed private endpoint to the lake`
      : `${def.label} "${s.name}" uses a managed virtual network with no managed private endpoint to the Loom lake`,
    why: 'A managed-VNet workspace reaches the lake only through a managed private endpoint. Without one, jobs HANG rather than failing, which is far harder to diagnose.',
    established: `managedVirtualNetwork=${JSON.stringify(managed)}, managedPrivateEndpointToLake=${JSON.stringify(pe ?? null)}`,
    remediation: ok ? undefined : {
      kind: 'platform-will-fix',
      description: 'The deploy creates the managed private endpoint to the Loom lake and approves it.',
    },
  };
}

function nameCollisionCheck(def: AdoptableServiceDef, s: FitnessSubject, id: string, propName: string, noun: string): FitnessCheck {
  const v = prop(s, propName);
  if (v === undefined) {
    return unknownProp(id, def.label, s.name, `the existing ${noun} names`,
      `Loom creates ${noun}s with fixed names. A collision would overwrite something you own.`);
  }
  const existing = Array.isArray(v) ? v.map(String) : [];
  const clashes = existing.filter((n) => n.toLowerCase().startsWith('loom'));
  return {
    id,
    verdict: clashes.length === 0 ? 'pass' : 'warn',
    what: clashes.length === 0
      ? `No Loom-named ${noun}s already exist on "${s.name}"`
      : `"${s.name}" already carries ${clashes.length} Loom-named ${noun}(s): ${clashes.slice(0, 5).join(', ')}`,
    why: `Loom creates ${noun}s with fixed names. A collision means Loom would overwrite something already there.`,
    established: `${propName} contained ${existing.length} entries, ${clashes.length} of which start with "loom"`,
    remediation: clashes.length === 0 ? undefined : {
      kind: 'operator-action',
      description: `Confirm these ${noun}s are from a previous Loom install and may be reconciled, or point Loom at a different ${def.label}.`,
    },
  };
}

/**
 * Evaluate a candidate for adoption. Pure — every input is supplied, nothing is
 * fetched here, so the whole check suite is testable without Azure.
 */
export function evaluateFitness(subject: FitnessSubject, ctx: FitnessContext): FitnessResult {
  const def = getServiceDef(subject.serviceKey);
  if (!def) {
    return {
      verdict: 'unknown',
      checks: [{
        id: 'catalog.unknownService',
        verdict: 'unknown',
        what: `"${subject.serviceKey}" is not a service CSA Loom knows how to adopt`,
        why: 'Every adoption decision must name a service in the adoption catalog; an unknown key cannot be validated or deployed.',
        established: `the key was not found in ADOPTION_CATALOG (${subject.serviceKey})`,
      }],
    };
  }

  const checks: FitnessCheck[] = [];
  const sku = checkSku(def, subject); if (sku) checks.push(sku);
  const region = checkRegion(def, subject, ctx); if (region) checks.push(region);
  const net = checkNetwork(def, subject); if (net) checks.push(net);
  const rbac = checkRbac(def, subject, ctx); if (rbac) checks.push(rbac);

  for (const id of def.fitness.familyChecks) {
    const fn = FAMILY_CHECKS[id];
    if (!fn) {
      // A catalog entry naming a check with no implementation must be loud. A
      // silently skipped check is a validation that cannot fail.
      checks.push({
        id,
        verdict: 'unknown',
        what: `The "${id}" check named by the ${def.label} catalog entry has no implementation`,
        why: 'A named check with no implementation would silently pass, which is a validation that cannot fail.',
        established: `FAMILY_CHECKS has no entry for '${id}'`,
      });
      continue;
    }
    checks.push(fn(def, subject, ctx));
  }

  return { verdict: rollUpVerdict(checks), checks };
}

/** Thrown by `assertPlanIsDeployable` — carries the offending checks, not a string. */
export class AdoptionNotDeployableError extends Error {
  constructor(
    readonly blocking: { serviceKey: string; verdict: FitnessVerdict; checks: FitnessCheck[] }[],
  ) {
    super(
      `${blocking.length} adopted resource(s) cannot be used: ` +
        blocking
          .map((b) => `${b.serviceKey} (${b.verdict}) — ${b.checks.filter((c) => c.verdict === 'fail' || c.verdict === 'unknown').map((c) => c.what).join('; ')}`)
          .join(' | '),
    );
    this.name = 'AdoptionNotDeployableError';
  }
}

/**
 * The BLOCKING gate. Called by POST /api/setup/deploy — the submit choke
 * point — before ANY deploy tier fires (#3014).
 *
 * `unusable` blocks, and so does `unknown` — Loom does not deploy against a
 * resource it could not verify. `usable-with-changes` proceeds, because those
 * changes are ones the platform performs itself.
 */
export function assertPlanIsDeployable(
  results: { serviceKey: string; fitness: FitnessResult }[],
): void {
  const blocking = results
    .filter((r) => r.fitness.verdict === 'unusable' || r.fitness.verdict === 'unknown')
    .map((r) => ({ serviceKey: r.serviceKey, verdict: r.fitness.verdict, checks: r.fitness.checks }));
  if (blocking.length > 0) throw new AdoptionNotDeployableError(blocking);
}
