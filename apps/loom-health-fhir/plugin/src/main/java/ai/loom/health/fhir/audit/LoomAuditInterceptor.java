package ai.loom.health.fhir.audit;

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

  /** Instantiated by the HAPI starter from {@code hapi.fhir.custom-interceptor-classes}. */
  public LoomAuditInterceptor() {
    this(defaultSink(PluginConfig.fromEnv(System.getenv())));
  }

  public LoomAuditInterceptor(AuditSink sink) {
    this.sink = sink;
  }

  private static AuditSink defaultSink(PluginConfig c) {
    List<AuditSink> sinks = new ArrayList<>();
    sinks.add(AuditSinks.stream(System.out));
    if (!c.auditDir().isEmpty()) {
      sinks.add(AuditSinks.hourlyFiles(Path.of(c.auditDir())));
    }
    return AuditSinks.all(sinks);
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
        req == null || req.getRemoteAddr() == null ? "" : req.getRemoteAddr());
    sink.emit(r, AuditEvents.toJson(r));
  }
}
