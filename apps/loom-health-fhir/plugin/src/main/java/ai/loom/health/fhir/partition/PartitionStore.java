package ai.loom.health.fhir.partition;

import java.util.List;

/** The partitions that exist, and the one write the reconciler may make: create. There is deliberately no delete or rename. */
public interface PartitionStore {
  List<DesiredPartition> list();

  void create(DesiredPartition partition);
}
