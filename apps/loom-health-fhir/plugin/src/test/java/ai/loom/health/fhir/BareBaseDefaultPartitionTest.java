package ai.loom.health.fhir;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.loom.health.fhir.partition.DesiredPartitions;
import ai.loom.health.fhir.partition.LoomTenantIdentificationStrategy;
import ai.loom.health.fhir.partition.LoomTenantStrategyConfiguration;
import ai.loom.health.fhir.pdp.PluginConfig;
import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.interceptor.api.Hook;
import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.rest.api.RequestTypeEnum;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.HardcodedServerAddressStrategy;
import ca.uhn.fhir.rest.server.RestfulServer;
import ca.uhn.fhir.rest.server.servlet.ServletRequestDetails;
import ca.uhn.fhir.rest.server.servlet.ServletSubRequestDetails;
import ca.uhn.fhir.rest.server.tenant.UrlBaseTenantIdentificationStrategy;
import ca.uhn.fhir.rest.server.util.ServletRequestUtil;
import com.fasterxml.jackson.databind.JsonNode;
import com.google.common.collect.ArrayListMultimap;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * #5489 (operator decision 2026-11-25): the BARE tenant base {@code {edge}/{tenant}/fhir} serves HAPI's DEFAULT
 * partition, and {@code /{facility}/...} keeps working unchanged. Each engine is a real HAPI RestfulServer mounted at
 * /fhir with the strategy installed the way the starter + plugin do it at runtime: HAPI's UrlBase strategy is set first
 * (as PartitionModeConfigurer's constructor does), then {@link LoomTenantStrategyConfiguration#install} replaces it.
 *
 * <p>Mutation receipt (sandbox copy, PR body): with {@code LoomTenantIdentificationStrategy} delegating every method to
 * HAPI's strategy, the bare-base tests here go RED (400/404 on the resource calls, /DEFAULT in Location).
 */
class BareBaseDefaultPartitionTest {
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

  /** What HAPI parsed for each request: "tenant|resourceName|idPart". */
  public static final class Seen {
    final List<String> rows = new CopyOnWriteArrayList<>();
    /** Sub-requests built through HAPI's own ServletRequestUtil (the path BaseTransactionProcessor uses). */
    final List<String> subs = new CopyOnWriteArrayList<>();
    /** rd.getFhirServerBase(): what RestfulServer computed through massageServerBaseUrl for each request. */
    final List<String> bases = new CopyOnWriteArrayList<>();

    @Hook(Pointcut.SERVER_INCOMING_REQUEST_PRE_HANDLED)
    public void pre(RequestDetails rd, ServletRequestDetails srd) {
      bases.add(rd.getFhirServerBase());
      rows.add(rd.getTenantId() + "|" + rd.getResourceName() + "|" + (rd.getId() == null ? "" : rd.getId().getIdPart()));
      if (srd != null && srd.getRequestType() == RequestTypeEnum.POST && rd.getResourceName() == null) {
        ServletSubRequestDetails sub = ServletRequestUtil.getServletSubRequestDetails(srd, "Patient/p1", "GET",
            ArrayListMultimap.create());
        subs.add(sub.getTenantId() + "|" + sub.getResourceName() + "|" + sub.getId().getIdPart() + "|"
            + sub.getServerBaseForRequest());
      }
    }
  }

  private EngineHarness engine(Seen seen) throws Exception {
    PluginConfig cfg = new PluginConfig("", Duration.ofMillis(300), EngineHarness.TENANT, "", false);
    return new EngineHarness(EngineHarness.clientFor(pdp, 300), true, cfg, "/fhir", rs -> {
      rs.setTenantIdentificationStrategy(new UrlBaseTenantIdentificationStrategy()); // what the starter sets
      LoomTenantStrategyConfiguration.install(rs); // what the plugin's SmartInitializingSingleton then does
      rs.setServerAddressStrategy(new HardcodedServerAddressStrategy(PUBLIC));
      rs.getInterceptorService().registerInterceptor(seen);
    });
  }

  private static String reader() throws Exception {
    return InterceptorTest.token("acme", "user/*.rs", "");
  }

  private static String selfLink(String body) throws Exception {
    for (JsonNode l : InterceptorTest.JSON.readTree(body).get("link")) {
      if ("self".equals(l.get("relation").asText())) {
        return l.get("url").asText();
      }
    }
    return "";
  }

  @Test
  void aSearchAtTheBareBaseServesDefaultAndItsSelfLinkHasNoPartitionSegment() throws Exception {
    // BREAKS when: the first token "Patient" is consumed as a partition name (HAPI's strategy): status 400, tenant
    // "Patient"; or massageServerBaseUrl appends /DEFAULT: the self link would start PUBLIC + "/DEFAULT/Patient".
    Seen seen = new Seen();
    try (EngineHarness e = engine(seen)) {
      String[] r = e.call("GET", "/Patient?_count=1", reader(), null, null);
      assertEquals("200", r[0], r[1]);
      assertEquals("DEFAULT|Patient|", seen.rows.get(0));
      assertEquals(PUBLIC, seen.bases.get(0));
      String self = selfLink(r[1]);
      assertTrue(self.startsWith(PUBLIC + "/Patient?"), "self link: " + self);
      assertFalse(self.contains("/DEFAULT"), "self link: " + self);
      // decision 13: request.base stays the configured public base, no partition, at the bare base too.
      assertEquals(PUBLIC, pdp.inputs.get(0).get("request").get("base").asText());
      e.awaitAudits(1);
      assertEquals("acme", e.audits.get(0).tenant(), "the audit row is still written, under the engine tenant");
    }
  }

  @Test
  void aReadByIdAtTheBareBaseReachesTheEngineWithTheRightIdAndType() throws Exception {
    // BREAKS when: "Patient" is consumed as the partition: "abc" becomes the resource type and HAPI answers 404,
    // with handlerCalls 0.
    Seen seen = new Seen();
    try (EngineHarness e = engine(seen)) {
      String[] r = e.call("GET", "/Patient/abc", reader(), null, null);
      assertEquals("200", r[0], r[1]);
      assertTrue(r[1].contains("\"id\":\"abc\""), r[1]);
      assertEquals(1, e.handlerCalls.get());
      assertEquals("DEFAULT|Patient|abc", seen.rows.get(0));
      e.awaitAudits(1);
    }
  }

  @Test
  void aCreateAtTheBareBaseAnswersALocationAtTheBareBase() throws Exception {
    // BREAKS when: massageServerBaseUrl appends the DEFAULT name: Location = PUBLIC/DEFAULT/Patient/p9/_history/1,
    // which a SMART client at the bare base would then follow into a different URL space.
    Seen seen = new Seen();
    pdp.reset(FakePdp.Mode.ALLOW_ALL);
    try (EngineHarness e = engine(seen)) {
      HttpResponse<String> r = e.send("POST", "/Patient", reader(), "{\"resourceType\":\"Patient\"}", "application/fhir+json");
      assertEquals(201, r.statusCode(), r.body());
      assertEquals(PUBLIC + "/Patient/p9/_history/1", r.headers().firstValue("Location").orElse(""));
      assertEquals("DEFAULT|Patient|", seen.rows.get(0));
      e.awaitAudits(1);
    }
  }

  @Test
  void theFacilityBaseIsUnchangedReadSearchAndCreateKeepTheirSegment() throws Exception {
    // BREAKS when: the facility token stops being consumed (tenant would be DEFAULT and "facility-a" the type: 404),
    // or massageServerBaseUrl drops the segment for a named partition (Location / self link without /facility-a).
    Seen seen = new Seen();
    pdp.reset(FakePdp.Mode.ALLOW_ALL);
    try (EngineHarness e = engine(seen)) {
      String[] read = e.call("GET", "/facility-a/Patient/p1", reader(), null, null);
      assertEquals("200", read[0], read[1]);
      String[] search = e.call("GET", "/facility-a/Patient?_count=1", reader(), null, null);
      assertEquals("200", search[0], search[1]);
      assertTrue(selfLink(search[1]).startsWith(PUBLIC + "/facility-a/Patient?"), selfLink(search[1]));
      HttpResponse<String> c = e.send("POST", "/facility-a/Patient", reader(), "{\"resourceType\":\"Patient\"}", "application/fhir+json");
      assertEquals(201, c.statusCode(), c.body());
      assertEquals(PUBLIC + "/facility-a/Patient/p9/_history/1", c.headers().firstValue("Location").orElse(""));
      assertEquals(List.of("facility-a|Patient|p1", "facility-a|Patient|", "facility-a|Patient|"), seen.rows);
      assertEquals(List.of(PUBLIC + "/facility-a", PUBLIC + "/facility-a", PUBLIC + "/facility-a"), seen.bases);
      e.awaitAudits(3);
    }
  }

  @Test
  void anExplicitDefaultSegmentIsStillConsumedAsAPartitionName() throws Exception {
    // BREAKS when: the rule becomes "starts with an uppercase letter" instead of "is a resource type": DEFAULT would
    // not be consumed, would be read as the resource type, and the request would 404.
    Seen seen = new Seen();
    try (EngineHarness e = engine(seen)) {
      String[] r = e.call("GET", "/DEFAULT/Patient/p1", reader(), null, null);
      assertEquals("200", r[0], r[1]);
      assertEquals("DEFAULT|Patient|p1", seen.rows.get(0));
      // The bare base is DEFAULT's address, so an explicit /DEFAULT search links back to the bare base, and the path
      // interceptor must not prefix a second DEFAULT (self would then be PUBLIC/DEFAULT/Patient?...).
      String[] s = e.call("GET", "/DEFAULT/Patient?_count=1", reader(), null, null);
      assertEquals("200", s[0], s[1]);
      assertTrue(selfLink(s[1]).startsWith(PUBLIC + "/Patient?"), selfLink(s[1]));
      e.awaitAudits(2);
    }
  }

  @Test
  void metadataAtTheBareBaseIsDefaultAndNamesTheBareBase() throws Exception {
    // BREAKS when: metadata's implied DEFAULT gets a /DEFAULT segment (it does with HAPI's strategy): the server base
    // HAPI computes for the request would be PUBLIC/DEFAULT.
    Seen seen = new Seen();
    try (EngineHarness e = engine(seen)) {
      String[] r = e.call("GET", "/metadata", null, null, null);
      assertEquals("200", r[0], r[1]);
      assertEquals("DEFAULT|null|", seen.rows.get(0));
      assertEquals(PUBLIC, seen.bases.get(0));
      // Documentation, NOT coverage: implementation.url comes from the address strategy, never from
      // massageServerBaseUrl (ServerCapabilityStatementProvider:223, 8.12.0), so no strategy can break this line.
      assertTrue(r[1].contains(PUBLIC), "CapabilityStatement names the public base: " + r[1]);
      e.awaitAudits(1);
    }
  }

  @Test
  void aTransactionPostedToTheBareBaseIsDefaultAndItsSubRequestsResolveThere() throws Exception {
    // BREAKS when: an empty path keeps HAPI's 400 (rootRequest.multitenant), or a sub-request built by HAPI's
    // ServletRequestUtil (what BaseTransactionProcessor uses) resolves to another partition or a /DEFAULT base.
    Seen seen = new Seen();
    pdp.reset(FakePdp.Mode.ALLOW_ALL);
    try (EngineHarness e = engine(seen)) {
      String[] r = e.call("POST", "/", reader(), "{\"resourceType\":\"Bundle\",\"type\":\"transaction\",\"entry\":[]}",
          "application/fhir+json");
      assertEquals("200", r[0], r[1]);
      assertEquals(1, e.handlerCalls.get());
      assertEquals("DEFAULT|null|", seen.rows.get(0));
      assertEquals(List.of("DEFAULT|Patient|p1|" + PUBLIC), seen.subs);
      // Positive pair at a facility base: the sub-request inherits the facility and its segment.
      String[] f = e.call("POST", "/facility-a", reader(), "{\"resourceType\":\"Bundle\",\"type\":\"transaction\",\"entry\":[]}",
          "application/fhir+json");
      assertEquals("200", f[0], f[1]);
      assertEquals("DEFAULT|Patient|p1|" + PUBLIC, seen.subs.get(0));
      assertEquals("facility-a|Patient|p1|" + PUBLIC + "/facility-a", seen.subs.get(1));
      e.awaitAudits(2);
    }
  }

  @Test
  void aFacilityNameCanNeverBeAResourceType() throws Exception {
    // BREAKS when: the CP's PARTITION_NAME (lifted from the source, not transcribed) admits an uppercase first letter,
    // e.g. a name like "Patient" would then be served as the DEFAULT partition's resource type, not the facility.
    String ts = Files.readString(InterceptorTest.ROOT.resolve("apps/loom-health-cp/src/jobs/fhir-tenant-config.ts"));
    Matcher m = Pattern.compile("export const PARTITION_NAME = /(.+)/;").matcher(ts);
    assertTrue(m.find(), "PARTITION_NAME not found in fhir-tenant-config.ts");
    Pattern cp = Pattern.compile(m.group(1));
    assertEquals(cp.pattern(), DesiredPartitions.NAME.pattern(), "plugin and CP facility-name patterns drifted");
    assertTrue(cp.matcher("facility-a").matches(), "positive control: a real facility name matches");
    int types = 0;
    for (String type : FhirContext.forR4Cached().getResourceTypes()) {
      types++;
      assertFalse(cp.matcher(type).matches(), type + " matches the facility pattern");
      assertTrue(Character.isUpperCase(type.charAt(0)), type);
    }
    assertTrue(types > 100, "resource-type list read failed: " + types);
  }

  // ---- installer ----------------------------------------------------------------------------

  @Test
  void theInstallerReplacesTheStartersStrategyAndReadsItBack() {
    // BREAKS when: install() does not call the setter, or reads back a different object: current() would still be the
    // UrlBase instance and the log line would not name what it replaced.
    RestfulServer rs = new RestfulServer(FhirContext.forR4Cached());
    UrlBaseTenantIdentificationStrategy starter = new UrlBaseTenantIdentificationStrategy();
    rs.setTenantIdentificationStrategy(starter);
    assertSame(starter, LoomTenantStrategyConfiguration.current(rs), "the reflective read sees the starter's strategy");
    String line = LoomTenantStrategyConfiguration.install(rs);
    assertTrue(LoomTenantStrategyConfiguration.current(rs) instanceof LoomTenantIdentificationStrategy);
    assertEquals("{\"event\":\"tenant-strategy.installed\",\"replaced\":\"" + UrlBaseTenantIdentificationStrategy.class.getName()
        + "\"}", line);
    // Idempotent: a second run keeps ours and does not register the path interceptor twice (count 2 would break it).
    assertEquals("{\"event\":\"tenant-strategy.installed\",\"replaced\":\"none\"}", LoomTenantStrategyConfiguration.install(rs));
    assertEquals(1, rs.getInterceptorService().getAllRegisteredInterceptors().stream()
        .filter(i -> i instanceof ai.loom.health.fhir.partition.ImpliedDefaultPathInterceptor).count());
  }

  @Test
  void theInstallerLeavesAnUnpartitionedServerAloneAndRefusesAnUnknownStrategy() {
    // BREAKS when: install() sets a strategy on a server with partitioning off (current() would be non-null), or
    // overwrites a strategy it does not recognise instead of stopping the engine.
    RestfulServer off = new RestfulServer(FhirContext.forR4Cached());
    assertTrue(LoomTenantStrategyConfiguration.install(off).contains("tenant-strategy.skipped"));
    assertNull(LoomTenantStrategyConfiguration.current(off));
    RestfulServer odd = new RestfulServer(FhirContext.forR4Cached());
    UrlBaseTenantIdentificationStrategy custom = new UrlBaseTenantIdentificationStrategy() { };
    odd.setTenantIdentificationStrategy(custom);
    IllegalStateException ex = assertThrows(IllegalStateException.class, () -> LoomTenantStrategyConfiguration.install(odd));
    assertTrue(ex.getMessage().startsWith("tenant-strategy.install-failed: unexpected strategy"), ex.getMessage());
    assertSame(custom, LoomTenantStrategyConfiguration.current(odd), "the unknown strategy was not replaced");
  }
}
