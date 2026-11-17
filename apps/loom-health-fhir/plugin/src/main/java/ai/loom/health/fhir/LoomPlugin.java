package ai.loom.health.fhir;

import ai.loom.health.fhir.audit.AuditSink;
import ai.loom.health.fhir.audit.LoomAuditInterceptor;
import ai.loom.health.fhir.pdp.LoomPdpInterceptor;
import ai.loom.health.fhir.pdp.PdpClient;
import ai.loom.health.fhir.pdp.PluginConfig;
import ca.uhn.fhir.interceptor.api.IInterceptorService;

/**
 * Loom plugin jar for the HAPI FHIR JPA server (LHDS W2-3).
 *
 * <p>Two interceptors, in this order: {@link LoomPdpInterceptor} (authorization + response
 * filtering) then {@link LoomAuditInterceptor} (one AuditEvent per interaction). In the HAPI
 * starter they are listed by class name in {@code hapi.fhir.custom-interceptor-classes}; both
 * have no-arg constructors that read {@link PluginConfig}. {@link #register} is the programmatic
 * path (used by the tests) and the single place that defines the pair.
 */
public final class LoomPlugin {

  /** Plugin ABI marker: bumped when the first interceptors landed (W2-3). */
  public static final String PLUGIN_VERSION = "0.2.0";

  private LoomPlugin() {}

  /** Class names to put in {@code hapi.fhir.custom-interceptor-classes}, in registration order. */
  public static String[] registeredInterceptors() {
    // Literals, not Class.getName(): the load probe runs without HAPI on the class path and must
    // not link the interceptor classes. LoomPluginTest pins these equal to the real class names.
    return new String[] {
      "ai.loom.health.fhir.pdp.LoomPdpInterceptor", "ai.loom.health.fhir.audit.LoomAuditInterceptor"
    };
  }

  /** Register both interceptors on a server's interceptor service. */
  public static void register(IInterceptorService svc, PdpClient pdp, PluginConfig config, AuditSink sink) {
    svc.registerInterceptor(new LoomPdpInterceptor(pdp, config));
    svc.registerInterceptor(new LoomAuditInterceptor(sink, config));
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
