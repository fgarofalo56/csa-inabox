package ai.loom.health.fhir.audit;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.List;

/** The two sinks W2-3 ships. */
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
    try {
      JsonNode ae = JSON.readTree(auditEventJson);
      n.set("AuditEvent", ae);
      return JSON.writeValueAsString(n);
    } catch (JsonProcessingException e) {
      throw new IllegalStateException(e);
    }
  }

  /**
   * One JSON line per interaction on the given stream (the engine's stdout). The container log
   * pipeline maps lines with {@code "lhds_audit":1} into {@code LhdsAudit_CL}. ASSUMPTION: the table
   * and its DCR are W8-4 / bicep work; nothing in this plugin creates them.
   */
  public static AuditSink stream(PrintStream out) {
    return (r, ae) -> {
      out.println(line(r, ae));
      out.flush();
    };
  }

  /**
   * Append-only JSONL files, one per UTC hour ({@code audit-yyyyMMddHH.jsonl}): the staging area
   * W8-4 seals into immutable chained blobs. Not itself immutable.
   */
  public static AuditSink hourlyFiles(Path dir) {
    DateTimeFormatter hour = DateTimeFormatter.ofPattern("yyyyMMddHH");
    return (r, ae) -> {
      try {
        Files.createDirectories(dir);
        Path f = dir.resolve("audit-" + OffsetDateTime.now(ZoneOffset.UTC).format(hour) + ".jsonl");
        Files.writeString(f, line(r, ae) + "\n", StandardCharsets.UTF_8,
            StandardOpenOption.CREATE, StandardOpenOption.APPEND);
      } catch (IOException e) {
        System.err.println("lhds-audit: store write failed: " + e.getClass().getSimpleName());
      }
    };
  }

  public static AuditSink all(List<AuditSink> sinks) {
    return (r, ae) -> {
      for (AuditSink s : sinks) {
        try {
          s.emit(r, ae);
        } catch (RuntimeException e) {
          System.err.println("lhds-audit: sink failed: " + e.getClass().getSimpleName());
        }
      }
    };
  }
}
