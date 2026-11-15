package ai.loom.health.fhir;

import ai.loom.health.fhir.audit.AuditSink;
import ai.loom.health.fhir.pdp.HttpPdpClient;
import ai.loom.health.fhir.pdp.PdpClient;
import ai.loom.health.fhir.pdp.PluginConfig;
import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.interceptor.executor.InterceptorService;
import ca.uhn.fhir.rest.annotation.Create;
import ca.uhn.fhir.rest.annotation.Delete;
import ca.uhn.fhir.rest.annotation.History;
import ca.uhn.fhir.rest.annotation.IdParam;
import ca.uhn.fhir.rest.annotation.Patch;
import ca.uhn.fhir.rest.annotation.OptionalParam;
import ca.uhn.fhir.rest.annotation.Read;
import ca.uhn.fhir.rest.param.StringParam;
import ca.uhn.fhir.rest.annotation.ResourceParam;
import ca.uhn.fhir.rest.annotation.Search;
import ca.uhn.fhir.rest.annotation.Update;
import ca.uhn.fhir.rest.api.MethodOutcome;
import ca.uhn.fhir.rest.api.PatchTypeEnum;
import ca.uhn.fhir.rest.server.IResourceProvider;
import ca.uhn.fhir.rest.server.RestfulServer;
import jakarta.servlet.ServletException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import org.eclipse.jetty.ee10.servlet.ServletContextHandler;
import org.eclipse.jetty.ee10.servlet.ServletHolder;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.server.ServerConnector;
import org.hl7.fhir.r4.model.CodeableConcept;
import org.hl7.fhir.r4.model.IdType;
import org.hl7.fhir.r4.model.Observation;
import org.hl7.fhir.r4.model.Patient;
import org.hl7.fhir.r4.model.Reference;

/**
 * A real HAPI {@link RestfulServer} on a real Jetty socket, with the REAL plugin registered through
 * {@link LoomPlugin#register}. Resource providers are stateless canned data, counting every
 * invocation in {@link #handlerCalls} so a test can prove "the engine did no work".
 *
 * <p>Providers deliberately OVER-RETURN on search (they ignore the patient / category filter), to
 * stand in for _include / _revinclude leaking other patients and types: only the interceptor's
 * response filter stands between those and the caller.
 */
final class EngineHarness implements AutoCloseable {
  static final String TENANT = "acme";
  static final String VITALS = "http://terminology.hl7.org/CodeSystem/observation-category|vital-signs";

  final AtomicInteger handlerCalls = new AtomicInteger();
  final List<String> auditJson = new CopyOnWriteArrayList<>();
  final List<ai.loom.health.fhir.audit.AuditRecord> audits = new CopyOnWriteArrayList<>();
  private final Server jetty;
  final String base;
  final HttpClient http = HttpClient.newHttpClient();

  EngineHarness(PdpClient pdp, boolean registerPlugin) throws Exception {
    AuditSink sink = (r, ae) -> {
      audits.add(r);
      auditJson.add(ai.loom.health.fhir.audit.AuditSinks.line(r, ae));
    };
    PluginConfig cfg = new PluginConfig("", Duration.ofMillis(300), TENANT, "");
    RestfulServer rs = new RestfulServer(FhirContext.forR4Cached()) {
      @Override
      protected void initialize() throws ServletException {
        setResourceProviders(List.of(new PatientProvider(), new ObservationProvider()));
        InterceptorService svc = new InterceptorService();
        setInterceptorService(svc);
        if (registerPlugin) {
          LoomPlugin.register(svc, pdp, cfg, sink);
        }
      }
    };
    jetty = new Server();
    ServerConnector c = new ServerConnector(jetty);
    c.setHost("127.0.0.1");
    jetty.addConnector(c);
    ServletContextHandler ctx = new ServletContextHandler();
    ctx.setContextPath("/");
    ctx.addServlet(new ServletHolder(rs), "/*");
    jetty.setHandler(ctx);
    jetty.start();
    base = "http://127.0.0.1:" + c.getLocalPort();
  }

  static PdpClient clientFor(FakePdp pdp, long timeoutMs) {
    return new HttpPdpClient(pdp.url(), Duration.ofMillis(timeoutMs));
  }

