package ai.loom.health.fhir.partition;

/** Grants read access on the partition table to the stamp PG administrator role. */
public interface PartitionGrant {
  /** {@code GRANT SELECT} on {@code table} to {@code role}, and nothing else. */
  void grantSelect(String table, String role);
}
