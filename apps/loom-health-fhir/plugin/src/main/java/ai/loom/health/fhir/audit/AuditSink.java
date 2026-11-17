package ai.loom.health.fhir.audit;

/**
 * Destination of the one-record-per-interaction audit trail. An implementation MUST throw a
 * {@link RuntimeException} when it could not record (never log-and-continue): the composite from
 * {@link AuditSinks#all} counts and alerts the failure ({@link AuditHealth}) and keeps going with the
 * other sinks, because the interaction has already been decided.
 * W8-4 ships the hourly immutable, SHA-256-chained blobs from the store this feeds.
 */
public interface AuditSink {
  void emit(AuditRecord record, String auditEventJson);
}
