package ai.loom.health.fhir.audit;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.io.PrintStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.List;

/** The two sinks W2-3 ships, and the composite that counts and alerts their failures. */
public final class AuditSinks {
  private static final ObjectMapper JSON = new ObjectMapper();

  private AuditSinks() {}

  /** The {@code LhdsAudit_CL} row plus the AuditEvent, as one JSON object. */
  public static String line(AuditRecord r, String auditEventJson) {
    ObjectNode n = JSON.createObjectNode();
    n.put("lhds_audit", 1);
    n.put("TimeGenerated", r.recorded());
    n.put("RequestId", r.requestId());
    n.put("Tenant", r.tenant());
    n.put("Interaction", r.interaction());
    n.put("ResourceType", r.resourceType());
    n.put("ResourceId", r.resourceId());
    n.put("Operation", r.op());
    n.put("Decision", r.decision());
    n.put("Reason", r.reason());
    n.put("PolicyVersion", r.policyVersion());
    n.put("Status", r.status());
    n.put("Subject", r.subject());
    n.put("ClientId", r.clientId());
    n.put("RemoteAddr", r.remoteAddr());
    n.set("Patient", JSON.valueToTree(r.patient()));
    n.set("ParamNames", JSON.valueToTree(r.paramNames()));
    n.set("PatientsReturned", JSON.valueToTree(r.patientsReturned()));
    n.set("PatientsHidden", JSON.valueToTree(r.patientsHidden()));
    n.put("HiddenResourceCount", r.hiddenResourceCount());
    try {
      JsonNode ae = JSON.readTree(auditEventJson);
      n.set("AuditEvent", ae);
      return JSON.writeValueAsString(n);
    } catch (JsonProcessingException e) {
      throw new IllegalStateException(e);
    }
  }

  /** A sink with a stable name for the failure counter and the alert line. */
  private static final class Named implements AuditSink {
    private final String name;
    private final AuditSink delegate;

    Named(String name, AuditSink delegate) {
      this.name = name;
      this.delegate = delegate;
    }

    @Override
    public void emit(AuditRecord record, String auditEventJson) {
      delegate.emit(record, auditEventJson);
    }
  }

  /**
   * One JSON line per interaction on the given stream (the engine's stdout). The container log
   * pipeline maps lines with {@code "lhds_audit":1} into {@code LhdsAudit_CL}. ASSUMPTION: the table
   * and its DCR are W8-4 / bicep work; nothing in this plugin creates them. {@link PrintStream}
   * never throws, so a failed write is detected with {@code checkError()} and RAISED, otherwise a
   * broken stdout would look like a successful audit.
   */
  public static AuditSink stream(PrintStream out) {
    return new Named("stdout", (r, ae) -> {
      out.println(line(r, ae));
      out.flush();
      if (out.checkError()) {
        throw new UncheckedIOException(new IOException("audit stream write failed"));
      }
    });
  }

  /**
   * Append-only JSONL files, one per UTC hour ({@code audit-yyyyMMddHH.jsonl}): the staging area
   * W8-4 seals into immutable chained blobs. Not itself immutable. Each row is written with
   * {@code DSYNC}, so a write that returned is on the device, not in the page cache (a crash right
   * after the response cannot take it with it). A failure is RAISED (the composite counts and
   * alerts it); it is never swallowed here.
   */
  public static AuditSink hourlyFiles(Path dir) {
    DateTimeFormatter hour = DateTimeFormatter.ofPattern("yyyyMMddHH");
    return new Named("hourly-files", (r, ae) -> {
      try {
        Files.createDirectories(dir);
        Path f = dir.resolve("audit-" + OffsetDateTime.now(ZoneOffset.UTC).format(hour) + ".jsonl");
        Files.writeString(f, line(r, ae) + "\n", StandardCharsets.UTF_8,
            StandardOpenOption.CREATE, StandardOpenOption.APPEND, StandardOpenOption.DSYNC);
      } catch (IOException e) {
        throw new UncheckedIOException(e);
      }
    });
  }

  /** {@link #all(List, AuditHealth)} reporting to the process-wide {@link AuditHealth#GLOBAL}. */
  public static AuditSink all(List<AuditSink> sinks) {
    return all(sinks, AuditHealth.GLOBAL);
  }

  /**
   * Fan one record out to every sink. DESIGN (non-lossy by redundancy, not by blocking): a record
   * is lost only if EVERY sink fails; the interaction is never failed after the fact (the response
   * is already decided); and every failing sink is counted and alerted via {@code health}, so an
   * operator learns of a broken sink while the others still hold the trail. A record that no sink
   * accepted additionally bumps {@link AuditHealth#lost()}.
   */
  public static AuditSink all(List<AuditSink> sinks, AuditHealth health) {
    return (r, ae) -> {
      int failed = 0;
      for (int i = 0; i < sinks.size(); i++) {
        AuditSink s = sinks.get(i);
        try {
          s.emit(r, ae);
        } catch (RuntimeException e) {
          failed++;
          health.sinkFailed(s instanceof Named n ? n.name : "sink[" + i + "]", e);
        }
      }
      if (!sinks.isEmpty() && failed == sinks.size()) {
        health.recordLost(sinks.size());
      }
    };
  }
}
