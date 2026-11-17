package ai.loom.health.fhir.audit;

/**
 * No audit sink accepted a record. Carries no detail on purpose: the interceptor maps it to a 503
 * with a fixed message, and the per-sink cause is already counted and alerted by {@link AuditHealth}.
 */
public final class AuditLostException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  AuditLostException() {
    super("no audit sink accepted the record");
  }
}
