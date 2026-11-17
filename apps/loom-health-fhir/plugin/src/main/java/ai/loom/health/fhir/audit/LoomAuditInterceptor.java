package ai.loom.health.fhir.audit;

import ai.loom.health.fhir.pdp.FilterOutcome;
import ai.loom.health.fhir.pdp.PdpOutcome;
import ai.loom.health.fhir.pdp.PluginConfig;
import ca.uhn.fhir.interceptor.api.Hook;
import ca.uhn.fhir.interceptor.api.Interceptor;
import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException;
import ca.uhn.fhir.rest.server.servlet.ServletRequestDetails;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Writes exactly ONE audit record per interaction, on {@code SERVER_PROCESSING_COMPLETED}, which
 * HAPI fires for permitted, denied (401/403) and failed (503, 404, 500) requests alike. The
 * record is built from the {@link PdpOutcome} the PDP interceptor left behind; if that
 * interceptor is not registered the record says {@code decision=none} (a loud gap, not a
 * silent one).
 */
@Interceptor
public class LoomAuditInterceptor {
  private static final String EMITTED = "ai.loom.health.fhir.audit.emitted";
  private static final String FAILED_STATUS = "ai.loom.health.fhir.audit.status";

  private final AuditSink sink;
  private final TrustedProxies proxies;
  private final String forwardedHeader;

  /** Instantiated by the HAPI starter from {@code hapi.fhir.custom-interceptor-classes}. */
  public LoomAuditInterceptor() {
    this(PluginConfig.fromEnv(System.getenv()));
  }

  private LoomAuditInterceptor(PluginConfig c) {
    this(defaultSink(c), c);
  }

  /** No trusted proxy: the audit records the TCP peer and never reads a forwarded header. */
  public LoomAuditInterceptor(AuditSink sink) {
    this.sink = sink;
    this.proxies = TrustedProxies.NONE;
    this.forwardedHeader = "X-Forwarded-For";
  }

  public LoomAuditInterceptor(AuditSink sink, PluginConfig config) {
    this.sink = sink;
    this.proxies = TrustedProxies.parse(config.trustedProxies());
    this.forwardedHeader = config.forwardedHeader();
  }

  /**
   * Stdout always (the container log pipeline), plus the DSYNC'd hourly files when
   * {@code LOOM_HEALTH_AUDIT_DIR} is set. Stdout alone is only as durable as the log pipeline; the
   * file sink is the local, synced second copy, and a record is lost only if both fail (counted and
   * alerted via {@link AuditHealth}).
   */
  private static AuditSink defaultSink(PluginConfig c) {
    List<AuditSink> sinks = new ArrayList<>();
    sinks.add(AuditSinks.stream(System.out));
    if (!c.auditDir().isEmpty()) {
      sinks.add(AuditSinks.hourlyFiles(Path.of(c.auditDir())));
    }
    return AuditSinks.all(sinks, AuditHealth.GLOBAL);
  }

  /** The client address: the forwarded header only when the TCP peer is a trusted proxy. */
  private String clientAddress(HttpServletRequest req) {
    if (req == null || req.getRemoteAddr() == null) {
      return "";
    }
    String peer = req.getRemoteAddr();
    if (!proxies.isTrusted(peer)) {
      return peer; // never even read the header for an untrusted peer
    }
    StringBuilder joined = new StringBuilder();
    java.util.Enumeration<String> values = req.getHeaders(forwardedHeader);
    while (values != null && values.hasMoreElements()) {
      if (joined.length() > 0) {
        joined.append(',');
      }
      joined.append(values.nextElement());
    }
    return proxies.clientAddress(peer, joined.toString());
  }

  /** Remember the failure status of an error raised AFTER authorization let the request through. */
  @Hook(Pointcut.SERVER_HANDLE_EXCEPTION)
  public boolean onException(RequestDetails rd, ServletRequestDetails srd, BaseServerResponseException e,
      HttpServletRequest req, HttpServletResponse resp) {
    rd.getUserData().put(FAILED_STATUS, e.getStatusCode());
    return true;
  }

  @Hook(Pointcut.SERVER_PROCESSING_COMPLETED)
  public void completed(RequestDetails rd, ServletRequestDetails srd) {
    if (rd.getUserData().put(EMITTED, Boolean.TRUE) != null) {
      return; // at most once per request
    }
    PdpOutcome o = (PdpOutcome) rd.getUserData().get(PdpOutcome.KEY);
    Integer failed = (Integer) rd.getUserData().get(FAILED_STATUS);
    int status = o != null && o.status() != 0 ? o.status() : failed != null ? failed : 0;
    FilterOutcome fo = rd.getUserData().get(FilterOutcome.KEY) instanceof FilterOutcome f ? f : FilterOutcome.NONE;
    HttpServletRequest req = srd == null ? null : srd.getServletRequest();
    List<String> names = new ArrayList<>(rd.getParameters() == null ? List.<String>of() : rd.getParameters().keySet());
    java.util.Collections.sort(names);
    AuditRecord r = new AuditRecord(
        rd.getRequestId() == null ? "" : rd.getRequestId(),
        Instant.now().toString(),
        o == null ? "" : o.tenant(),
        o == null ? String.valueOf(rd.getRestOperationType()) : o.interaction(),
        o == null ? String.valueOf(rd.getResourceName() == null ? "" : rd.getResourceName()) : o.resourceType(),
        o == null ? "" : o.resourceId(),
        o == null ? "" : o.op(),
        o == null ? List.of() : o.compartment(),
        names,
        o == null ? "none" : o.decision(),
        o == null ? "pdp-interceptor-absent" : o.reason(),
        o == null ? "" : o.policyVersion(),
        status,
        o == null ? "" : o.subject(),
        o == null ? "" : o.clientId(),
        clientAddress(req),
        fo.returned(),
        fo.hidden(),
        fo.hiddenCount());
    sink.emit(r, AuditEvents.toJson(r));
  }
}
