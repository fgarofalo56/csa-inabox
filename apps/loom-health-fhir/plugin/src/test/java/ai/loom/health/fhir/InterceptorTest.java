package ai.loom.health.fhir;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;
import ai.loom.health.fhir.pdp.PluginConfig;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Every assertion names the input that breaks it ("BREAKS when"). The engine is a real HAPI
 * RestfulServer on a real socket; the PDP is {@link FakePdp} (frozen decision API, unsigned tokens).
 */
class InterceptorTest {
  static final ObjectMapper JSON = new ObjectMapper();
  static final Path ROOT = Path.of(System.getProperty("loom.repo.root", "../../.."));
  static FakePdp pdp;
  static EngineHarness engine;

  @BeforeAll
  static void up() throws Exception {
    pdp = new FakePdp(ROOT.resolve("apps/loom-health-pdp/policies/lhds/interactions/data.json"));
    engine = new EngineHarness(EngineHarness.clientFor(pdp, 300), true);
  }

  @AfterAll
  static void down() throws Exception {
    engine.close();
    pdp.close();
  }

  @BeforeEach
  void reset() throws InterruptedException {
    engine.drainAndClear();
    pdp.reset(FakePdp.Mode.NORMAL);
  }

  /** Unsigned JWT-shaped token built at run time (no JWT literal in the repo for scanners to flag). */
  static String token(String tenant, String scope, String patient) throws Exception {
    var e = Base64.getUrlEncoder().withoutPadding();
    String h = e.encodeToString("{\"alg\":\"none\"}".getBytes(StandardCharsets.UTF_8));
    String p = e.encodeToString(JSON.writeValueAsBytes(java.util.Map.of(
        "tenant", tenant, "scope", scope, "patient", patient, "sub", "u-1", "client_id", "c-1")));
    return h + "." + p + ".sig";
  }

  // ---- positive control + cross tenant ------------------------------------------------------

  @Test
  void sameTenantAllowedScopeIs200() throws Exception {
    // BREAKS when: the interceptor denies or 503s a permitted request (e.g. wrong PDP URL, tenant
    // sent as "" or base missing): status would be 403/503 instead of 200, or the id would differ.
    String[] r = engine.call("GET", "/Patient/p1", token("acme", "user/*.rs", ""), null, null);
    assertEquals("200", r[0], r[1]);
    assertTrue(r[1].contains("\"id\":\"p1\""), "body must be the real Patient p1: " + r[1]);
    JsonNode in = pdp.inputs.get(0).get("request");
    assertEquals("acme", in.get("tenant").asText(), "tenant sent to the PDP must be the engine's tenant");
    assertEquals("read", in.get("interaction").asText());
    assertEquals("Patient", in.get("resource_type").asText());
    assertEquals(engine.base, in.get("base").asText(), "base is the server public base: no partition segment, no trailing slash (decision 13)");
    assertEquals(1, engine.handlerCalls.get(), "the engine ran exactly once");
  }

  @Test
  void crossTenantIs403AndTheEngineNeverRuns() throws Exception {
    // BREAKS when: the PDP interceptor is not registered (response is 200 and handlerCalls is 1) or the
    // tenant sent to the PDP is taken from anywhere but the route (a header must not move it).
    String[] r = engine.call("GET", "/Patient/p1", token("othertenant", "user/*.rs", ""), null, null);
    assertEquals("403", r[0], "a token minted for another tenant must be refused: " + r[1]);
    assertEquals(0, engine.handlerCalls.get(), "a denied request must not reach the engine");
    engine.awaitAudits(1);
    assertEquals("deny", engine.audits.get(0).decision());
    assertEquals("tenant-mismatch", engine.audits.get(0).reason());
    assertFalse(r[1].contains("tenant-mismatch"), "the client must not learn which rule fired");
  }

  @Test
  void tenantHeaderCannotMoveTheTenant() throws Exception {
    // BREAKS when: request.tenant is read from a client-supplied header or the body instead of the route.
    var req = java.net.http.HttpRequest.newBuilder(java.net.URI.create(engine.base + "/Patient/p1"))
        .header("Authorization", "Bearer " + token("othertenant", "user/*.rs", ""))
        .header("X-Tenant", "othertenant").header("X-Loom-Tenant", "othertenant").build();
    var resp = engine.http.send(req, java.net.http.HttpResponse.BodyHandlers.ofString());
    assertEquals(403, resp.statusCode());
    assertEquals("acme", pdp.inputs.get(0).get("request").get("tenant").asText());
  }

  // ---- fail closed --------------------------------------------------------------------------

