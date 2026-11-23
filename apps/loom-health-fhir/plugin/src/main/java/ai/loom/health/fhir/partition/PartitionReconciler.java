package ai.loom.health.fhir.partition;

import java.util.List;
import java.util.Optional;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * Creates the missing desired partitions in-process, then grants SELECT on the partition table, and nothing else.
 *
 * <p>Idempotent. Never deletes or renames: a partition present under the desired id AND name is left untouched, anything
 * else that overlaps (same name other id, same id other name) is a conflict and throws {@link PartitionConflictException}.
 */
public final class PartitionReconciler {
  /** HAPI 8.12 entity {@code ca.uhn.fhir.jpa.entity.PartitionEntity} is {@code @Table(name = "HFJ_PARTITION")}; PostgreSQL folds it. */
  public static final String PARTITION_TABLE = "hfj_partition";
  /** The stamp PG administrator role name. Same shape as IDENTITY_NAME in the control plane. */
  public static final Pattern ROLE = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$");

  private final PartitionStore store;
  private final PartitionGrant grant;
  private final Consumer<String> log;

  public PartitionReconciler(PartitionStore store, PartitionGrant grant, Consumer<String> log) {
    this.store = store;
    this.grant = grant;
    this.log = log;
  }

  public void reconcile(List<DesiredPartition> desired, String adminRole) {
    if (adminRole == null || !ROLE.matcher(adminRole).matches()) {
      throw new IllegalArgumentException("the PG admin role name is missing or malformed; nothing was created and nothing was granted");
    }
    int created = 0;
    int unchanged = 0;
    for (DesiredPartition want : desired) {
      Optional<DesiredPartition> have = find(store.list(), want);
      if (have.isPresent()) {
        unchanged++;
        continue;
      }
      try {
        store.create(want);
        created++;
      } catch (PartitionConflictException e) {
        throw e;
      } catch (RuntimeException e) {
        // Two pods overlap during a rolling update: the other one may have created it between our list and our create.
        // Present under the same id and name afterwards = fine; anything else is the real failure.
        if (find(store.list(), want).isEmpty()) {
          throw e;
        }
        unchanged++;
      }
    }
    List<DesiredPartition> after = store.list();
    for (DesiredPartition want : desired) {
      if (!after.contains(want)) {
        throw new IllegalStateException("partitions.reconcile.failed: partition " + want.name() + " (id " + want.id() + ") is not present after it was created");
      }
    }
    grant.grantSelect(PARTITION_TABLE, adminRole);
    log.accept(
        "{\"event\":\"partitions.reconciled\",\"desired\":" + desired.size() + ",\"created\":" + created + ",\"unchanged\":" + unchanged
            + ",\"grantedSelectOn\":\"" + PARTITION_TABLE + "\",\"grantee\":\"" + adminRole + "\"}");
  }

  private Optional<DesiredPartition> find(List<DesiredPartition> existing, DesiredPartition want) {
    for (DesiredPartition p : existing) {
      boolean sameId = p.id() == want.id();
      boolean sameName = p.name().equals(want.name());
      if (sameId && sameName) {
        return Optional.of(p);
      }
      if (sameId || sameName) {
        String msg = "partitions.conflict: desired partition " + want.name() + " (id " + want.id() + ") collides with an existing partition "
            + p.name() + " (id " + p.id() + "); the engine never renames or deletes a partition, so it will not start";
        log.accept("{\"event\":\"partitions.conflict\",\"desiredId\":" + want.id() + ",\"desiredName\":\"" + want.name()
            + "\",\"existingId\":" + p.id() + ",\"existingName\":\"" + p.name() + "\"}");
        throw new PartitionConflictException(msg);
      }
    }
    return Optional.empty();
  }
}
