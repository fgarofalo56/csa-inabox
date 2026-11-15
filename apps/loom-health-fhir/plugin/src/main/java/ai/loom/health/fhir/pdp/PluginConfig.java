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
 *   <li>{@code LOOM_HEALTH_TENANT}: when set, the engine serves exactly that tenant (one
 *       engine per tenant, ADR-003) and the tenant is NEVER read from the URL. When unset the
 *       tenant is the first path segment of {@code /<tenant>/fhir/...}.</li>
 *   <li>{@code LOOM_HEALTH_AUDIT_DIR}: optional append-only JSONL audit store directory.</li>
 * </ul>
 */
public record PluginConfig(String pdpUrl, Duration pdpTimeout, String fixedTenant, String auditDir) {
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
        env.getOrDefault("LOOM_HEALTH_AUDIT_DIR", "").trim());
  }

  /** Tenant slug, or null if neither the engine config nor the route yields a valid one. */
  public String resolveTenant(String requestPath) {
    if (!fixedTenant.isEmpty()) {
      return SLUG.matcher(fixedTenant).matches() ? fixedTenant : null;
    }
    java.util.regex.Matcher m = Pattern.compile("^/([^/]+)/fhir(?:/|$)").matcher(requestPath == null ? "" : requestPath);
    if (m.find() && SLUG.matcher(m.group(1)).matches()) {
      return m.group(1);
    }
    return null;
  }
}
