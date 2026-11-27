package ai.loom.health.fhir;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.loom.health.fhir.partition.LoomTenantStrategyConfiguration;
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
 * reaches the engine and what is asserted is (a) the PDP input carries {@code resource_id} and {@code partition}, and
 * (b) the RESPONSE FILTER lets through exactly the resource the token's fhirUser claim names, in the DEFAULT partition
 * the bare-base claim names (#5489), which a patient/-only token's scopes never cover (a Practitioner has no patient
 * compartment). Engines run the plugin's partition strategy the way production does (BareBaseDefaultPartitionTest).
 * Every assertion names the input that breaks it.
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

  /** Unsigned, built at run time like InterceptorTest.token, plus fhirUser and sub_type claims. */
  static String token(String scope, String fhirUser, String subType) throws Exception {
    var e = Base64.getUrlEncoder().withoutPadding();
    String h = e.encodeToString("{\"alg\":\"none\"}".getBytes(StandardCharsets.UTF_8));
    String p = e.encodeToString(InterceptorTest.JSON.writeValueAsBytes(Map.of(
        "tenant", "acme", "scope", scope, "patient", "p1", "sub", "u-1", "client_id", "c-1",
        "fhirUser", fhirUser, "sub_type", subType)));
    return h + "." + p + ".sig";
  }

  static String token(String scope, String fhirUser) throws Exception {
    return token(scope, fhirUser, "user");
  }

  /** @param partitioned false: no tenant strategy at all, so HAPI sets no partition (rd.getTenantId() is null). */
  private EngineHarness engine(String address, boolean partitioned) throws Exception {
    PluginConfig cfg = new PluginConfig("", Duration.ofMillis(300), EngineHarness.TENANT, "", false);
    return new EngineHarness(EngineHarness.clientFor(pdp, 300), true, cfg, "/fhir", rs -> {
      if (partitioned) {
        rs.setTenantIdentificationStrategy(new UrlBaseTenantIdentificationStrategy()); // what the starter sets
        LoomTenantStrategyConfiguration.install(rs); // what the plugin then installs (#5489)
      }
      if (address != null) {
        rs.setServerAddressStrategy(new HardcodedServerAddressStrategy(address));
      }
    });
  }

  private EngineHarness engine() throws Exception {
    return engine(PUBLIC, true);
  }

  @Test
  void readAndVreadOfTheOwnFhirUserAtTheBareBaseAre200AndThePdpSeesIdAndPartition() throws Exception {
    // BREAKS when: the response filter has no fhirUser exception (both would be 403 "response-not-in-scope": the only
    // data scope is patient/*.rs and a Practitioner is unbound), or resource_id / partition is not sent to the PDP.
    try (EngineHarness e = engine()) {
      String[] r = e.call("GET", "/Practitioner/1000", token(GRANTED, SELF), null, null);
      assertEquals("200", r[0], r[1]);
      assertTrue(r[1].contains("\"id\":\"1000\""), r[1]);
      var in = pdp.inputs.get(0).get("request");
      assertEquals("read", in.get("interaction").asText());
      assertEquals("Practitioner", in.get("resource_type").asText());
      assertEquals("1000", in.get("resource_id").asText(), "the PDP rule matches the claim against resource_id");
      assertEquals("DEFAULT", in.get("partition").asText(), "the bare base is the DEFAULT partition (#5489)");
      assertEquals(PUBLIC, in.get("base").asText());
      String[] v = e.call("GET", "/Practitioner/1000/_history/2", token(GRANTED, SELF), null, null);
      assertEquals("200", v[0], v[1]);
      assertEquals("vread", pdp.inputs.get(1).get("request").get("interaction").asText());
      assertEquals("1000", pdp.inputs.get(1).get("request").get("resource_id").asText());
      e.awaitAudits(2);
    }
  }

  @Test
  void theSameIdInAFacilityPartitionIs403() throws Exception {
    // BREAKS when: the partition is not checked. /facility-a/Practitioner/1000 can be a DIFFERENT resource than the
    // DEFAULT Practitioner/1000 the bare-base claim names; without the check it is 200.
    try (EngineHarness e = engine()) {
      String[] r = e.call("GET", "/facility-a/Practitioner/1000", token(GRANTED, SELF), null, null);
      assertEquals("403", r[0], r[1]);
      assertEquals("facility-a", pdp.inputs.get(0).get("request").get("partition").asText());
      assertEquals("200", e.call("GET", "/Practitioner/1000", token(GRANTED, SELF), null, null)[0]); // positive pair
      e.awaitAudits(2);
    }
  }

  @Test
  void aCaseVariantOfDefaultIsAnotherPartitionAndIs403() throws Exception {
    // BREAKS when: the partition comparison case-folds (equalsIgnoreCase): /default and /Default are consumed as
    // partition names "default" / "Default", which are not HAPI's DEFAULT, and would then be 200.
    try (EngineHarness e = engine()) {
      for (String seg : new String[] {"default", "Default"}) {
        String[] r = e.call("GET", "/" + seg + "/Practitioner/1000", token(GRANTED, SELF), null, null);
        assertEquals("403", r[0], seg + ": " + r[1]);
      }
      assertEquals("default", pdp.inputs.get(0).get("request").get("partition").asText());
      assertEquals("Default", pdp.inputs.get(1).get("request").get("partition").asText());
      assertEquals("200", e.call("GET", "/DEFAULT/Practitioner/1000", token(GRANTED, SELF), null, null)[0]); // positive
      e.awaitAudits(3);
    }
  }

  @Test
  void anExplicitDefaultSegmentIsTheSamePartitionAndIs200() throws Exception {
    // Decision pinned: /DEFAULT/Practitioner/1000 IS the DEFAULT partition the bare base serves (the same row), so it
    // is allowed. BREAKS when: the explicit segment is no longer parsed as DEFAULT (partition sent would differ) or
    // the filter starts comparing the URL as received instead of the partition.
    try (EngineHarness e = engine()) {
      String[] r = e.call("GET", "/DEFAULT/Practitioner/1000", token(GRANTED, SELF), null, null);
      assertEquals("200", r[0], r[1]);
      assertEquals("DEFAULT", pdp.inputs.get(0).get("request").get("partition").asText());
      e.awaitAudits(1);
    }
  }

  @Test
  void anEngineThatSendsNoPartitionFailsClosed() throws Exception {
    // BREAKS when: an absent partition is treated as DEFAULT (the read would be 200).
    try (EngineHarness e = engine(PUBLIC, false)) {
      String[] r = e.call("GET", "/Practitioner/1000", token(GRANTED, SELF), null, null);
      assertEquals("403", r[0], r[1]);
      assertFalse(pdp.inputs.get(0).get("request").has("partition"), "no strategy, no partition sent");
      e.awaitAudits(1);
    }
  }

  @Test
  void aResponseThatIsNotTheRequestedResourceIs403() throws Exception {
    // BREAKS when: the filter compares the claim with the RESPONSE only: /Practitioner/swap answers with
    // Practitioner/1000, which equals the claim, so it would be 200 although the authorized request named "swap".
    try (EngineHarness e = engine()) {
      String[] r = e.call("GET", "/Practitioner/swap", token(GRANTED, SELF), null, null);
      assertEquals("403", r[0], r[1]);
      assertEquals("swap", pdp.inputs.get(0).get("request").get("resource_id").asText());
      e.awaitAudits(1);
    }
  }

  @Test
  void aSystemTokenIs403() throws Exception {
    // BREAKS when: the filter does not require sub_type user (same claim and scope, sub_type system would be 200).
    try (EngineHarness e = engine()) {
      String[] r = e.call("GET", "/Practitioner/1000", token(GRANTED, SELF, "system"), null, null);
      assertEquals("403", r[0], r[1]);
      assertEquals("200", e.call("GET", "/Practitioner/1000", token(GRANTED, SELF, "user"), null, null)[0]);
      e.awaitAudits(2);
    }
  }

  @Test
  void anotherIdIs403() throws Exception {
    // BREAKS when: the filter passes any resource of the claim's type (Practitioner/1001 is not the claim's 1000).
    try (EngineHarness e = engine()) {
      String[] r = e.call("GET", "/Practitioner/1001", token(GRANTED, SELF), null, null);
      assertEquals("403", r[0], r[1]);
      assertFalse(r[1].contains("Clinician1001"), "the other practitioner must not leak in the body");
      assertEquals("200", e.call("GET", "/Practitioner/1000", token(GRANTED, SELF), null, null)[0]); // positive pair
      e.awaitAudits(2);
    }
  }

  @Test
  void withoutTheFhirUserScopeIs403() throws Exception {
    // BREAKS when: the filter honours the claim without the GRANTED fhirUser scope (scope lacks it, claim identical).
    try (EngineHarness e = engine()) {
      String[] r = e.call("GET", "/Practitioner/1000", token("patient/*.rs openid", SELF), null, null);
      assertEquals("403", r[0], r[1]);
      // "fhirUserX" is not "fhirUser": a substring match of the scope string would pass this one
      String[] x = e.call("GET", "/Practitioner/1000", token("patient/*.rs openid fhirUserX", SELF), null, null);
      assertEquals("403", x[0], x[1]);
      e.awaitAudits(2);
    }
  }

  @Test
  void aClaimOnAnotherBaseIs403() throws Exception {
    // BREAKS when: the filter compares only the type/id tail (endsWith "/Practitioner/1000") or by prefix: the claims
    // below name another tenant's base and a LONGER base that starts with PUBLIC.
    try (EngineHarness e = engine()) {
      String[] o = e.call("GET", "/Practitioner/1000",
          token(GRANTED, "https://edge.example/other/fhir/Practitioner/1000"), null, null);
      assertEquals("403", o[0], o[1]);
      String[] l = e.call("GET", "/Practitioner/1000", token(GRANTED, PUBLIC + "2/Practitioner/1000"), null, null);
      assertEquals("403", l[0], l[1]);
      e.awaitAudits(2);
    }
  }

  @Test
  void anUnpinnedEngineNeverMatches() throws Exception {
    // BREAKS when: an empty request.base is accepted: the claim "/Practitioner/1000" equals "" + "/Practitioner/1000".
    try (EngineHarness e = engine(null, true)) {
      String[] r = e.call("GET", "/Practitioner/1000", token(GRANTED, "/Practitioner/1000"), null, null);
      assertEquals("403", r[0], r[1]);
      e.awaitAudits(1);
    }
  }

  @Test
  void aSearchNeverRevealsTheFhirUser() throws Exception {
    // BREAKS when: the fhirUser exception is applied to bundle entries: the provider over-returns 1000 and 1001, so
    // "Clinician1000" would appear in the search result.
    try (EngineHarness e = engine()) {
      String[] r = e.call("GET", "/Practitioner", token(GRANTED, SELF), null, null);
      assertEquals("200", r[0], r[1]);
      assertTrue(r[1].contains("\"resourceType\":\"Bundle\""), r[1]); // positive: the search ran and returned a bundle
      assertFalse(r[1].contains("Clinician1000"), r[1]);
      assertFalse(r[1].contains("Clinician1001"), r[1]);
      e.awaitAudits(1);
    }
  }

  @Test
  void anInstanceHistoryNeverRevealsTheFhirUser() throws Exception {
    // BREAKS when: the fhirUser exception is applied to bundle entries. Unlike a search, /Practitioner/1000/_history
    // names resource_id 1000, so the request-match check alone would not stop it: "Clinician1000" would appear.
    try (EngineHarness e = engine()) {
      String[] r = e.call("GET", "/Practitioner/1000/_history", token(GRANTED, SELF), null, null);
      assertEquals("200", r[0], r[1]);
      assertTrue(r[1].contains("\"resourceType\":\"Bundle\""), r[1]); // positive: the history ran
      assertEquals("history", pdp.inputs.get(0).get("request").get("interaction").asText());
      assertEquals("1000", pdp.inputs.get(0).get("request").get("resource_id").asText());
      assertFalse(r[1].contains("Clinician1000"), r[1]);
      e.awaitAudits(1);
    }
  }
}
