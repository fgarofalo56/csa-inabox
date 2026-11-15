package ai.loom.health.fhir.audit;

/**
 * Destination of the one-record-per-interaction audit trail. Implementations must not throw
 * for a transient failure (log and continue): the interaction has already been decided.
 * W8-4 ships the hourly immutable, SHA-256-chained blobs from the store this feeds.
 */
public interface AuditSink {
  void emit(AuditRecord record, String auditEventJson);
}