  @Test
  void pdpTimeoutIs503NotTheEngineAndNeverA200() throws Exception {
    // BREAKS when: a timeout is treated as allow (200) or as deny (403 instead of 503), or the
    // handler still runs. The PDP sleeps 1500 ms against a 300 ms client timeout.
    pdp.reset(FakePdp.Mode.SLOW);
    String[] r = engine.call("GET", "/Patient/p1", token("acme", "user/*.rs", ""), null, null);
    assertEquals("503", r[0], r[1]);
    assertEquals(0, engine.handlerCalls.get());
    engine.awaitAudits(1);
    assertEquals("error", engine.audits.get(0).decision());
    assertEquals("pdp-timeout", engine.audits.get(0).reason());
    assertEquals(503, engine.audits.get(0).status());
  }

  @Test
  void everyUndecidablePdpReplyIs503() throws Exception {
    // BREAKS when: any of these is mapped to a 200 or a 403. 500: 5xx; {}: OPA "undefined";
    // allow as the string "true": not a JSON boolean, so not a decision.
    String[][] cases = {
        {"HTTP_500", "pdp-status"}, {"EMPTY_RESULT", "pdp-no-result"}, {"ALLOW_AS_STRING", "pdp-malformed"}};
    for (String[] c : cases) {
      reset();
      pdp.reset(FakePdp.Mode.valueOf(c[0]));
      String[] r = engine.call("GET", "/Patient/p1", token("acme", "user/*.rs", ""), null, null);
      assertEquals("503", r[0], c[0]);
      assertEquals(0, engine.handlerCalls.get(), c[0]);
      engine.awaitAudits(1);
      assertEquals(c[1], engine.audits.get(0).reason(), c[0]);
    }
  }

  @Test
  void unreachablePdpIs503() throws Exception {
    // BREAKS when: a connection error is swallowed into allow or deny. Port 1 refuses connections.
    try (EngineHarness e2 = new EngineHarness(
        new ai.loom.health.fhir.pdp.HttpPdpClient("http://127.0.0.1:1", java.time.Duration.ofMillis(300)), true)) {
      assertEquals("503", e2.call("GET", "/Patient/p1", token("acme", "user/*.rs", ""), null, null)[0]);
      assertEquals(0, e2.handlerCalls.get());
    }
  }

  @Test
  void unconfiguredPdpIs503NotOpen() throws Exception {
    // BREAKS when: a missing LOOM_HEALTH_PDP_URL (null client) lets requests through.
    try (EngineHarness e2 = new EngineHarness(null, true)) {
      assertEquals("503", e2.call("GET", "/Patient/p1", token("acme", "user/*.rs", ""), null, null)[0]);
      assertEquals(0, e2.handlerCalls.get());
    }
  }

  @Test
  void noBearerIs401AndThePdpIsNotAsked() throws Exception {
    // BREAKS when: an anonymous request reaches the engine (200) or is sent to the PDP (calls == 1).
    String[] r = engine.call("GET", "/Patient/p1", null, null, null);
    assertEquals("401", r[0]);
    assertEquals(0, pdp.calls.get());
    assertEquals(0, engine.handlerCalls.get());
    engine.awaitAudits(1);
    assertEquals("no-token", engine.audits.get(0).reason());
  }

  // ---- audit ---------------------------------------------------------------------------------

  @Test
  void nRequestsProduceExactlyNAuditEvents() throws Exception {
    // BREAKS when: any path emits zero (a denied / 503 / 401 request unaudited) or two (permit +
    // exception hook both emitting) events. 10 requests, 5 different outcomes; expected count is 10.
    String ok = token("acme", "user/*.rs", "");
    String other = token("nope", "user/*.rs", "");
    int n = 0;
    for (int i = 0; i < 3; i++, n++) engine.call("GET", "/Patient/p1", ok, null, null);
    for (int i = 0; i < 2; i++, n++) engine.call("GET", "/Patient/p1", other, null, null);
    engine.call("GET", "/Patient", ok, null, null); n++;
    engine.call("GET", "/Patient/p1", null, null, null); n++;
    engine.call("GET", "/metadata", null, null, null); n++;
    engine.call("GET", "/Nonexistent/zz", ok, null, null); n++;
    pdp.reset(FakePdp.Mode.HTTP_500);
    engine.call("GET", "/Patient/p1", ok, null, null); n++;
    assertEquals(10, n);
    engine.awaitAudits(n);
    Thread.sleep(150); // a spurious extra event would arrive late; give it the chance
    assertEquals(n, engine.audits.size(), "exactly one AuditEvent per interaction; got "
        + engine.audits.stream().map(a -> a.interaction() + ":" + a.decision()).toList());
    assertEquals(n, engine.auditJson.size());
    long permits = engine.audits.stream().filter(a -> a.decision().equals("permit")).count();
    assertEquals(5, permits, "3 reads + 1 search + 1 metadata permitted; the rest are deny/error");
  }

