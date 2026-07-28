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
import {
  ucSecurableChain, resolveEffectivePermissions, expandPrincipalClosure,
  type UcSecurableNode, type UcDirectGroupsResolver, type UCEffectivePermissions,
} from '@/lib/azure/uc-effective-permissions';

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
 * permission on a parent). A failure becomes a `warnings[]` entry and the walk
 * continues, because "here are the grants I can see, and I could not read that
 * ancestor" is a truthful answer where a 502 is not.
 */
export async function computeEffectivePermissions(
  host: string,
  secType: UCSecurableType,
  securableName: string,
  opts?: { principal?: string },
): Promise<UCEffectivePermissions> {
  const refs = ucSecurableChain(secType, securableName);
  const warnings: string[] = [];

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
    };
  }));

  const principal = (opts?.principal || '').trim();
  let closure: string[] | undefined;
  if (principal) {
    // Lazy import: Microsoft Graph is only touched when a principal filter is
    // actually used, so the common "show everyone's effective grants" path never
    // pulls in the identity client or its credential chain.
    let directGroups: UcDirectGroupsResolver = async () => [];
    try {
      const mod = await import('@/lib/azure/graph-identity-client');
      directGroups = (name: string) => mod.getPrincipalDirectGroups(name);
    } catch (e) {
      warnings.push(`Group membership could not be expanded: ${(e as Error)?.message || String(e)}`);
    }
    let membershipFailed = false;
    const resolved = await expandPrincipalClosure(principal, directGroups, {
      onError: (p, e) => {
        if (membershipFailed) return;   // one honest line, not one per principal
        membershipFailed = true;
        warnings.push(
          `Group membership for ${p} could not be read from Microsoft Entra ` +
          `(${(e as Error)?.message || String(e)}), so only privileges granted directly to ` +
          `${principal} are shown. Set LOOM_IDENTITY_PICKER_ENABLED=true on the Console and grant ` +
          'the Console UAMI Graph Group.Read.All + User.Read.All ' +
          '(scripts/csa-loom/grant-identity-graph-approles.sh, then admin-consent).',
        );
      },
    });
    closure = resolved.closure;
    if (resolved.truncated) {
      warnings.push(
        `The group-membership walk for ${principal} stopped at ${resolved.closure.length} principals ` +
        '(depth/size bound). Privileges from any deeper nested group are not shown.',
      );
    }
  }

  const assignments = resolveEffectivePermissions(nodes, { principal: principal || undefined, principalClosure: closure });
  return {
    privilege_assignments: assignments,
    ...(warnings.length ? { warnings } : {}),
    ...(closure ? { principal_closure: closure } : {}),
  };
}
