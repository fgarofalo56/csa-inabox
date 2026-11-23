package ai.loom.health.fhir.partition;

import ca.uhn.fhir.jpa.entity.PartitionEntity;
import ca.uhn.fhir.jpa.partition.IPartitionLookupSvc;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import java.util.List;

/** HAPI's own partition service, called in-process (no HTTP, so no interceptor authorization path is involved). */
public final class HapiPartitionStore implements PartitionStore {
  private final IPartitionLookupSvc svc;

  public HapiPartitionStore(IPartitionLookupSvc svc) {
    this.svc = svc;
  }

  @Override
  public List<DesiredPartition> list() {
    // Read the table, not the service's cache: a concurrent pod's create must be visible.
    svc.invalidateCaches();
    return svc.listPartitions().stream().map(p -> new DesiredPartition(p.getId(), p.getName())).toList();
  }

  @Override
  public void create(DesiredPartition p) {
    PartitionEntity e = new PartitionEntity();
    e.setId(p.id());
    e.setName(p.name());
    svc.createPartition(e, new SystemRequestDetails());
  }
}
