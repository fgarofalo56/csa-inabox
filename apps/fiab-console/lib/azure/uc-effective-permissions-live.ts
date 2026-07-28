/**
 * LU-4 — the LIVE half of the effective-permissions resolver: the adapter that
 * feeds the pure inheritance walk in `uc-effective-permissions.ts` with real
 * Unity Catalog REST reads.
 *
 * Split out of `unity-catalog-client.ts` so that module stays under its
 * monolith-creep ceiling; `listEffectivePermissions` reaches this file through a
 * dynamic import, which also keeps the (unavoidable) dependency edge — this
 * module reads through the UC client — from becoming a static import cycle.
 *
 * Nothing here is Databricks- or Fabric-dependent: this IS the Azure-native
 * default path for the Loom Unity (OSS Unity Catalog) backend.
 */
import {
  listPermissions, getCatalog, getSchema, getTable, getVolume, getFunctionUc,
  getRegisteredModel, getExternalLocation, getStorageCredential,
  type UCSecurableType,
} from '@/lib/azure/unity-catalog-client';
import { isOssUc } from '@/lib/azure/uc-backend';
import {
  ucSecurableChain, resolveEffectivePermissions, expandPrincipalClosure,
  UC_PRIVILEGES_BY_SECURABLE,
  type UcSecurableNode, type UcDirectGroupsResolver, type UCEffectivePermissions,
} from '@/lib/azure/uc-effective-permissions';

/** Is this privilege spelling one Loom's model knows about anywhere? Used only
 *  to decide whether a filtered-out ancestor privilege is expected narrowing or
 *  a modelling gap worth a warning. */
function ucKnownPrivilege(privilege: string): boolean {
  return Object.values(UC_PRIVILEGES_BY_SECURABLE).some((list) => list.includes(privilege));
}

/** Wall clock for the whole group-membership expansion. The walk is up to
 *  `maxPrincipals` Graph round-trips inside ONE BFF request, so it needs a
 *  deadline as well as a count bound (a slow directory must degrade to a
 *  truthful partial answer, not to a hung route). */
const CLOSURE_DEADLINE_MS = 8_000;
/** Count bound for the same walk — a pathological nesting cannot pin the BFF. */
const CLOSURE_MAX_PRINCIPALS = 100;

/** Read the `owner` of one securable. Returns `undefined` for a type whose
 *  backend reports no owner; throws only on a real transport / authorization
 *  error, which {@link computeEffectivePermissions} downgrades to a warning. */
async function securableOwner(host: string, type: UCSecurableType, name: string): Promise<string | undefined> {
  switch (type) {
    case 'CATALOG': return (await getCatalog(host, name)).owner;
    case 'SCHEMA': return (await getSchema(host, name)).owner;
    case 'TABLE': return (await getTable(host, name)).owner;
    case 'VOLUME': return (await getVolume(host, name)).owner;
    case 'FUNCTION': return (await getFunctionUc(host, name)).owner;
    case 'REGISTERED_MODEL': return (await getRegisteredModel(host, name)).owner;
    case 'EXTERNAL_LOCATION': return (await getExternalLocation(host, name)).owner;
    case 'STORAGE_CREDENTIAL': return (await getStorageCredential(host, name)).owner;
    // OSS Unity Catalog's metastore_summary carries no owner field, and
    // Databricks answers effective-permissions natively, so there is nothing to
    // read here on either backend.
    case 'METASTORE': return undefined;
  }
}

/**
 * Compute effective permissions for a securable from the direct grants + owners
 * of its whole containment chain — the Azure-native answer to the
 * Databricks-only `effective-permissions` endpoint, and the DEFAULT path on the
 * Loom Unity / OSS backend.
 *
 * Reads (all real REST, parallel per chain node):
 *   GET /permissions/{type}/{name}   for the target AND each ancestor
 *   GET /{catalogs|schemas|tables|volumes|functions|models|…}/{name}  for owners
 *   GET /users|groups/{id}/memberOf  (Microsoft Graph) for the group closure —
 *                                    only when a `principal` filter is supplied
 *
 * Every one of those can fail independently (a caller may legitimately lack
 * permission on a parent). A failure becomes a `warnings[]` entry, the node is
 * flagged `unreadable` so usage prerequisites anchored on it are reported as
 * `unknown` rather than `missing`, and the walk continues — "here are the grants
 * I can see, and I could not read that ancestor" is a truthful answer where a
 * 502 is not.
 */
