// Scope-grant computation: requested INTERSECT role ceilings INTERSECT the
// client's registered scopes (security.md A4). The single place a grant is
// decided, for the code flow, refresh and client credentials alike.

import { ceilingsFor } from './role-map.js';
import {
  INTROSPECT_SCOPE,
  compartmentAllowed,
  intersectWithCeilings,
  parseDataScope,
  serializeScope,
  type DataScope,
  type GrantType,
  type ParsedRequest,
} from './scopes.js';

const CONTEXT_ALLOWED: Record<GrantType, readonly string[]> = {
  authorization_code: ['openid', 'fhirUser', 'launch', 'launch/patient', 'offline_access'],
  client_credentials: [INTROSPECT_SCOPE],
};

export interface GrantInput {
  grant: GrantType;
  request: ParsedRequest;
  roleIds: readonly string[];
  /** The client registration's allowed scopes (v2 form). Unparseable entries grant nothing. */
  clientAllowed: readonly string[];
  patient?: string;
  fhirUserResolved: boolean;
  /** The client is a backend client an admin flagged `introspect: true` (#5516). Absent => never granted. */
  introspectAllowed?: boolean;
}

export interface GrantResult {
  data: DataScope[];
  /** Data scopes (v2) followed by granted context scopes. */
  scope: string[];
}

export function computeGrant(i: GrantInput): GrantResult {
  const requested = i.request.data.filter((s) => compartmentAllowed(s.compartment, i.grant));
  const byRole = intersectWithCeilings(requested, ceilingsFor(i.roleIds, i.grant));
  const allowed = i.clientAllowed.map((r) => parseDataScope(r, { v1: false })).filter((x): x is DataScope => !!x);
  let data = intersectWithCeilings(byRole, allowed);
  // patient/ scopes need an established patient context; otherwise they are dropped (A3).
  if (!i.patient) data = data.filter((s) => s.compartment !== 'patient');

  const ctx = i.request.context.filter((c) => {
    if (!CONTEXT_ALLOWED[i.grant].includes(c)) return false;
    if (c === 'fhirUser') return i.fhirUserResolved;
    if (c === 'launch/patient') return !!i.patient;
    if (c === 'offline_access') return data.length > 0;
    if (c === INTROSPECT_SCOPE) return i.introspectAllowed === true;
    return true;
  });
  return { data, scope: [...data.map(serializeScope), ...ctx] };
}
