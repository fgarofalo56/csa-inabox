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
    String remoteAddr) {}
