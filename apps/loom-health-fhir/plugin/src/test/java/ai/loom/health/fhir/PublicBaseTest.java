package ai.loom.health.fhir;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.loom.health.fhir.pdp.PluginConfig;
import ca.uhn.fhir.interceptor.api.Hook;
import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.HardcodedServerAddressStrategy;
import ca.uhn.fhir.rest.server.RestfulServer;
import ca.uhn.fhir.rest.server.tenant.UrlBaseTenantIdentificationStrategy;
import java.time.Duration;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.List;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * #5422 decision 13: {@code request.base} is the tenant's PUBLIC FHIR base (the configured server address), never the
 * URL as received and never with the facility partition. authz.rego aud_ok compares it exactly with the token aud.
 * Each engine here is a real HAPI RestfulServer mounted at /fhir with URL-base partitioning ON, as the CP renders it.
 */
class PublicBaseTest {
  static final String PUBLIC = "https://edge.example/acme/fhir";
  static FakePdp pdp;

  @BeforeAll
  static void up() throws Exception {
    pdp = new FakePdp(InterceptorTest.ROOT.resolve("apps/loom-health-pdp/policies/lhds/interactions/data.json"));
  }

  @AfterAll
  static void down() throws Exception {
    pdp.close();
  }

  @BeforeEach
  void reset() {
    pdp.reset(FakePdp.Mode.NORMAL);
  }

  /** Records what HAPI itself computed, to MEASURE (not assume) whether it appends the partition. */
  public static final class RawBaseProbe {
    final List<String> seen = new CopyOnWriteArrayList<>();

    @Hook(Pointcut.SERVER_INCOMING_REQUEST_PRE_HANDLED)
    public void pre(RequestDetails rd) {
      seen.add(rd.getFhirServerBase());
    }
  }

  private EngineHarness engine(String address, RawBaseProbe probe) throws Exception {
    PluginConfig cfg = new PluginConfig("", Duration.ofMillis(300), EngineHarness.TENANT, "", false);
    return new EngineHarness(EngineHarness.clientFor(pdp, 300), true, cfg, "/fhir", rs -> {
      rs.setTenantIdentificationStrategy(new UrlBaseTenantIdentificationStrategy());
      if (address != null) {
        rs.setServerAddressStrategy(new HardcodedServerAddressStrategy(address));
      }
      if (probe != null) {
        rs.getInterceptorService().registerInterceptor(probe);
      }
    });
  }

  @Test
  void aPartitionedRequestSendsExactlyTheConfiguredBaseWithNoFacilitySegment() throws Exception {
    // BREAKS when: the plugin sends rd.getFhirServerBase() (HAPI appends "/facility-a": the base would be
    // PUBLIC + "/facility-a"), the in-cluster URL as received, or any string other than PUBLIC byte for byte.
    RawBaseProbe probe = new RawBaseProbe();
    try (EngineHarness e = engine(PUBLIC, probe)) {
      String[] r = e.call("GET", "/facility-a/Patient/p1", InterceptorTest.token("acme", "user/*.rs", ""), null, null);
      assertEquals("200", r[0], r[1]); // positive same-tenant control: the base was accepted and the engine ran
      assertTrue(r[1].contains("\"id\":\"p1\""), r[1]);
      assertEquals(1, e.handlerCalls.get());
      assertEquals(PUBLIC, pdp.inputs.get(0).get("request").get("base").asText());
      // The measurement behind the fix: HAPI's own base DOES carry the partition once the strategy is on.
      assertEquals(PUBLIC + "/facility-a", probe.seen.get(0), "HAPI appends the partition segment to getFhirServerBase()");
      e.awaitAudits(1);
    }
  }

  @Test
  void theBaseIsTheSameForEveryFacilityAndHasNoTrailingSlash() throws Exception {
    // BREAKS when: the base varies with the facility segment, or the configured trailing slash is passed through
    // (a bundle base has none, so aud_ok would be false for every request).
    try (EngineHarness e = engine(PUBLIC + "/", null)) {
      for (String facility : List.of("facility-a", "facility-b")) {
        String[] r = e.call("GET", "/" + facility + "/Patient/p1", InterceptorTest.token("acme", "user/*.rs", ""), null, null);
        assertEquals("200", r[0], r[1]);
      }
      assertEquals(2, pdp.inputs.size());
      for (var in : pdp.inputs) {
        assertEquals(PUBLIC, in.get("request").get("base").asText());
      }
      assertFalse(pdp.inputs.get(0).get("request").get("base").asText().endsWith("/"));
      e.awaitAudits(2);
    }
  }

  /** A token whose aud is set, built like InterceptorTest.token (unsigned, run-time only). */
  static String tokenWithAud(String aud) throws Exception {
    var e = java.util.Base64.getUrlEncoder().withoutPadding();
    String h = e.encodeToString("{\"alg\":\"none\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
    String p = e.encodeToString(InterceptorTest.JSON.writeValueAsBytes(java.util.Map.of(
        "tenant", "acme", "scope", "user/*.rs", "patient", "", "sub", "u-1", "client_id", "c-1", "aud", aud)));
    return h + "." + p + ".sig";
  }

  @Test
  void anEngineWithNoPinnedAddressNeverAuthorizesOnARequestDerivedBase() throws Exception {
    // BREAKS when: publicBase falls back to the request-derived base (Host / X-Forwarded-*): the token below names
    // exactly the as-received base, so the PDP would see aud == base and answer 200 instead of 403.
    try (EngineHarness e = engine(null, null)) {
      String[] denied = e.call("GET", "/facility-a/Patient/p1", tokenWithAud(e.base), null, null);
      assertEquals("403", denied[0], denied[1]);
      assertEquals("", pdp.inputs.get(0).get("request").get("base").asText());
      assertEquals(0, e.handlerCalls.get(), "a denied request must not reach the engine");
      e.awaitAudits(1);
    }
    // Positive pair: the SAME token shape on a pinned engine, aud = the pinned base, reaches the engine.
    try (EngineHarness e = engine(PUBLIC, null)) {
      reset();
      String[] ok = e.call("GET", "/facility-a/Patient/p1", tokenWithAud(PUBLIC), null, null);
      assertEquals("200", ok[0], ok[1]);
      assertEquals(PUBLIC, pdp.inputs.get(0).get("request").get("base").asText());
      assertEquals(1, e.handlerCalls.get());
      e.awaitAudits(1);
    }
  }
}
