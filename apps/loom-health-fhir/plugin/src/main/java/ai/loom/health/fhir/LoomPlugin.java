package ai.loom.health.fhir;

/**
 * Loom plugin jar for the HAPI FHIR JPA server (LHDS W2-1).
 *
 * <p>SKELETON. This jar is on the server class path (/app/extra-classes) so that the
 * module layout, build and load path are proven, but it registers NO interceptor and
 * changes NO server behaviour. The PDP/authorization and audit interceptors arrive in
 * W2-3 under {@code ai.loom.health.fhir.pdp} and {@code ai.loom.health.fhir.audit}.
 * {@link #registeredInterceptors()} returns an empty list on purpose and must keep
 * doing so until W2-3 lands real ones; do not add placeholder entries.
 */
public final class LoomPlugin {

  /** Plugin ABI marker; W2-3 bumps it when the first interceptor is registered. */
  public static final String PLUGIN_VERSION = "0.1.0-skeleton";

  private LoomPlugin() {}

  /** Names of the interceptors this jar registers. Empty in W2-1 (see class doc). */
  public static String[] registeredInterceptors() {
    return new String[0];
  }

  /**
   * Load probe used by the image build and verify-image.sh:
   * {@code java -cp <plugin.jar> ai.loom.health.fhir.LoomPlugin}.
   */
  public static void main(String[] args) {
    System.out.println(
        "{\"plugin\":\"loom-health-fhir\",\"version\":\"" + PLUGIN_VERSION
            + "\",\"interceptors\":" + registeredInterceptors().length + "}");
  }
}
