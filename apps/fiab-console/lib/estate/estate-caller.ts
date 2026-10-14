/** Build an {@link EstateCaller} from a cookie session (kept apart from the handlers so
 *  the SP route does not import session machinery it does not use). */
import { tenantScopeId, type SessionPayload } from '@/lib/auth/session';
import type { EstateCaller } from '@/lib/estate/estate-power-handlers';

/** The caller for a cookie session. `auditExtra` is empty so audit rows are unchanged. */
export function callerFromSession(session: SessionPayload): EstateCaller {
  return {
    tenantId: tenantScopeId(session),
    who: session.claims.upn || session.claims.email || session.claims.oid,
    actorOid: session.claims.oid,
    actorTid: session.claims.tid || '',
    auditExtra: {},
  };
}