  @Test
  void auditIsAnAuditEventWithNoTokenNoQueryValuesNoBody() throws Exception {
    // BREAKS when: the bearer token, a search VALUE (PHI) or a request body lands in the audit line,
    // or the AuditEvent is not a rest interaction naming the resource. The positive half pins that the
    // param NAME and the resource are present, so deleting the feature cannot pass.
    String tok = token("acme", "user/*.rs", "");
    engine.call("GET", "/Patient?family=ZZ-SENTINEL-LHDS", tok, null, null);
    engine.awaitAudits(1);
    String line = engine.auditJson.get(0);
    assertFalse(line.contains("ZZ-SENTINEL-LHDS"), "query values are PHI and must never be audited");
    assertFalse(line.contains(tok), "the bearer token must never be audited");
    assertFalse(line.contains(tok.split("\\.")[1]), "nor its payload");
    JsonNode n = JSON.readTree(line);
    assertEquals(1, n.get("lhds_audit").asInt());
    assertEquals("acme", n.get("Tenant").asText());
    assertEquals("search", n.get("Interaction").asText());
    assertEquals("permit", n.get("Decision").asText());
    assertEquals("family", n.get("ParamNames").get(0).asText());
    JsonNode ae = n.get("AuditEvent");
    assertEquals("AuditEvent", ae.get("resourceType").asText());
    assertEquals("search", ae.get("subtype").get(0).get("code").asText());
    assertEquals("c-1", ae.get("agent").get(0).get("who").get("display").asText(),
        "agent is the verified client_id, read only after the PDP allowed");
    assertEquals("0", ae.get("outcome").asText());
  }

  @Test
  void deniedRequestsRecordAnUnverifiedAgentNotTheClaims() throws Exception {
    // BREAKS when: claims of a token the PDP REFUSED are copied into the audit as if verified.
    engine.call("GET", "/Patient/p1", token("othertenant", "user/*.rs", ""), null, null);
    engine.awaitAudits(1);
    JsonNode ae = JSON.readTree(engine.auditJson.get(0)).get("AuditEvent");
    assertEquals("unverified", ae.get("agent").get(0).get("who").get("display").asText());
    assertEquals("4", ae.get("outcome").asText(), "deny is outcome 4 (minor failure)");
  }

  // ---- audit fails closed (#5339) -------------------------------------------------------------

  /**
   * Run {@code during} with the audit sink down, then restore it. Waits until the sink has been tried
   * twice (the fail-closed write, then the SERVER_PROCESSING_COMPLETED retry, which fires after the
   * client already has its response) so a late retry cannot land after the sink is healthy again.
   */
  static void withSinkDown(java.util.concurrent.Callable<Void> during) throws Exception {
    int before = engine.sinkAttempts.get();
    engine.sinkFails = true;
    try {
      during.call();
      long end = System.currentTimeMillis() + 5000;
      while (engine.sinkAttempts.get() < before + 2 && System.currentTimeMillis() < end) {
        Thread.sleep(10);
      }
      assertTrue(engine.sinkAttempts.get() >= before + 2,
          "the interceptor never even tried the sink twice (attempt + completion retry): the fixture does not reach it");
    } finally {
      engine.sinkFails = false;
      engine.sent.set(0); // no row can exist for requests made while the sink was down
      engine.audits.clear();
      engine.auditJson.clear();
    }
  }

  @Test
  void aReadIsNot200WithABodyWhenTheAuditSinkThrows() throws Exception {
    // BREAKS when: the audit row is written only after the response (fail-open): the sink throws, the
    // client still gets 200 and the Patient body ("Doep1" is the canned family name). Positive half: the
    // SAME request with a healthy sink returns 200 + that body, so absence cannot pass by deleting the read.
    String tok = token("acme", "user/*.rs", "");
    String[] ok = engine.call("GET", "/Patient/p1", tok, null, null);
    assertEquals("200", ok[0], ok[1]);
    assertTrue(ok[1].contains("Doep1"), ok[1]);
    engine.drainAndClear();
    withSinkDown(() -> {
      String[] r = engine.call("GET", "/Patient/p1", tok, null, null);
      assertEquals("503", r[0], r[1]);
      assertFalse(r[1].contains("Doep1"), "the Patient body must not be in a fail-closed response: " + r[1]);
      assertFalse(r[1].contains("\"resourceType\":\"Patient\""), r[1]);
      assertTrue(r[1].contains("OperationOutcome") && r[1].contains("Audit trail unavailable"), r[1]);
      assertFalse(r[1].contains("simulated audit sink outage"), "the sink's exception text must not reach the client");
      return null;
    });
  }

