package ai.loom.health.fhir.audit;

import java.io.PrintStream;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Health of the audit trail itself. HIPAA 164.312(b) needs the recording mechanism to keep working,
 * and an audit sink that fails SILENTLY is the worst failure mode, so every failed write:
 * <ol>
 *   <li>increments {@link #failures()} (and {@link #lost()} when no sink took the record),</li>
 *   <li>emits one machine-readable alert line {@code {"lhds_audit_alert":1,...}} on the alert stream
 *       (the engine's stdout, same pipe as the audit rows, so the container log pipeline can alert on
 *       it; ASSUMPTION: the log-based alert rule is W8-4 / bicep work, nothing here creates it), and</li>
 *   <li>stays visible: {@link #degraded()} is sticky until restart, never reset by a later success.</li>
 * </ol>
 * The alert line names the sink and the exception class only, never the record or the exception
 * message (which can carry a path or a value).
 */
public final class AuditHealth {
  /** Process-wide instance used by the no-arg interceptor constructors. */
  public static final AuditHealth GLOBAL = new AuditHealth(System.out);

  private final PrintStream alertOut;
  private final AtomicLong failures = new AtomicLong();
  private final AtomicLong lost = new AtomicLong();

  public AuditHealth(PrintStream alertOut) {
    this.alertOut = alertOut;
  }

  /** Total sink write failures since start (a record written by one sink but not another counts per sink). */
  public long failures() {
    return failures.get();
  }

  /** Records NO sink accepted: the only way an audit row is actually lost. */
  public long lost() {
    return lost.get();
  }

  public boolean degraded() {
    return failures.get() > 0;
  }

  void sinkFailed(String sink, Throwable cause) {
    long n = failures.incrementAndGet();
    alert("sink-write-failed", sink, cause.getClass().getSimpleName(), n);
  }

  void recordLost(int sinkCount) {
    long n = lost.incrementAndGet();
    alert("audit-record-lost", "all(" + sinkCount + ")", "NoSinkAcceptedRecord", n);
  }

  private void alert(String reason, String sink, String error, long count) {
    String line = "{\"lhds_audit_alert\":1,\"reason\":\"" + reason + "\",\"sink\":\"" + sink
        + "\",\"error\":\"" + error + "\",\"count\":" + count + "}";
    alertOut.println(line);
    alertOut.flush();
    System.err.println(line); // a dead stdout must not hide it; the counter is the signal that never depends on a stream
  }
}
