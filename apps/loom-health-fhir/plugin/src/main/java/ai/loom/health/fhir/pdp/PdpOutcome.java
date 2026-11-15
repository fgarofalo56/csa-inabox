package ai.loom.health.fhir.pdp;

import java.util.List;

/**
 * Per-request record the authorization interceptor leaves in {@code RequestDetails.userData}
 * for the audit interceptor. Holds NO token and NO request/response body.
 *
 * @param decision {@code permit}, {@code deny} or {@code error} (PDP unavailable, 503)
 * @param status HTTP status the authorization step chose (0 = it let the request through)
 */
public record PdpOutcome(
    String tenant,
    String interaction,
    String resourceType,
    String resourceId,
    String op,
    List<String> compartment,
    String decision,
    String reason,
    String policyVersion,
    int status,
    String subject,
    String clientId) {

  public static final String KEY = "ai.loom.health.fhir.pdp.outcome";
}
