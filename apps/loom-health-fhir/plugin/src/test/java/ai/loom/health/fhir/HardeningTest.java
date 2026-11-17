package ai.loom.health.fhir;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.loom.health.fhir.audit.AuditHealth;
import ai.loom.health.fhir.audit.AuditRecord;
import ai.loom.health.fhir.audit.AuditSink;
import ai.loom.health.fhir.audit.AuditSinks;
import ai.loom.health.fhir.audit.TrustedProxies;
import ai.loom.health.fhir.pdp.PluginConfig;
import ai.loom.health.fhir.pdp.SmartScopes;
import com.fasterxml.jackson.databind.JsonNode;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * LHDS W2-3 follow-ups (#5316): Bundle.total under filtering, typed-scope paging, audit hardening.
 * Every assertion names the input that breaks it.
 */
class HardeningTest {
  static FakePdp pdp;
  static EngineHarness engine;
  /** Same engine, but 127.0.0.1 (the test client's TCP peer) is a trusted proxy. */
  static EngineHarness proxied;

  @BeforeAll
  static void up() throws Exception {
    pdp = new FakePdp(InterceptorTest.ROOT.resolve("apps/loom-health-pdp/policies/lhds/interactions/data.json"));
    engine = new EngineHarness(EngineHarness.clientFor(pdp, 300), true);
    proxied = new EngineHarness(EngineHarness.clientFor(pdp, 300), true,
        new PluginConfig("", Duration.ofMillis(300), EngineHarness.TENANT, "", false, "127.0.0.1", "X-Forwarded-For"), "/");
  }

  @AfterAll
  static void down() throws Exception {
    engine.close();
    proxied.close();
    pdp.close();
  }

  @BeforeEach
  void reset() throws InterruptedException {
    engine.drainAndClear();
    proxied.drainAndClear();
    engine.extraHeaders = Map.of();
    proxied.extraHeaders = Map.of();
    pdp.reset(FakePdp.Mode.NORMAL);
  }

  static String tok(String scope, String patient) throws Exception {
    return InterceptorTest.token("acme", scope, patient);
  }

  // ---- item 1: Bundle.total ------------------------------------------------------------------

  @Test
  void totalIsOmittedWhenTheScopesCanHideEntries() throws Exception {
    // BREAKS when: filterResponse leaves (or recomputes) Bundle.total for a token that can be filtered.
    // The provider returns 3 matches and the engine reports total=3; patient/p1 may see 2 of them, so 3
    // leaks the hidden one and 2 (the old code, entry count of ONE PAGE) lies about the set.
    String[] r = engine.call("GET", "/Observation?patient=p1", tok("patient/Observation.rs", "p1"), null, null);
    assertEquals("200", r[0], r[1]);
    JsonNode b = InterceptorTest.JSON.readTree(r[1]);
    assertEquals(java.util.Set.of("o1", "o3"), InterceptorTest.ids(r[1]), "positive half: the visible entries stay");
    assertFalse(b.has("total"), "total must be absent for a filterable token: " + r[1]);
  }

  @Test
  void summaryCountIsNotAnOracleForHiddenResources() throws Exception {
    // BREAKS when: _summary=count returns the engine's total to a token that can be filtered. A
    // count-only bundle has no entries, so an entry-based fix would still leak the hidden count.
    String[] r = engine.call("GET", "/Observation?patient=p1&_summary=count", tok("patient/Observation.rs", "p1"), null, null);
    assertEquals("200", r[0], r[1]);
    assertFalse(InterceptorTest.JSON.readTree(r[1]).has("total"), "count-only must not report a number: " + r[1]);
  }

  @Test
  void totalIsKeptWhenNothingCanBeHidden() throws Exception {
    // BREAKS when: total is dropped for EVERY token (the simplest wrong fix): a user/*.rs token can hide
    // nothing, so the engine's total (3 matches) is exactly right and _summary=count must still work.
    String[] r = engine.call("GET", "/Observation?_summary=count", tok("user/*.rs", ""), null, null);
    assertEquals("200", r[0], r[1]);
    JsonNode b = InterceptorTest.JSON.readTree(r[1]);
    assertTrue(b.has("total"), "an unrestricted token keeps total: " + r[1]);
    assertEquals(3, b.get("total").asInt(), "the provider matches 3 observations");
  }

  @Test
  void hidesNothingOnlyForAnUnrestrictedReadScope() {
    // BREAKS when: hidesNothing() is true for a scope that can hide: patient context, a typed scope, a
    // category constraint, or a write-only scope; or false for user/*.r (the positive control).
    assertTrue(SmartScopes.parse("user/*.rs").hidesNothing());
    assertTrue(SmartScopes.parse("system/*.r").hidesNothing());
    assertFalse(SmartScopes.parse("patient/*.rs").hidesNothing(), "patient context is compartment-limited");
    assertFalse(SmartScopes.parse("user/Observation.rs").hidesNothing(), "typed scope hides other types");
    assertFalse(SmartScopes.parse("user/*.rs?category=laboratory").hidesNothing(), "category hides others");
    assertFalse(SmartScopes.parse("user/*.cud").hidesNothing(), "no read letter reads nothing");
  }

  // ---- item 2: typed-scope paging stays denied -----------------------------------------------

  @Test
  void aPagedSearchIsAskedAsWildcardTypeSoOnlyAWildcardScopeCoversIt() throws Exception {
    // BREAKS when: _getpages is authorized for a typed scope without the stored search's type being known
    // (a typed token would then page a search of another type), or stops being authorized for wildcard
    // scope (positive half). The PDP is asked resource_type="*" for the page fetch.
    String[] typed = engine.call("GET", "/?_getpages=zz&_getpagesoffset=10", tok("user/Observation.rs", ""), null, null);
    assertEquals("403", typed[0], "typed scope must not page: " + typed[1]);
    assertEquals("*", pdp.inputs.get(0).get("request").get("resource_type").asText());
    assertEquals("search", pdp.inputs.get(0).get("request").get("interaction").asText());
    pdp.reset(FakePdp.Mode.NORMAL);
    String[] wild = engine.call("GET", "/?_getpages=zz&_getpagesoffset=10", tok("user/*.rs", ""), null, null);
    assertNotEquals("403", wild[0], "a wildcard scope is authorized for paging: " + wild[1]);
    assertEquals(1, pdp.calls.get(), "positive half: the PDP was asked and allowed");
  }

  // ---- item 3: audit hardening ---------------------------------------------------------------

  @Test
  void auditRecordsWhichPatientsWereReturnedAndWhichWereHidden() throws Exception {
    // BREAKS when: the filter outcome is not carried to the audit row: PatientsReturned would be empty
    // (should be [p1]) and PatientsHidden empty (should be [p2], the owner of the filtered o2).
    // o1 p1, o2 p2, o3 p1 come back from the provider; patient/p1 sees o1 and o3.
    String[] r = engine.call("GET", "/Observation?patient=p1", tok("patient/Observation.rs", "p1"), null, null);
    assertEquals("200", r[0], r[1]);
    engine.awaitAudits(1);
    AuditRecord a = engine.audits.get(0);
    assertEquals(List.of("p1"), a.patientsReturned());
    assertEquals(List.of("p2"), a.patientsHidden());
    assertEquals(1, a.hiddenResourceCount(), "exactly one resource (o2) was hidden");
    JsonNode row = InterceptorTest.JSON.readTree(engine.auditJson.get(0));
    assertEquals("p2", row.get("PatientsHidden").get(0).asText());
    String ae = row.get("AuditEvent").toString();
    assertTrue(ae.contains("\"filter-result\"") && ae.contains("\"hidden\"") && ae.contains("Patient/p2"), ae);
    // PHI: ids only. The Patient provider puts a family name in the body; it must not reach the audit.
    String[] pr = engine.call("GET", "/Patient?_id=p1", tok("patient/Patient.rs", "p1"), null, null);
    assertEquals("200", pr[0], pr[1]);
    engine.awaitAudits(2);
    assertFalse(engine.auditJson.get(1).contains("Doep2"), "a hidden patient's name must never be audited");
    assertFalse(engine.auditJson.get(1).contains("Doep1"), "nor a returned one's");
    assertEquals(List.of("p2"), engine.audits.get(1).patientsHidden(), "positive half: the id is recorded");
  }

  @Test
  void aRefusedSingleResourceIsRecordedAsHidden() throws Exception {
    // BREAKS when: the single-resource 403 path (response-not-in-scope) forgets the filter outcome:
    // the audit would show no hidden patient and hiddenResourceCount 0 although p1's Patient was refused.
    pdp.reset(FakePdp.Mode.ALLOW_ALL);
    String[] r = engine.call("GET", "/Patient/p1", tok("patient/Patient.rs", "p2"), null, null);
    assertEquals("403", r[0], r[1]);
    engine.awaitAudits(1);
    assertEquals(List.of("p1"), engine.audits.get(0).patientsHidden());
    assertEquals(1, engine.audits.get(0).hiddenResourceCount());
    assertEquals(List.of(), engine.audits.get(0).patientsReturned());
  }

  @Test
  void clientAddressComesFromTheForwardedHeaderOnlyBehindATrustedProxy() throws Exception {
    // BREAKS when: (a) the header is read for an untrusted peer: the first call below would record
    // 203.0.113.9 instead of the real peer 127.0.0.1 (client-supplied XFF forging an audit address); (b) the
    // header is ignored for a trusted peer: the second call would record 127.0.0.1; (c) the LEFTMOST hop is
    // taken (the client writes the left side): the third call carries a forged 198.51.100.1 on the left
    // of the real client 203.0.113.9 and must record 203.0.113.9.
    String t = tok("user/*.rs", "");
    engine.extraHeaders = Map.of("X-Forwarded-For", "203.0.113.9");
    engine.call("GET", "/Patient/p1", t, null, null);
    engine.awaitAudits(1);
    assertEquals("127.0.0.1", engine.audits.get(0).remoteAddr(), "untrusted peer: header ignored");

    proxied.extraHeaders = Map.of("X-Forwarded-For", "203.0.113.9");
    proxied.call("GET", "/Patient/p1", t, null, null);
    proxied.awaitAudits(1);
    assertEquals("203.0.113.9", proxied.audits.get(0).remoteAddr(), "trusted proxy: forwarded client recorded");

    proxied.extraHeaders = Map.of("X-Forwarded-For", "198.51.100.1, 203.0.113.9");
    proxied.call("GET", "/Patient/p1", t, null, null);
    proxied.awaitAudits(2);
    assertEquals("203.0.113.9", proxied.audits.get(1).remoteAddr(), "rightmost untrusted hop, not the forgeable leftmost");

    proxied.extraHeaders = Map.of("X-Forwarded-For", "not-an-address");
    proxied.call("GET", "/Patient/p1", t, null, null);
    proxied.awaitAudits(3);
    assertEquals("127.0.0.1", proxied.audits.get(2).remoteAddr(), "garbage header: fall back to the TCP peer");
  }

  @Test
  void trustedProxyParsingAndWalk() {
    // BREAKS when: CIDR matching is off by a bit (10.1.2.3 vs 10.0.0.0/8 and 11.0.0.1), a hostname or an
    // out-of-range octet is accepted (999.1.1.1 would be a DNS lookup), an IPv6 peer is not matched, or an
    // all-trusted chain does not fall to the origin.
    TrustedProxies p = TrustedProxies.parse("10.0.0.0/8, 192.168.1.5, fd00::/8, bogus, 999.1.1.1, 10.0.0.0/99");
    assertTrue(p.isTrusted("10.1.2.3"));
    assertFalse(p.isTrusted("11.0.0.1"), "outside the /8");
    assertTrue(p.isTrusted("192.168.1.5"));
    assertFalse(p.isTrusted("192.168.1.6"), "a bare IP is exact, not a /24");
    assertTrue(p.isTrusted("fd12:3456::1"));
    assertFalse(p.isTrusted("fe80::1"));
    assertFalse(p.isTrusted("localhost"), "hostnames are never resolved");
    assertFalse(p.isTrusted("999.1.1.1"));
    assertEquals("203.0.113.9", p.clientAddress("10.0.0.7", "203.0.113.9, 10.0.0.8"));
    assertEquals("10.9.9.9", p.clientAddress("10.0.0.7", "10.9.9.9, 10.0.0.8"), "all hops trusted: the origin");
    assertEquals("203.0.113.9", p.clientAddress("203.0.113.9", "1.2.3.4"), "untrusted peer: header unread");
    assertEquals("10.0.0.7", p.clientAddress("10.0.0.7", "1.2.3.4, evil"), "a bad hop on the right voids the header");
    assertEquals("8.8.8.8", TrustedProxies.NONE.clientAddress("8.8.8.8", "1.1.1.1"), "default trusts nobody");
  }

  static AuditRecord record() {
    return new AuditRecord("rid", "2026-11-16T00:00:00Z", "acme", "search", "Observation", "", "",
        List.of("p1"), List.of("patient"), "permit", "permit", "v1", 0, "s", "c", "127.0.0.1",
        List.of("p1"), List.of("p2"), 1);
  }

  static PrintStream capture(ByteArrayOutputStream into) {
    return new PrintStream(into, true, StandardCharsets.UTF_8);
  }

  @Test
  void aFailingFileSinkIsCountedAndAlertedNotOnlyPrinted(@TempDir Path tmp) throws Exception {
    // BREAKS when: hourlyFiles swallows the IOException (counter stays 0, no alert line) or the composite
    // does not count it. The directory path sits UNDER a regular file, so createDirectories must fail.
    Path blocker = Files.writeString(tmp.resolve("not-a-dir"), "x");
    ByteArrayOutputStream alerts = new ByteArrayOutputStream();
    AuditHealth health = new AuditHealth(capture(alerts));
    List<String> stdoutRows = new java.util.ArrayList<>();
    AuditSink ok = (r, ae) -> stdoutRows.add(AuditSinks.line(r, ae));
    AuditSink all = AuditSinks.all(List.of(ok, AuditSinks.hourlyFiles(blocker.resolve("audit"))), health);
    all.emit(record(), "{\"resourceType\":\"AuditEvent\"}");
    assertEquals(1, health.failures(), "one failed write is one counted failure");
    assertEquals(0, health.lost(), "the other sink took the record: not lost");
    assertEquals(1, stdoutRows.size(), "positive half: the healthy sink still got it");
    assertTrue(health.degraded());
    String alert = alerts.toString(StandardCharsets.UTF_8);
    assertTrue(alert.contains("\"lhds_audit_alert\":1") && alert.contains("sink-write-failed")
        && alert.contains("hourly-files"), alert);
    assertFalse(alert.contains("p2") || alert.contains("acme"), "the alert names the sink, never record content");
  }

  @Test
  void aRecordNoSinkAcceptedIsCountedAsLost(@TempDir Path tmp) throws Exception {
    // BREAKS when: the composite reports lost()==0 although every sink failed (a silently dropped row), or
    // reports lost for a record a sink DID take (the previous test pins that side).
    Path blocker = Files.writeString(tmp.resolve("not-a-dir"), "x");
    ByteArrayOutputStream alerts = new ByteArrayOutputStream();
    AuditHealth health = new AuditHealth(capture(alerts));
    // Fail closed (#5339): a lost record is also RAISED so the interceptor can answer 503. BREAKS when the
    // composite goes back to swallowing it (assertThrows fails: nothing thrown).
    assertThrows(ai.loom.health.fhir.audit.AuditLostException.class, () ->
        AuditSinks.all(List.of(AuditSinks.hourlyFiles(blocker.resolve("audit"))), health)
            .emit(record(), "{\"resourceType\":\"AuditEvent\"}"));
    assertEquals(1, health.lost());
    assertEquals(1, health.failures());
    assertTrue(alerts.toString(StandardCharsets.UTF_8).contains("audit-record-lost"));
  }

  @Test
  void aBrokenStdoutIsDetectedBecausePrintStreamNeverThrows() {
    // BREAKS when: stream() ignores checkError(): a PrintStream over a failing OutputStream swallows the
    // IOException, so the audit row would be reported as written. Healthy stream = positive control.
    OutputStream broken = new OutputStream() {
      @Override
      public void write(int b) throws IOException {
        throw new IOException("disk full");
      }
    };
    AuditHealth health = new AuditHealth(capture(new ByteArrayOutputStream()));
    assertThrows(ai.loom.health.fhir.audit.AuditLostException.class, () ->
        AuditSinks.all(List.of(AuditSinks.stream(new PrintStream(broken, true))), health)
            .emit(record(), "{\"resourceType\":\"AuditEvent\"}"));
    assertEquals(1, health.failures());
    assertEquals(1, health.lost());

    AuditHealth healthy = new AuditHealth(capture(new ByteArrayOutputStream()));
    ByteArrayOutputStream good = new ByteArrayOutputStream();
    AuditSinks.all(List.of(AuditSinks.stream(capture(good))), healthy).emit(record(), "{\"resourceType\":\"AuditEvent\"}");
    assertEquals(0, healthy.failures());
    assertTrue(good.toString(StandardCharsets.UTF_8).contains("\"lhds_audit\":1"));
  }

  @Test
  void theFileSinkWritesTheRowThatWasEmitted(@TempDir Path tmp) throws Exception {
    // BREAKS when: the file sink stops appending (the directory stays empty) or loses the filter fields.
    AuditSinks.hourlyFiles(tmp.resolve("audit")).emit(record(), "{\"resourceType\":\"AuditEvent\"}");
    try (var files = Files.list(tmp.resolve("audit"))) {
      List<Path> fs = files.toList();
      assertEquals(1, fs.size());
      String text = Files.readString(fs.get(0));
      assertTrue(text.contains("\"PatientsHidden\":[\"p2\"]") && text.endsWith("\n"), text);
    }
  }
}
