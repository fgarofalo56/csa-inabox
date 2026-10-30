/** Maps the signed-in session to the audit actor for plane admin routes (W1-2). */
import type { SessionPayload } from '@/lib/auth/session';
import { tenantScopeId } from '@/lib/auth/session';
import type { Actor } from './gateway-service';

export function actorFromSession(session: SessionPayload): Actor {
  return {
    tenantId: tenantScopeId(session),
    who: session.claims.upn || session.claims.name || session.claims.oid,
    actorOid: session.claims.oid,
    // W1-8 introduces the apiplane-admin capability; until then routes are tenant-admin only.
    capability: 'tenant-admin',
  };
}