  @Test
  void aSearchIsNot200WithEntriesWhenTheAuditSinkThrows() throws Exception {
    // BREAKS when: search/history results are released while the sink is down. p1's own Observations o1 and o3
    // are IN scope (the existing patient-scope test pins them for a healthy sink), so a leaked bundle
    // would contain "o1".
    String tok = token("acme", "patient/Observation.rs", "p1");
    String[] ok = engine.call("GET", "/Observation?patient=p1", tok, null, null);
    assertEquals("200", ok[0], ok[1]);
    assertEquals(Set.of("o1", "o3"), ids(ok[1]), "positive half: a healthy sink returns the entries");
    engine.drainAndClear();
    withSinkDown(() -> {
      String[] r = engine.call("GET", "/Observation?patient=p1", tok, null, null);
      assertEquals("503", r[0], r[1]);
      assertFalse(r[1].contains("\"o1\"") || r[1].contains("\"o3\"") || r[1].contains("\"Bundle\""), r[1]);
      return null;
    });
  }

  @Test
  void anUpdateIsNotPersistedWhenTheAuditSinkThrows() throws Exception {
    // BREAKS when: the audit row is written after the write is committed: PUT answers 503 or 200 but o4 is
    // already vital-signs. o4 starts as laboratory; the body flips it. Positive half: with a healthy sink the
    // SAME PUT persists (200, vital-signs), so "still laboratory" cannot come from an unreachable fixture.
    String tok = token("acme", "user/Observation.cruds", "");
    String body = obsJson("o4", "p2", "vital-signs");
    try {
      withSinkDown(() -> {
        String[] r = engine.call("PUT", "/Observation/o4", tok, body, "application/fhir+json");
        assertEquals("503", r[0], r[1]);
        assertEquals("laboratory", engine.store.get("o4").getCategoryFirstRep().getCodingFirstRep().getCode(),
            "the write must have been rolled back (never committed) when the audit row could not be written");
        return null;
      });
      String[] ok = engine.call("PUT", "/Observation/o4", tok, body, "application/fhir+json");
      assertEquals("200", ok[0], ok[1]);
      assertEquals("vital-signs", engine.store.get("o4").getCategoryFirstRep().getCodingFirstRep().getCode());
      engine.awaitAudits(1);
      assertEquals(1, engine.audits.size(), "the healthy retry wrote exactly one row");
    } finally {
      engine.store.put("o4", EngineHarness.obs("o4", "p2", "laboratory"));
    }
  }

  @Test
  void aCreateIsNotPersistedWhenTheAuditSinkThrows() throws Exception {
    // BREAKS when: create is audited post-commit: o9 exists in the store after a 503. Positive half: a healthy
    // sink gives 201 and o9 is stored.
    String tok = token("acme", "user/*.cruds", "");
    String body = obsJson("x", "p1", "vital-signs");
    try {
      withSinkDown(() -> {
        String[] r = engine.call("POST", "/Observation", tok, body, "application/fhir+json");
        assertEquals("503", r[0], r[1]);
        assertFalse(engine.store.containsKey("o9"), "a created resource must not exist without its audit row");
        return null;
      });
      String[] ok = engine.call("POST", "/Observation", tok, body, "application/fhir+json");
      assertEquals("201", ok[0], ok[1]);
      assertTrue(engine.store.containsKey("o9"));
    } finally {
      engine.store.remove("o9");
    }
  }

  @Test
  void deniedRequestsAndMetadataKeepTheirAnswerWhenTheAuditSinkThrows() throws Exception {
    // DISCLOSED GAP, pinned so it is deliberate: a 403 and GET /metadata carry no clinical data, so they are
    // audited after the response and a dead sink cannot change them. BREAKS when fail-closed is widened to
    // them (403 becomes 503, /metadata 503s and a liveness probe would kill a healthy pod).
    withSinkDown(() -> {
      String[] denied = engine.call("GET", "/Patient/p1", token("othertenant", "user/*.rs", ""), null, null);
      assertEquals("403", denied[0], denied[1]);
      String[] meta = engine.call("GET", "/metadata", null, null, null);
      assertEquals("200", meta[0], meta[1]);
      return null;
    });
  }

  // ---- response filtering ------------------------------------------------------------------

  @Test
  void patientScopeFiltersOtherPatientsOutOfASearchBundle() throws Exception {
    // BREAKS when: the response filter is absent: the over-returning provider yields o1,o2,o3 (3 entries,
    // including p2's o2) and the assertion on exactly {o1,o3} fails.
    String[] r = engine.call("GET", "/Observation?patient=p1", token("acme", "patient/Observation.rs", "p1"), null, null);
    assertEquals("200", r[0], r[1]);
    assertEquals(Set.of("o1", "o3"), ids(r[1]), "p2's o2 must be filtered out; p1's own stay (positive half)");
  }

  @Test
  void categoryConstraintFiltersOtherCategories() throws Exception {
    // BREAKS when: the category constraint is ignored by the filter: the lab observation o3 (and o2) come
    // back too. category=<system|code> is compared by exact string, so the vital-signs observations o1 AND o2 are kept (o2 belongs to p2: a user/ scope has no
    // compartment limit; the comment used to say "o1 only", the {o1,o2} assertion below was the truth).
    String scope = "user/Observation.rs?category=" + EngineHarness.VITALS;
    String[] r = engine.call("GET", "/Observation?category=" + java.net.URLEncoder.encode(EngineHarness.VITALS, StandardCharsets.UTF_8),
        token("acme", scope, ""), null, null);
    assertEquals("200", r[0], r[1]);
    assertEquals(Set.of("o1", "o2"), ids(r[1]), "only vital-signs observations survive; lab o3 is dropped");
  }

