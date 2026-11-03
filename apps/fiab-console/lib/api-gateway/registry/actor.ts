/** Maps the signed-in session to the audit actor for plane admin routes (W1-2). */
import type { SessionPayload } from '@/lib/auth/session';
import { tenantScopeId } from '@/lib/auth/session';
import { planeCapabilityUsed } from '@/lib/api-gateway/admin-gate';
import type { Actor } from './gateway-service';

export function actorFromSession(session: SessionPayload): Actor {
  return {
    tenantId: tenantScopeId(session),
    who: session.claims.upn || session.claims.name || session.claims.oid,
    actorOid: session.claims.oid,
    // Q9 (W1-8): 'tenant-admin' for a tenant admin, otherwise 'apiplane-admin'.
    capability: planeCapabilityUsed(session),
  };
}
