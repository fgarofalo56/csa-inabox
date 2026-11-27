package ai.loom.health.fhir;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.loom.health.fhir.pdp.PluginConfig;
import ca.uhn.fhir.rest.server.HardcodedServerAddressStrategy;
import ca.uhn.fhir.rest.server.tenant.UrlBaseTenantIdentificationStrategy;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * SMART fhirUser self-read (Inferno smart_openid_fhir_user_claim): the plugin half. The PDP rule itself is tested in
 * apps/loom-health-pdp/tests/authz_test.rego; here the PDP is {@link FakePdp} in ALLOW_ALL mode so every request
 * reaches the engine and what is asserted is (a) the PDP input carries {@code resource_id}, and (b) the RESPONSE
 * FILTER lets through exactly the resource the token's fhirUser claim names, which a patient/-only token's scopes
 * never cover (a Practitioner has no patient compartment). Every assertion names the input that breaks it.
 */
class FhirUserSelfReadTest {
  static final String PUBLIC = "https://edge.example/acme/fhir";
  static final String SELF = PUBLIC + "/Practitioner/1000";
  static final String GRANTED = "patient/*.rs openid fhirUser";
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
    pdp.reset(FakePdp.Mode.ALLOW_ALL);
  }

  /** Unsigned, built at run time like InterceptorTest.token, plus a fhirUser claim. */
  static String token(String scope, String fhirUser) throws Exception {
    var e = Base64.getUrlEncoder().withoutPadding();
    String h = e.encodeToString("{\"alg\":\"none\"}".getBytes(StandardCharsets.UTF_8));
    String p = e.encodeToString(InterceptorTest.JSON.writeValueAsBytes(Map.of(
        "tenant", "acme", "scope", scope, "patient", "p1", "sub", "u-1", "client_id", "c-1", "fhirUser", fhirUser)));
    return h + "." + p + ".sig";
  }

  private EngineHarness engine(String address) throws Exception {
    PluginConfig cfg = new PluginConfig("", Duration.ofMillis(300), EngineHarness.TENANT, "", false);
    return new EngineHarness(EngineHarness.clientFor(pdp, 300), true, cfg, "/fhir", rs -> {
      rs.setTenantIdentificationStrategy(new UrlBaseTenantIdentificationStrategy());
      if (address != null) {
        rs.setServerAddressStrategy(new HardcodedServerAddressStrategy(address));
      }
    });
  }

  @Test
  void readAndVreadOfTheOwnFhirUserAre200AndThePdpSeesTheId() throws Exception {
    // BREAKS when: the response filter has no fhirUser exception (both would be 403 "response-not-in-scope": the only
    // data scope is patient/*.rs and a Practitioner is unbound), or resource_id is not sent to the PDP.
    try (EngineHarness e = engine(PUBLIC)) {
      String[] r = e.call("GET", "/facility-a/Practitioner/1000", token(GRANTED, SELF), null, null);
      assertEquals("200", r[0], r[1]);
      assertTrue(r[1].contains("\"id\":\"1000\""), r[1]);
      var in = pdp.inputs.get(0).get("request");
      assertEquals("read", in.get("interaction").asText());
      assertEquals("Practitioner", in.get("resource_type").asText());
      assertEquals("1000", in.get("resource_id").asText(), "the PDP rule matches the claim against resource_id");
      assertEquals(PUBLIC, in.get("base").asText());
      String[] v = e.call("GET", "/facility-a/Practitioner/1000/_history/2", token(GRANTED, SELF), null, null);
      assertEquals("200", v[0], v[1]);
      assertEquals("vread", pdp.inputs.get(1).get("request").get("interaction").asText());
      assertEquals("1000", pdp.inputs.get(1).get("request").get("resource_id").asText());
      e.awaitAudits(2);
    }
  }

  @Test
  void anotherIdIs403() throws Exception {
    // BREAKS when: the filter passes any resource of the claim's type (Practitioner/1001 is not the claim's 1000).
    try (EngineHarness e = engine(PUBLIC)) {
      String[] r = e.call("GET", "/facility-a/Practitioner/1001", token(GRANTED, SELF), null, null);
      assertEquals("403", r[0], r[1]);
      assertFalse(r[1].contains("Clinician1001"), "the other practitioner must not leak in the body");
      // positive pair: same engine, same token, the claim's own id
      assertEquals("200", e.call("GET", "/facility-a/Practitioner/1000", token(GRANTED, SELF), null, null)[0]);
      e.awaitAudits(2);
    }
  }

  @Test
  void withoutTheFhirUserScopeIs403() throws Exception {
    // BREAKS when: the filter honours the claim without the GRANTED fhirUser scope (scope lacks it, claim identical).
    try (EngineHarness e = engine(PUBLIC)) {
      String[] r = e.call("GET", "/facility-a/Practitioner/1000", token("patient/*.rs openid", SELF), null, null);
      assertEquals("403", r[0], r[1]);
      // "fhirUserX" is not "fhirUser": a substring match of the scope string would pass this one
      String[] x = e.call("GET", "/facility-a/Practitioner/1000", token("patient/*.rs openid fhirUserX", SELF), null, null);
      assertEquals("403", x[0], x[1]);
      e.awaitAudits(2);
    }
  }

  @Test
  void aClaimOnAnotherBaseIs403() throws Exception {
    // BREAKS when: the filter compares only the type/id tail (endsWith "/Practitioner/1000") or by prefix: the claims
    // below name another tenant's base and a LONGER base that starts with PUBLIC.
    try (EngineHarness e = engine(PUBLIC)) {
      String[] o = e.call("GET", "/facility-a/Practitioner/1000",
          token(GRANTED, "https://edge.example/other/fhir/Practitioner/1000"), null, null);
      assertEquals("403", o[0], o[1]);
      String[] l = e.call("GET", "/facility-a/Practitioner/1000", token(GRANTED, PUBLIC + "2/Practitioner/1000"), null, null);
      assertEquals("403", l[0], l[1]);
      e.awaitAudits(2);
    }
  }

  @Test
  void anUnpinnedEngineNeverMatches() throws Exception {
    // BREAKS when: an empty request.base is accepted: the claim "/Practitioner/1000" equals "" + "/Practitioner/1000".
    try (EngineHarness e = engine(null)) {
      String[] r = e.call("GET", "/facility-a/Practitioner/1000", token(GRANTED, "/Practitioner/1000"), null, null);
      assertEquals("403", r[0], r[1]);
      e.awaitAudits(1);
    }
  }

  @Test
  void aSearchNeverRevealsTheFhirUser() throws Exception {
    // BREAKS when: the fhirUser exception is applied to bundle entries: the provider over-returns 1000 and 1001, so
    // "Clinician1000" would appear in the search result.
    try (EngineHarness e = engine(PUBLIC)) {
      String[] r = e.call("GET", "/facility-a/Practitioner", token(GRANTED, SELF), null, null);
      assertEquals("200", r[0], r[1]);
      assertTrue(r[1].contains("\"resourceType\":\"Bundle\""), r[1]); // positive: the search ran and returned a bundle
      assertFalse(r[1].contains("Clinician1000"), r[1]);
      assertFalse(r[1].contains("Clinician1001"), r[1]);
      e.awaitAudits(1);
    }
  }
}
