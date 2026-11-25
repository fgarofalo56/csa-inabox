package ai.loom.health.fhir.partition;

import ca.uhn.fhir.rest.server.RestfulServer;
import ca.uhn.fhir.rest.server.tenant.ITenantIdentificationStrategy;
import ca.uhn.fhir.rest.server.tenant.UrlBaseTenantIdentificationStrategy;
import java.lang.reflect.Field;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Replaces the starter's {@link UrlBaseTenantIdentificationStrategy} with {@link LoomTenantIdentificationStrategy}
 * (#5489). Registered through META-INF/spring/...AutoConfiguration.imports, like {@link LoomPartitionConfiguration}.
 *
 * <p>Ordering, read from the pinned image (hapiproject/hapi 8.12.0, main.war, javap): the starter does NOT set the
 * strategy in the RestfulServer bean method. It sets it in the CONSTRUCTOR of
 * {@code ca.uhn.fhir.jpa.starter.common.PartitionModeConfigurer}, a non-lazy {@code @Component}
 * ({@code @Conditional(OnPartitionModeEnabled)}) that takes the RestfulServer bean as a constructor argument. A
 * BeanPostProcessor on RestfulServer would therefore run BEFORE the starter overwrote it. A
 * {@link SmartInitializingSingleton} runs after EVERY non-lazy singleton exists, so after that constructor, and before
 * the embedded web server accepts a connection.
 *
 * <p>RestfulServer has a setter but no getter for the strategy, so the current one is read reflectively from its
 * private field. FAILS CLOSED: if the field cannot be read (a HAPI bump renamed it), if the current strategy is one
 * this class does not recognise, or if the read-back after the set is not ours, the engine does not start.
 * Partitioning off (no strategy at all) is left alone and logged. The strategy's companion
 * {@link ImpliedDefaultPathInterceptor} (search-Bundle self links at the bare base) is registered here too, once.
 *
 * <p>Live witness: config/probe/engine-config-probe.sh C11a greps the line this logs on the pinned image, which names the
 * class it replaced; "skipped" (the plugin ran before the starter) or any other class fails it.
 */
@Configuration(proxyBeanMethods = false)
public class LoomTenantStrategyConfiguration {
  static final String FIELD = "myTenantIdentificationStrategy";
  private static final Logger LOG = LoggerFactory.getLogger("ai.loom.health.fhir.partition");

  @Bean
  public static SmartInitializingSingleton loomTenantStrategyInstaller(ObjectProvider<RestfulServer> server) {
    return () -> {
      RestfulServer rs = server.getIfAvailable();
      if (rs == null) {
        throw new IllegalStateException("tenant-strategy.install-failed: no RestfulServer bean in the context");
      }
      LOG.info(install(rs));
    };
  }

  /** Returns the JSON log line; throws when the engine must not start. Separated so it is tested without Spring. */
  public static String install(RestfulServer rs) {
    ITenantIdentificationStrategy current = current(rs);
    if (current == null) {
      return "{\"event\":\"tenant-strategy.skipped\",\"reason\":\"request tenant partitioning is off\"}";
    }
    if (current instanceof LoomTenantIdentificationStrategy) {
      registerPathInterceptor(rs);
      return "{\"event\":\"tenant-strategy.installed\",\"replaced\":\"none\"}";
    }
    if (current.getClass() != UrlBaseTenantIdentificationStrategy.class) {
      throw new IllegalStateException("tenant-strategy.install-failed: unexpected strategy "
          + current.getClass().getName() + "; refusing to replace a strategy this plugin does not know");
    }
    rs.setTenantIdentificationStrategy(new LoomTenantIdentificationStrategy());
    ITenantIdentificationStrategy after = current(rs);
    if (!(after instanceof LoomTenantIdentificationStrategy)) {
      throw new IllegalStateException("tenant-strategy.install-failed: read-back is "
          + (after == null ? "null" : after.getClass().getName()));
    }
    registerPathInterceptor(rs);
    return "{\"event\":\"tenant-strategy.installed\",\"replaced\":\"" + current.getClass().getName() + "\"}";
  }

  /** The strategy's companion (see {@link ImpliedDefaultPathInterceptor}); registered at most once per server. */
  private static void registerPathInterceptor(RestfulServer rs) {
    boolean present = rs.getInterceptorService().getAllRegisteredInterceptors().stream()
        .anyMatch(i -> i instanceof ImpliedDefaultPathInterceptor);
    if (!present) {
      rs.getInterceptorService().registerInterceptor(new ImpliedDefaultPathInterceptor());
    }
  }

  public static ITenantIdentificationStrategy current(RestfulServer rs) {
    try {
      Field f = RestfulServer.class.getDeclaredField(FIELD);
      f.setAccessible(true);
      return (ITenantIdentificationStrategy) f.get(rs);
    } catch (ReflectiveOperationException | RuntimeException e) {
      throw new IllegalStateException("tenant-strategy.install-failed: cannot read RestfulServer." + FIELD
          + " (HAPI version changed?): " + e, e);
    }
  }
}