  /** @return {status, body} */
  String[] call(String method, String path, String bearer, String body, String contentType) throws Exception {
    HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + path))
        .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body))
        .header("Accept", "application/fhir+json");
    if (bearer != null) {
      b.header("Authorization", "Bearer " + bearer);
    }
    if (contentType != null) {
      b.header("Content-Type", contentType);
    }
    sent.incrementAndGet();
    HttpResponse<String> r = http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    return new String[] {String.valueOf(r.statusCode()), r.body()};
  }

  final AtomicInteger sent = new AtomicInteger();

  /**
   * HAPI fires SERVER_PROCESSING_COMPLETED after the body is flushed, so a request's audit row can land
   * after the client has its response. Wait for one row per request sent, then clear: without this a
   * previous test's late row leaks into the next test's assertions.
   */
  void drainAndClear() throws InterruptedException {
    awaitAudits(sent.getAndSet(0));
    audits.clear();
    auditJson.clear();
    handlerCalls.set(0);
  }

  void awaitAudits(int n) throws InterruptedException {
    long end = System.currentTimeMillis() + 5000;
    while (audits.size() < n && System.currentTimeMillis() < end) {
      Thread.sleep(10);
    }
  }

  @Override
  public void close() throws Exception {
    jetty.stop();
  }

  // ---- canned data -------------------------------------------------------------------------

  static Patient patient(String id) {
    Patient p = new Patient();
    p.setId(id);
    p.addName().setFamily("Doe" + id);
    return p;
  }

  static Observation obs(String id, String patientId, String categoryCode) {
    Observation o = new Observation();
    o.setId(id);
    o.setSubject(new Reference("Patient/" + patientId));
    o.addCategory(new CodeableConcept().addCoding(
        new org.hl7.fhir.r4.model.Coding("http://terminology.hl7.org/CodeSystem/observation-category", categoryCode, categoryCode)));
    return o;
  }

  public class PatientProvider implements IResourceProvider {
    @Override
    public Class<Patient> getResourceType() {
      return Patient.class;
    }

    @Read(version = true)
    public Patient read(@IdParam IdType id) {
      handlerCalls.incrementAndGet();
      return patient(id.getIdPart());
    }

    @Search
    public List<Patient> search(@OptionalParam(name = "_id") StringParam id,
        @OptionalParam(name = "family") StringParam family) {
      handlerCalls.incrementAndGet();
      return List.of(patient("p1"), patient("p2"));
    }

    @History
    public List<Patient> history(@IdParam IdType id) {
      handlerCalls.incrementAndGet();
      return List.of(patient(id.getIdPart()));
    }

    @Create
    public MethodOutcome create(@ResourceParam Patient p) {
      handlerCalls.incrementAndGet();
      return new MethodOutcome(new IdType("Patient/p9/_history/1"), true);
    }

    @Update
    public MethodOutcome update(@IdParam IdType id, @ResourceParam Patient p) {
      handlerCalls.incrementAndGet();
      return new MethodOutcome(new IdType("Patient/" + id.getIdPart() + "/_history/2"), false);
    }

    @Patch
    public MethodOutcome patch(@IdParam IdType id, PatchTypeEnum type, @ResourceParam String body) {
      handlerCalls.incrementAndGet();
      return new MethodOutcome(new IdType("Patient/" + id.getIdPart() + "/_history/3"), false);
    }

    @Delete
    public MethodOutcome delete(@IdParam IdType id) {
      handlerCalls.incrementAndGet();
      return new MethodOutcome();
    }
  }

  public class ObservationProvider implements IResourceProvider {
    @Override
    public Class<Observation> getResourceType() {
      return Observation.class;
    }

    @Read
    public Observation read(@IdParam IdType id) {
      handlerCalls.incrementAndGet();
      return obs(id.getIdPart(), "p1", "vital-signs");
    }

    /** o1: p1 vitals, o2: p2 vitals, o3: p1 laboratory. Ignores every filter on purpose. */
    @Search
    public List<Observation> search(@OptionalParam(name = "patient") StringParam patient,
        @OptionalParam(name = "category") StringParam category) {
      handlerCalls.incrementAndGet();
      return List.of(obs("o1", "p1", "vital-signs"), obs("o2", "p2", "vital-signs"), obs("o3", "p1", "laboratory"));
    }

    @Create
    public MethodOutcome create(@ResourceParam Observation o) {
      handlerCalls.incrementAndGet();
      return new MethodOutcome(new IdType("Observation/o9/_history/1"), true);
    }
  }
}
