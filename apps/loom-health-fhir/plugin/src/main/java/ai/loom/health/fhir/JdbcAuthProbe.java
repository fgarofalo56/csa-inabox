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
    // Link check, offline: the baked reactor-netty 1.3.7 / netty 4.2.19 must link against the reactor-core the
    // war ships, and the workload identity credential (what AZURE_CLIENT_ID + the projected token select) must
    // build. Neither makes a network call; dummy values only.
    Object http = Class.forName("com.azure.core.http.netty.NettyAsyncHttpClientBuilder", true, cl)
        .getConstructor().newInstance();
    Object client = http.getClass().getMethod("build").invoke(http);
    Class<?> wic = Class.forName("com.azure.identity.WorkloadIdentityCredentialBuilder", true, cl);
    Object b = wic.getConstructor().newInstance();
    wic.getMethod("tenantId", String.class).invoke(b, "00000000-0000-0000-0000-000000000000");
    wic.getMethod("clientId", String.class).invoke(b, "00000000-0000-0000-0000-000000000001");
    wic.getMethod("tokenFilePath", String.class).invoke(b, "/nonexistent/token");
    Object cred = wic.getMethod("build").invoke(b);
    Class<?> flux = Class.forName("reactor.core.publisher.Flux", true, cl);
    String reactorJar = String.valueOf(flux.getProtectionDomain().getCodeSource().getLocation());
    System.out.println("{\"jdbc_auth_plugin\":\"" + instance.getClass().getName() + "\",\"loadable\":true,"
        + "\"http_client\":\"" + client.getClass().getName() + "\","
        + "\"credential\":\"" + cred.getClass().getSimpleName() + "\","
        + "\"reactor_core\":\"" + jarName(reactorJar) + "\"}");
  }

  /** Last "*.jar" segment of a code-source URL (a nested war URL ends in "!/", so a plain basename is empty). */
  static String jarName(String url) {
    int end = url.lastIndexOf(".jar");
    return end < 0 ? url : url.substring(url.lastIndexOf('/', end) + 1, end + 4);
  }
}
