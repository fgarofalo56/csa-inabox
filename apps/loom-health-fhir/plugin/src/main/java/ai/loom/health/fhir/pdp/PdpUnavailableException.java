package ai.loom.health.fhir.pdp;

/**
 * The PDP could not give a decision: timeout, connection error, non-200, unparseable
 * body, or a reply with no {@code result} (OPA returns {@code {}} for undefined).
 * The interceptor maps this to HTTP 503 and never to a permit (fail closed, ADR-011).
 */
public final class PdpUnavailableException extends Exception {
  private static final long serialVersionUID = 1L;

  /** Short machine-readable cause for the audit record, e.g. {@code pdp-timeout}. */
  private final String code;

  public PdpUnavailableException(String code, String message, Throwable cause) {
    super(message, cause);
    this.code = code;
  }

  public String code() {
    return code;
  }
}
