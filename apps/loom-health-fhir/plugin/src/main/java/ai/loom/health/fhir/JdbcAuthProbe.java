package ai.loom.health.fhir;

import java.util.Properties;

/**
 * Build/verify-time probe only (never referenced by the server): proves the Entra JDBC auth plugin that
 * the image bakes into /app/extra-classes can be loaded, links against the pgjdbc the server ships, and
 * can be constructed, with the class path the server really has. Prints one JSON line and exits non-zero
 * on any failure. See scripts/verify-image.sh and the tools stage of the Dockerfile.
 */
public final class JdbcAuthProbe {
  static final String PLUGIN = "com.azure.identity.extensions.jdbc.postgresql.AzurePostgresqlAuthenticationPlugin";

  private JdbcAuthProbe() {}

  public static void main(String[] args) throws Exception {
    ClassLoader cl = Thread.currentThread().getContextClassLoader();
    Class<?> plugin = Class.forName(PLUGIN, true, cl);
    Class<?> contract = Class.forName("org.postgresql.plugin.AuthenticationPlugin", true, cl);
    if (!contract.isAssignableFrom(plugin)) {
      throw new IllegalStateException(PLUGIN + " does not implement org.postgresql.plugin.AuthenticationPlugin");
    }
    // pgjdbc instantiates the plugin reflectively with a Properties argument; do the same, offline
    // (construction must not need a token).
    Object instance = plugin.getConstructor(Properties.class).newInstance(new Properties());
    System.out.println("{\"jdbc_auth_plugin\":\"" + instance.getClass().getName() + "\",\"loadable\":true}");
  }
}