  @Test
  void aTypeOutsideTheScopeIsFilteredEvenWhenThePdpPermitsEverything() throws Exception {
    // BREAKS when: the filter trusts the PDP alone. The PDP here is ALLOW_ALL; the token only has
    // user/Patient.rs, so reading an Observation must be 403 (response-not-in-scope), not 200.
    pdp.reset(FakePdp.Mode.ALLOW_ALL);
    String[] r = engine.call("GET", "/Observation/o1", token("acme", "user/Patient.rs", ""), null, null);
    assertEquals("403", r[0], r[1]);
    engine.awaitAudits(1);
    assertEquals("response-not-in-scope", engine.audits.get(0).reason());
    assertEquals(403, engine.audits.get(0).status());
    // positive control on the same path: the covering scope reads it.
    reset();
    pdp.reset(FakePdp.Mode.ALLOW_ALL);
    assertEquals("200", engine.call("GET", "/Observation/o1", token("acme", "user/Observation.rs", ""), null, null)[0]);
  }

  static Set<String> ids(String bundleJson) throws Exception {
    Set<String> out = new LinkedHashSet<>();
    JsonNode e = JSON.readTree(bundleJson).get("entry");
    if (e != null) {
      e.forEach(x -> out.add(x.get("resource").get("id").asText()));
    }
    return out;
  }

  // ---- scope matrix GENERATED from role-scope-map.v1.json -----------------------------------

  record Case(String name, String method, String path, String body, String ctype, String type, String interaction,
      boolean bound) {}

  static final String PAT = "{\"resourceType\":\"Patient\"}";
  static final String OBS = "{\"resourceType\":\"Observation\",\"status\":\"final\",\"code\":{\"text\":\"x\"},"
      + "\"subject\":{\"reference\":\"Patient/p1\"}}";

  static List<Case> cases() {
    return List.of(
        new Case("read Patient/p1", "GET", "/Patient/p1", null, null, "Patient", "read", true),
        new Case("vread Patient/p1", "GET", "/Patient/p1/_history/1", null, null, "Patient", "vread", true),
        new Case("history Patient/p1", "GET", "/Patient/p1/_history", null, null, "Patient", "history", true),
        new Case("search Patient?_id=p1", "GET", "/Patient?_id=p1", null, null, "Patient", "search", true),
        new Case("create Patient (no owner)", "POST", "/Patient", PAT, "application/fhir+json", "Patient", "create", false),
        new Case("update Patient/p1", "PUT", "/Patient/p1", "{\"resourceType\":\"Patient\",\"id\":\"p1\"}", "application/fhir+json", "Patient", "update", true),
        new Case("patch Patient/p1", "PATCH", "/Patient/p1", "[]", "application/json-patch+json", "Patient", "patch", true),
        new Case("delete Patient/p1", "DELETE", "/Patient/p1", null, null, "Patient", "delete", true),
        new Case("search Observation?patient=p1", "GET", "/Observation?patient=p1", null, null, "Observation", "search", true),
        new Case("read Observation/o1 (owner unknown pre-read)", "GET", "/Observation/o1", null, null, "Observation", "read", false),
        new Case("create Observation (subject p1)", "POST", "/Observation", OBS, "application/fhir+json", "Observation", "create", true));
  }

  /** Letter per interaction, read from the PDP's own table at test time. */
  static JsonNode interactionTable() throws Exception {
    return JSON.readTree(Files.readString(ROOT.resolve("apps/loom-health-pdp/policies/lhds/interactions/data.json"))).get("fhir");
  }

  /** Distinct ceiling scopes of every role, read from the role map at test time (never transcribed). */
  static Set<String> ceilingScopes() throws Exception {
    JsonNode map = JSON.readTree(Files.readString(ROOT.resolve("apps/loom-health-cp/src/auth/role-scope-map.v1.json")));
    Set<String> out = new LinkedHashSet<>();
    for (JsonNode role : map.get("roles")) {
      for (String grant : List.of("authorization_code", "client_credentials")) {
        role.get("ceiling").get(grant).forEach(s -> out.add(s.asText()));
      }
    }
    return out;
  }

