package ai.loom.health.fhir.audit;

import java.util.List;

/**
 * One audited interaction. This is the flat row for the {@code LhdsAudit_CL} custom table and
 * the input of the FHIR {@code AuditEvent}. It never carries a token, a request body, a
 * response body or query VALUES (search values are PHI); {@code paramNames} lists names only.
 *
 * @param decision {@code permit} | {@code deny} | {@code error} | {@code none} (no PDP interceptor ran)
 * @param status HTTP status when known (>= 400), else 0 meaning the interaction was let through and
 *     did not raise an error
 * @param remoteAddr the CLIENT address: the forwarded-header address only when the TCP peer is a
 *     configured trusted proxy ({@code TrustedProxies}), else the TCP peer itself
 * @param patientsReturned Patient ids whose resources the response filter kept (ids, never bodies)
 * @param patientsHidden Patient ids whose resources the response filter removed or refused
 * @param hiddenResourceCount how many resources the filter removed or refused, including unbound
 *     ones that name no patient (capped id lists never under-report this count)
 */
public record AuditRecord(
    String requestId,
    String recorded,
    String tenant,
    String interaction,
    String resourceType,
    String resourceId,
    String op,
    List<String> patient,
    List<String> paramNames,
    String decision,
    String reason,
    String policyVersion,
    int status,
    String subject,
    String clientId,
    String remoteAddr,
    List<String> patientsReturned,
    List<String> patientsHidden,
    int hiddenResourceCount) {}
