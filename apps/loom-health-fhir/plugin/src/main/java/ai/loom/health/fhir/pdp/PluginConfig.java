package ai.loom.health.fhir.pdp;

import java.time.Duration;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Environment-driven config for the no-arg interceptor constructors (the HAPI starter's
 * {@code hapi.fhir.custom-interceptor-classes} instantiates by class name).
 *
 * <p>ASSUMPTION (W2-2 not built): the per-tenant engine config supplies these env vars.
 * <ul>
 *   <li>{@code LOOM_HEALTH_PDP_URL}: in-cluster OPA base URL (required; no default so a
 *       misconfigured engine cannot silently skip authorization: it fails closed with 503).</li>
 *   <li>{@code LOOM_HEALTH_PDP_TIMEOUT_MS}: default 1500.</li>
 *   <li>{@code LOOM_HEALTH_TENANT}: REQUIRED. The engine serves exactly that tenant (one engine
 *       per tenant, ADR-003); the tenant is never read from the URL. Unset or invalid: every
 *       request is 503. {@code LOOM_HEALTH_TEST_ALLOW_PATH_TENANT=true} (tests only) re-enables the
 *       first path segment of {@code /<tenant>/fhir/...} as a fallback.</li>
 *   <li>{@code LOOM_HEALTH_AUDIT_DIR}: optional append-only JSONL audit store directory.</li>
 * </ul>
 */
public record PluginConfig(
    String pdpUrl, Duration pdpTimeout, String fixedTenant, String auditDir, boolean allowPathTenant) {
  private static final Pattern SLUG = Pattern.compile("^[a-z0-9][a-z0-9-]{0,62}$");

  public static PluginConfig fromEnv(Map<String, String> env) {
    long ms = 1500;
    String raw = env.getOrDefault("LOOM_HEALTH_PDP_TIMEOUT_MS", "");
    if (!raw.isBlank()) {
      try {
        ms = Math.max(50, Math.min(30_000, Long.parseLong(raw.trim())));
      } catch (NumberFormatException e) {
        ms = 1500;
      }
    }
    return new PluginConfig(
        env.getOrDefault("LOOM_HEALTH_PDP_URL", "").trim(),
        Duration.ofMillis(ms),
        env.getOrDefault("LOOM_HEALTH_TENANT", "").trim(),
        env.getOrDefault("LOOM_HEALTH_AUDIT_DIR", "").trim(),
        "true".equals(env.getOrDefault("LOOM_HEALTH_TEST_ALLOW_PATH_TENANT", "").trim()));
  }

  /** Tenant slug, or null if neither the engine config nor the route yields a valid one. */
  public String resolveTenant(String requestPath) {
    if (!fixedTenant.isEmpty()) {
      return SLUG.matcher(fixedTenant).matches() ? fixedTenant : null;
    }
    if (!allowPathTenant) {
      return null; // fail closed: an engine with no configured tenant must not guess one from the URL
    }
    java.util.regex.Matcher m = Pattern.compile("^/([^/]+)/fhir(?:/|$)").matcher(requestPath == null ? "" : requestPath);
    if (m.find() && SLUG.matcher(m.group(1)).matches()) {
      return m.group(1);
    }
    return null;
  }
}