export async function computeEffectivePermissions(
  host: string,
  secType: UCSecurableType,
  securableName: string,
  opts?: { principal?: string },
): Promise<UCEffectivePermissions> {
  const refs = ucSecurableChain(secType, securableName);
  const warnings: string[] = [];
  const oss = isOssUc();

  if (refs.length === 1 && secType !== 'CATALOG' && secType !== 'METASTORE'
      && secType !== 'EXTERNAL_LOCATION' && secType !== 'STORAGE_CREDENTIAL') {
    warnings.push(
      `"${securableName}" is not a fully-qualified ${secType} name, so its parent schema/catalog ` +
      'could not be identified. Only grants recorded directly on it are shown — nothing inherited, ' +
      'and the USE CATALOG / USE SCHEMA prerequisites could not be checked. ' +
      `Use the full ${secType === 'SCHEMA' ? 'catalog.schema' : 'catalog.schema.object'} name.`,
    );
  }

  const nodes: UcSecurableNode[] = await Promise.all(refs.map(async (ref) => {
    const [permsResult, ownerResult] = await Promise.allSettled([
      listPermissions(host, ref.type, ref.name),
      securableOwner(host, ref.type, ref.name),
    ]);
    if (permsResult.status === 'rejected') {
      warnings.push(
        `Could not read grants on ${ref.type} ${ref.name || '(metastore)'}: ` +
        `${(permsResult.reason as Error)?.message || String(permsResult.reason)}. ` +
        'Privileges inherited from it are therefore not shown.',
      );
    }
    if (ownerResult.status === 'rejected') {
      warnings.push(
        `Could not read the owner of ${ref.type} ${ref.name || '(metastore)'}: ` +
        `${(ownerResult.reason as Error)?.message || String(ownerResult.reason)}. ` +
        'Privileges implied by owning it are therefore not shown.',
      );
    }
    return {
      ...ref,
      owner: ownerResult.status === 'fulfilled' ? ownerResult.value : undefined,
      assignments: permsResult.status === 'fulfilled' ? (permsResult.value.privilege_assignments || []) : [],
      ...(permsResult.status === 'rejected' ? { unreadable: true } : {}),
      ...(ownerResult.status === 'rejected' ? { ownerUnreadable: true } : {}),
    };
  }));

  const principal = (opts?.principal || '').trim();
  let closure: string[] | undefined;
  // Only true when the directory actually answered — the pane must not claim
  // "…nor through any group it belongs to" off a closure of [principal].
  let closureResolved = false;
  if (principal) {
    // Lazy import: Microsoft Graph is only touched when a principal filter is
    // actually used, so the common "show everyone's effective grants" path never
    // pulls in the identity client or its credential chain.
    let directGroups: UcDirectGroupsResolver = async () => [];
    let graphAvailable = false;
    try {
      const mod = await import('@/lib/azure/graph-identity-client');
      directGroups = (name: string) => mod.getPrincipalDirectGroups(name);
      graphAvailable = true;
    } catch (e) {
      warnings.push(`Group membership could not be expanded: ${(e as Error)?.message || String(e)}`);
    }
    let membershipFailed = false;
    const resolved = await expandPrincipalClosure(principal, directGroups, {
      maxPrincipals: CLOSURE_MAX_PRINCIPALS,
      deadlineMs: CLOSURE_DEADLINE_MS,
      onError: (p, e) => {
        if (membershipFailed) return;   // one honest line, not one per principal
        membershipFailed = true;
        warnings.push(
          `Group membership for ${p} could not be read from Microsoft Entra ` +
          `(${(e as Error)?.message || String(e)}), so only privileges granted directly to ` +
          `${principal} are shown. Gate: graph-group-sync — set LOOM_GRAPH_GROUP_SYNC_ENABLED=true ` +
          '(or LOOM_IDENTITY_PICKER_ENABLED=true) on the Console and grant the Console UAMI Graph ' +
          'Group.Read.All + User.Read.All (scripts/csa-loom/grant-identity-graph-approles.sh, then ' +
          'admin-consent). Fix it at /admin/gates?gate=graph-group-sync.',
        );
      },
    });
    closure = resolved.closure;
    closureResolved = graphAvailable && !membershipFailed && !resolved.truncated;
    if (resolved.truncated) {
      warnings.push(
        `The group-membership walk for ${principal} stopped at ${resolved.closure.length} principals ` +
        '(depth/size/time bound). Privileges from any deeper nested group are not shown.',
      );
    }
  }

  const unmodeled = new Set<string>();
  const assignments = resolveEffectivePermissions(nodes, {
    principal: principal || undefined,
    principalClosure: closure,
    oss,
    onNotApplicable: (privilege, from) => {
      // A privilege Loom does not model at all (rather than one the child type
      // legitimately rejects) would otherwise vanish without trace.
      if (!ucKnownPrivilege(privilege)) unmodeled.add(`${privilege} (granted on ${from.type} ${from.name})`);
    },
  });
  if (unmodeled.size) {
    warnings.push(
      `Loom does not model ${[...unmodeled].sort().join(', ')}, so ${unmodeled.size === 1 ? 'it was' : 'they were'} ` +
      'omitted from the inherited answer. Read the securable\'s direct grants (untick "Effective") to see it verbatim.',
    );
  }
  if (oss) {
    warnings.push(
      'Answered on the Loom Unity (OSS Unity Catalog) backend, whose privilege vocabulary omits ' +
      'MANAGE / BROWSE / APPLY TAG — so ownership of a PARENT securable confers nothing here, and ' +
      'those privileges are never reported.',
    );
  }

  return {
    privilege_assignments: assignments,
    ...(warnings.length ? { warnings } : {}),
    ...(closure ? { principal_closure: closure, closure_resolved: closureResolved } : {}),
  };
}