  @TestFactory
  Stream<DynamicTest> scopeMatrixFromRoleScopeMap() throws Exception {
    JsonNode table = interactionTable();
    Set<String> scopes = ceilingScopes();
    // 9 distinct at the time of writing (user|patient|system x *.rs, *.cruds; system/*.cu; SearchParameter x2).
    // A floor, not an equality: a new role may add scopes and must be covered automatically.
    assertTrue(scopes.size() >= 8, "role map must yield >= 8 distinct ceiling scopes, got " + scopes);
    List<DynamicTest> tests = new ArrayList<>();
    int[] allowedCells = {0};
    int[] deniedCells = {0};
    for (String scope : scopes) {
      for (Case c : cases()) {
        String ctx = scope.substring(0, scope.indexOf('/'));
        String type = scope.substring(scope.indexOf('/') + 1, scope.indexOf('.'));
        String letters = scope.substring(scope.indexOf('.') + 1);
        String letter = table.get(c.interaction()).asText();
        boolean expectAllowed = (type.equals("*") || type.equals(c.type()))
            && letters.contains(letter)
            && (!ctx.equals("patient") || c.bound());
        if (expectAllowed) allowedCells[0]++; else deniedCells[0]++;
        tests.add(DynamicTest.dynamicTest(scope + " | " + c.name() + " -> " + (expectAllowed ? "allow" : "deny"), () -> {
          reset();
          String[] r = engine.call(c.method(), c.path(), token("acme", scope, "p1"), c.body(), c.ctype());
          int status = Integer.parseInt(r[0]);
          // BREAKS when: the interceptor sends the wrong interaction / resource_type / compartment to the PDP
          // (or does not ask it). Expected status is computed from the raw scope string and the PDP's own
          // interaction table, not from the plugin's parser.
          if (expectAllowed) {
            assertTrue(status >= 200 && status < 300, scope + " | " + c.name() + " expected 2xx got " + status + " " + r[1]);
            assertEquals(1, engine.handlerCalls.get());
          } else {
            assertEquals(403, status, scope + " | " + c.name() + " expected 403 got " + status + " " + r[1]);
            assertEquals(0, engine.handlerCalls.get(), "denied must not reach the engine");
          }
          assertEquals(1, pdp.calls.get(), "exactly one PDP call per interaction");
          assertEquals(c.interaction(), pdp.inputs.get(0).get("request").get("interaction").asText());
          assertEquals(c.type(), pdp.inputs.get(0).get("request").get("resource_type").asText());
          engine.awaitAudits(1);
          assertEquals(expectAllowed ? "permit" : "deny", engine.audits.get(0).decision());
          assertEquals(1, engine.audits.size(), "one audit row per matrix request");
        }));
      }
    }
    // Guard against a vacuous matrix: both outcomes must occur, else the generator or map is broken.
    assertTrue(allowedCells[0] > 20 && deniedCells[0] > 20,
        "matrix must contain both allow and deny cells: allow=" + allowedCells[0] + " deny=" + deniedCells[0]);
    return tests.stream();
  }

  // ---- small units ---------------------------------------------------------------------------

  @Test
  void pluginListsTheRealInterceptorClasses() throws Exception {
    // BREAKS when: a class is renamed/moved without LoomPlugin.registeredInterceptors() (hand-listed so the
    // load probe need not link HAPI) following it: Class.forName fails.
    String[] names = LoomPlugin.registeredInterceptors();
    assertEquals(2, names.length);
    for (String n : names) {
      assertEquals(n, Class.forName(n).getName());
    }
  }

  @Test
  void scopeParserGrantsNothingForMalformedScopes() {
    // BREAKS when: out-of-order letters ("sr"), an unsupported constraint, or a bare "launch" scope is
    // accepted (the PDP grants nothing for these, so the filter must not either).
    var s = ai.loom.health.fhir.pdp.SmartScopes.parse("user/Patient.sr user/Patient.rs?foo=bar launch patient/*.cruds");
    assertEquals(1, s.all().size(), "only patient/*.cruds is well formed: " + s.all());
    assertFalse(s.canRead("Patient", Set.of(), Set.of("p1"), ""), "patient scope with no patient claim reads nothing");
    assertTrue(s.canRead("Patient", Set.of(), Set.of("p1"), "p1"), "positive control");
  }

  @Test
  void tenantResolution() {
    // BREAKS when: a fixed engine tenant is overridden by the URL, or an invalid slug is accepted.
    var fixed = new ai.loom.health.fhir.pdp.PluginConfig("", java.time.Duration.ofSeconds(1), "acme", "", false);
    assertEquals("acme", fixed.resolveTenant("/other/fhir/Patient"));
    var unset = new ai.loom.health.fhir.pdp.PluginConfig("", java.time.Duration.ofSeconds(1), "", "", false);
    assertEquals(null, unset.resolveTenant("/beta/fhir/Patient/1"), "unset tenant must NOT fall back to the URL");
    var routed = new ai.loom.health.fhir.pdp.PluginConfig("", java.time.Duration.ofSeconds(1), "", "", true);
    assertEquals("beta", routed.resolveTenant("/beta/fhir/Patient/1"));
    assertEquals(null, routed.resolveTenant("/Beta%20x/fhir/Patient"));
    assertEquals(null, routed.resolveTenant("/Patient/1"));
  }

