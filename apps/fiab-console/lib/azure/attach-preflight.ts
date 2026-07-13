/**
 * attach-preflight — the real reachability / RBAC / network-posture check a
 * brownfield attach runs before registering a service (§2.2 step 3, §2.3).
 *
 * Honest results, no fakes (no-vaporware.md): each pick gets a control-plane GET
 * (reachability), the exact navigator role the Console UAMI needs at the exact
 * scope (RBAC — computed from the same role-GUID map BYO uses; the actual PUT is
 * Phase 2's role-grant-client), and a network-posture read
 * (publicNetworkAccess / privateEndpointConnections) so a PE-locked brownfield
 * resource is flagged instead of silently failing later.
 *
 * The posture derivation is pure (unit-testable); the route supplies the ARM GET.
 */
import { getKindDef, type AttachedServiceKind } from './attached-service-kinds';
import type {
  Reachability,
  RbacState,
  NetworkPosture,
  AttachedServiceValidation,
} from './attached-services-store';

/** One preflight verdict for one candidate resource. */
export interface PreflightResult {
  armResourceId: string;
  kind: AttachedServiceKind;
  reachability: Reachability;
  networkPosture: NetworkPosture;
  rbacState: RbacState;
  /** The navigator role the Console UAMI needs (human name) + its GUID + scope. */
  rbacRoleName: string;
  rbacRoleGuid: string;
  rbacScope: string;
  /** True when the attach can proceed cleanly (reachable, public/PE-ok). */
  ok: boolean;
  /** Honest remediation for any non-green signal (null when all green). */
  remediation: string | null;
}

/**
 * Derive network posture from an ARM resource `properties` bag. Different RPs
 * spell public access differently (`publicNetworkAccess`, `networkAcls.
 * defaultAction`), and private endpoints surface as `privateEndpointConnections`.
 * Returns the best honest posture we can read.
 */
export function deriveNetworkPosture(properties: any): NetworkPosture {
  if (!properties || typeof properties !== 'object') return 'unknown';
  const pna = String(properties.publicNetworkAccess ?? '').toLowerCase();
  const aclDefault = String(properties.networkAcls?.defaultAction ?? '').toLowerCase();

  // Public access explicitly disabled → the resource is private-endpoint-only;
  // its data plane is only reachable through a PE + private DNS path.
  if (pna === 'disabled') return 'private-endpoint';
  // Selected-networks firewall (defaultAction Deny) without public disabled → a
  // service-endpoint / IP-allowlist posture, reachable from allowed networks.
  if (aclDefault === 'deny') return 'service-endpoint';
  // Public access on (or unspecified) → publicly reachable, even if a PE exists.
  if (pna === 'enabled' || pna === '') return 'public';
  return 'unknown';
}

/**
 * Compose the full preflight verdict from the control-plane GET outcome + the
 * posture. `reachable` is the HTTP result of the ARM GET; `properties` is the
 * resource's property bag (for posture). PURE — the route does the fetch.
 */
export function composePreflight(
  armResourceId: string,
  kind: AttachedServiceKind,
  getOutcome: { status: number; properties?: any; error?: string },
): PreflightResult {
  const def = getKindDef(kind);
  const rbacRoleName = def?.roleName ?? 'Contributor';
  const rbacRoleGuid = def?.roleGuid ?? 'b24988ac-6180-42a0-ab88-20f7382dd24c';

  const posture = deriveNetworkPosture(getOutcome.properties);
  const remediations: string[] = [];

  // Reachability from the control-plane GET.
  let reachability: Reachability;
  if (getOutcome.status >= 200 && getOutcome.status < 300) {
    // Control plane reachable. If the resource is PE-locked, the DATA plane may
    // not be reachable from the hub VNet — flag it honestly rather than claim
    // full reachability (the PE remediation is Phase 3).
    if (posture === 'private-endpoint') {
      reachability = 'private-endpoint-needed';
      remediations.push(
        'This resource is private-endpoint / public-access-disabled. Loom can register it now, ' +
        'but a navigator can only reach its data plane once the hub VNet has a private-endpoint + ' +
        'private-DNS path to it (guided PE remediation is Phase 3). Until then it will honest-gate ' +
        'at data-plane calls.',
      );
    } else {
      reachability = 'reachable';
    }
  } else if (getOutcome.status === 403) {
    reachability = 'blocked';
    remediations.push(
      'The Console identity got 403 reading this resource. Grant it Reader (or the navigator role ' +
      'below) so preflight can confirm reachability.',
    );
  } else if (getOutcome.status === 404) {
    reachability = 'blocked';
    remediations.push('The resource id was not found (404). Confirm it still exists and the id is correct.');
  } else {
    reachability = 'unknown';
    if (getOutcome.error) remediations.push(`Reachability check could not complete: ${getOutcome.error}`);
  }

  // RBAC — Phase 1 reports the exact role + scope the UAMI needs; the auto-grant
  // (or the honest grant-script gate) is Phase 2. We never claim 'granted' here.
  const rbacState: RbacState = 'pending';
  remediations.push(
    `The Console UAMI needs the "${rbacRoleName}" role on this resource (scope: ${armResourceId}). ` +
    'Attach records the requirement; granting it is the next step (Phase 2 auto-grant, or run the ' +
    'grant script shown on the receipt).',
  );

  const ok = reachability === 'reachable';
  return {
    armResourceId,
    kind,
    reachability,
    networkPosture: posture,
    rbacState,
    rbacRoleName,
    rbacRoleGuid,
    rbacScope: armResourceId,
    ok,
    remediation: remediations.length ? remediations.join(' ') : null,
  };
}

/** Project a preflight verdict onto the registry `validation` shape. */
export function preflightToValidation(p: PreflightResult): AttachedServiceValidation {
  return {
    reachability: p.reachability,
    rbacState: p.rbacState,
    networkPosture: p.networkPosture,
    rbacRoleName: p.rbacRoleName,
    rbacScope: p.rbacScope,
    checkedAt: new Date().toISOString(),
    remediation: p.remediation ?? undefined,
  };
}
