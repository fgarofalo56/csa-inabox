package ai.loom.health.fhir.partition;

import ca.uhn.fhir.jpa.partition.IPartitionLookupSvc;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Registered through META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports, so the starter loads it
 * from the plugin jar on {@code /app/extra-classes}. The reconcile runs in {@link SmartInitializingSingleton}, i.e. after every
 * singleton exists (the JPA schema is created when the EntityManagerFactory is built) and BEFORE the web server accepts a
 * connection, so a pod never reports ready with its partitions missing, and an exception here stops the engine from starting.
 *
 * <p>Environment: {@code LOOM_HEALTH_PARTITIONS} (canonical JSON, see {@link DesiredPartitions}) and
 * {@code LOOM_HEALTH_PG_ADMIN_ROLE} (the stamp PG administrator role that is granted SELECT on the partition table). Both
 * unset: not reconciled, loudly. Exactly one set: startup fails.
 */
@Configuration(proxyBeanMethods = false)
public class LoomPartitionConfiguration {
  static final String ENV_PARTITIONS = "LOOM_HEALTH_PARTITIONS";
  static final String ENV_ADMIN_ROLE = "LOOM_HEALTH_PG_ADMIN_ROLE";
  private static final Logger LOG = LoggerFactory.getLogger("ai.loom.health.fhir.partition");

  @Bean
  public static SmartInitializingSingleton loomPartitionReconciler(
      ObjectProvider<IPartitionLookupSvc> lookup, ObjectProvider<DataSource> dataSource) {
    return () -> run(System.getenv(), () -> new HapiPartitionStore(lookup.getObject()), () -> new JdbcPartitionGrant(dataSource.getObject()));
  }

  /** Separated from the bean so the env handling is tested without a Spring context. */
  static void run(Map<String, String> env, Supplier<PartitionStore> store, Supplier<PartitionGrant> grant) {
    String raw = env.getOrDefault(ENV_PARTITIONS, "").trim();
    String role = env.getOrDefault(ENV_ADMIN_ROLE, "").trim();
    if (raw.isEmpty() && role.isEmpty()) {
      LOG.warn("{\"event\":\"partitions.reconcile.skipped\",\"reason\":\"{} and {} are both unset\"}", ENV_PARTITIONS, ENV_ADMIN_ROLE);
      return;
    }
    if (raw.isEmpty() || role.isEmpty()) {
      throw new IllegalStateException("partitions.reconcile.misconfigured: " + ENV_PARTITIONS + " and " + ENV_ADMIN_ROLE + " must both be set or both be unset");
    }
    List<DesiredPartition> desired = DesiredPartitions.parse(raw);
    new PartitionReconciler(store.get(), grant.get(), LOG::info).reconcile(desired, role);
  }
}