  // ---- update-over-existing (stored resource) -----------------------------------------------

  static String obsJson(String id, String patient, String category) {
    return "{\"resourceType\":\"Observation\",\"id\":\"" + id + "\",\"status\":\"final\",\"code\":{\"text\":\"x\"},"
        + "\"subject\":{\"reference\":\"Patient/" + patient + "\"},\"category\":[{\"coding\":[{\"system\":"
        + "\"http://terminology.hl7.org/CodeSystem/observation-category\",\"code\":\"" + category + "\"}]}]}";
  }

  @Test
  void patientTokenCannotOverwriteAnotherPatientsObservationByClaimingIt() throws Exception {
    // BREAKS when: UPDATE is authorized on the new body only (the stored-resource check is removed): the
    // body says subject=Patient/p1 so the PDP allows, PUT answers 200 and o2 (owned by p2) is reassigned to p1.
    String[] r = engine.call("PUT", "/Observation/o2", token("acme", "patient/Observation.cruds", "p1"),
        obsJson("o2", "p1", "vital-signs"), "application/fhir+json");
    assertEquals("403", r[0], r[1]);
    assertEquals("Patient/p2", engine.store.get("o2").getSubject().getReference(),
        "o2 must still belong to p2: the storage write must not have happened");
    assertEquals(2, pdp.calls.get(), "one decision for the body, one for the stored resource");
    engine.awaitAudits(1);
    assertEquals("deny", engine.audits.get(0).decision());
    assertTrue(engine.audits.get(0).reason().startsWith("stored-resource:"), engine.audits.get(0).reason());
    assertEquals(1, engine.audits.size(), "still exactly one audit row");
  }

  @Test
  void categoryConstrainedTokenCannotOverwriteAResourceOfAnotherCategory() throws Exception {
    // BREAKS when: only the body categories are checked: a vital-signs body over the stored LAB observation o3
    // passes (200 and o3 becomes vital-signs). Scope is constrained to the vital-signs system|code form.
    String scope = "user/Observation.cruds?category=" + EngineHarness.VITALS;
    String[] r = engine.call("PUT", "/Observation/o3", token("acme", scope, ""),
        obsJson("o3", "p1", "vital-signs"), "application/fhir+json");
    assertEquals("403", r[0], r[1]);
    assertEquals("laboratory", engine.store.get("o3").getCategoryFirstRep().getCodingFirstRep().getCode(),
        "o3 must still be the laboratory observation");
  }

  @Test
  void patientCanUpdateItsOwnObservation() throws Exception {
    // BREAKS when: the stored-resource check over-denies (wrong compartment sent for the OLD resource): the
    // own-record update would be 403 and the stored status would not change. Positive control for the two above.
    String body = obsJson("o1", "p1", "vital-signs").replace("\"final\"", "\"amended\"");
    String[] r = engine.call("PUT", "/Observation/o1", token("acme", "patient/Observation.cruds", "p1"),
        body, "application/fhir+json");
    assertEquals("200", r[0], r[1]);
    assertEquals("AMENDED", engine.store.get("o1").getStatus().name());
    assertEquals(2, pdp.calls.get());
    engine.store.put("o1", EngineHarness.obs("o1", "p1", "vital-signs"));
  }

  // ---- $batch / $transaction ------------------------------------------------------------------

  @Test
  void noRoleGrantsBatchOrTransactionToday() throws Exception {
    // BREAKS when: any role in role-scope-map.v1.json lists $batch or $transaction under operations. A bundle
    // gets ONE decision and its entries are not authorized individually, so granting it would bypass every
    // per-entry scope check; add per-entry authorization before changing this.
    JsonNode map = JSON.readTree(Files.readString(ROOT.resolve("apps/loom-health-cp/src/auth/role-scope-map.v1.json")));
    int roles = 0;
    for (JsonNode role : map.get("roles")) {
      roles++;
      for (JsonNode op : role.get("operations")) {
        assertFalse(op.asText().equals("$batch") || op.asText().equals("$transaction"),
            "role " + role.get("id").asText() + " gained " + op.asText());
      }
    }
    assertTrue(roles >= 10, "role map read failed or shrank: " + roles);
  }

