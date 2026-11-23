package ai.loom.health.fhir.partition;

/** One partition the control plane wants to exist: HAPI partition id and name. */
public record DesiredPartition(int id, String name) {}
