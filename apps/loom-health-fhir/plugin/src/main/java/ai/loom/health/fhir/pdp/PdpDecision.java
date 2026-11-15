package ai.loom.health.fhir.pdp;

/**
 * What the PDP answered (frozen contract: CONTRACT-FREEZE-W2.md section 1).
 * Only {@code allow == true} permits; there is deliberately no "unknown" state here:
 * a missing result, a timeout or a 5xx is a {@link PdpUnavailableException}, not a decision.
 */
public record PdpDecision(boolean allow, String reason, String policyVersion) {}