  @Test
  void batchAndTransactionBundlesAreDeniedAndNeverReachTheEngine() throws Exception {
    // BREAKS when: a bundle is sent to the PDP as something a role could hold (interaction other than
    // "operation"), or the denial is bypassed: handlerCalls would be 1 and status 200.
    for (String type : List.of("transaction", "batch")) {
      reset();
      String bundle = "{\"resourceType\":\"Bundle\",\"type\":\"" + type + "\",\"entry\":[]}";
      String[] r = engine.call("POST", "/", token("acme", "user/*.cruds", ""), bundle, "application/fhir+json");
      assertEquals("403", r[0], type + " " + r[1]);
      assertEquals(0, engine.handlerCalls.get(), type);
      assertEquals("operation", pdp.inputs.get(0).get("request").get("interaction").asText(), type);
      assertTrue(pdp.inputs.get(0).get("request").get("op").asText().startsWith("$"), type);
    }
    // positive control: the route is live. With a PDP that allows everything the same bundle reaches the engine.
    reset();
    pdp.reset(FakePdp.Mode.ALLOW_ALL);
    String[] ok = engine.call("POST", "/", token("acme", "user/*.cruds", ""),
        "{\"resourceType\":\"Bundle\",\"type\":\"transaction\",\"entry\":[]}", "application/fhir+json");
    assertEquals("200", ok[0], ok[1]);
    assertEquals(1, engine.handlerCalls.get());
  }

  // ---- tenant must be configured ---------------------------------------------------------------

  @Test
  void unsetTenantIs503AndNotAGuessFromTheUrl() throws Exception {
    // BREAKS when: resolveTenant falls back to the URL without the explicit test flag: the request below
    // (path /acme/fhir/...) would get 200 instead of 503, and the PDP would have been called.
    PluginConfig cfg = new PluginConfig("", java.time.Duration.ofMillis(300), "", "", false);
    try (EngineHarness e2 = new EngineHarness(EngineHarness.clientFor(pdp, 300), true, cfg, "/acme/fhir")) {
      reset();
      String[] r = e2.call("GET", "/Patient/p1", token("acme", "user/*.rs", ""), null, null);
      assertEquals("503", r[0], r[1]);
      assertEquals(0, e2.handlerCalls.get());
      assertEquals(0, pdp.calls.get(), "no tenant means no PDP question");
      e2.awaitAudits(1);
      assertEquals("tenant-unconfigured", e2.audits.get(0).reason());
      assertEquals("error", e2.audits.get(0).decision());
    }
  }

  @Test
  void pathTenantWorksOnlyBehindTheExplicitTestFlag() throws Exception {
    // BREAKS when: the flag stops enabling the path fallback (200 becomes 503) or the tenant sent to the PDP is
    // not the first path segment.
    PluginConfig cfg = new PluginConfig("", java.time.Duration.ofMillis(300), "", "", true);
    try (EngineHarness e2 = new EngineHarness(EngineHarness.clientFor(pdp, 300), true, cfg, "/acme/fhir")) {
      reset();
      String[] r = e2.call("GET", "/Patient/p1", token("acme", "user/*.rs", ""), null, null);
      assertEquals("200", r[0], r[1]);
      assertEquals("acme", pdp.inputs.get(0).get("request").get("tenant").asText());
      assertTrue(pdp.inputs.get(0).get("request").get("base").asText().endsWith("/acme/fhir"));
      e2.awaitAudits(1);
    }
  }

  // ---- unexpected PDP-client failures and slow bodies -------------------------------------------

  @Test
  void aRuntimeExceptionFromThePdpClientIs503WithAnErrorAudit() throws Exception {
    // BREAKS when: decide() throwing NPE / IllegalArgumentException escapes as an unlabelled 500 (status 500, and
    // the audit decision "none"/"permit" instead of "error" with reason pdp-internal-error).
    for (RuntimeException ex : List.<RuntimeException>of(new NullPointerException("x"), new IllegalArgumentException("bad uri"))) {
      try (EngineHarness e2 = new EngineHarness((t, rq) -> { throw ex; }, true)) {
        String[] r = e2.call("GET", "/Patient/p1", token("acme", "user/*.rs", ""), null, null);
        assertEquals("503", r[0], ex + " " + r[1]);
        assertEquals(0, e2.handlerCalls.get());
        e2.awaitAudits(1);
        assertEquals("error", e2.audits.get(0).decision());
        assertEquals("pdp-internal-error", e2.audits.get(0).reason());
        assertEquals(503, e2.audits.get(0).status());
      }
    }
  }

  @Test
  void aPdpThatSendsHeadersThenTricklesTheBodyIs503WithinTheTimeout() throws Exception {
    // BREAKS when: only the header wait is bounded (HttpRequest.timeout alone): the first body byte arrives at
    // once, the rest after 3000 ms, so the call would block ~3 s and then succeed with 200. Timeout is 300 ms.
    pdp.reset(FakePdp.Mode.TRICKLE);
    long t0 = System.nanoTime();
    String[] r = engine.call("GET", "/Patient/p1", token("acme", "user/*.rs", ""), null, null);
    long ms = (System.nanoTime() - t0) / 1_000_000;
    assertEquals("503", r[0], r[1]);
    assertTrue(ms < 1500, "must give up near the 300 ms timeout, took " + ms + " ms");
    engine.awaitAudits(1);
    assertEquals("pdp-timeout", engine.audits.get(0).reason());
  }
}
