package ai.loom.health.fhir.partition;

/**
 * The database already holds a partition that disagrees with the desired list: the same name under another id, or the
 * same id under another name. The reconciler never renames or deletes, so this stops the engine from starting.
 */
public final class PartitionConflictException extends IllegalStateException {
  public PartitionConflictException(String message) {
    super(message);
  }
}
