package ai.loom.health.fhir.partition;

import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.tenant.ITenantIdentificationStrategy;
import ca.uhn.fhir.rest.server.tenant.UrlBaseTenantIdentificationStrategy;
import ca.uhn.fhir.util.UrlPathTokenizer;

/**
 * URL-base partitioning in which the BARE tenant base serves HAPI's DEFAULT partition (#5489, operator decision
 * 2026-11-25; ADR-003 amendment).
 *
 * <p>HAPI's {@link UrlBaseTenantIdentificationStrategy} (8.12.0) maps a first path token of {@code metadata} or
 * {@code $op} to DEFAULT and otherwise CONSUMES the first token as the partition name. Behind the SMART AS, which
 * advertises the bare base {@code {edge}/{tenant}/fhir}, that made {@code GET {base}/Patient?_count=1} a 400 (no
 * partition named "Patient") and {@code GET {base}/Patient/abc} a 404 ("abc" read as the resource type).
 *
 * <p>This strategy behaves exactly like HAPI's, except:
 * <ul>
 *   <li>a first token that is a FHIR resource type of the server's {@code FhirContext} (or no token at all, i.e. a
 *       transaction / batch POSTed to the base) selects DEFAULT and is NOT consumed;</li>
 *   <li>{@link #massageServerBaseUrl} never appends {@code /DEFAULT}: the bare base IS the DEFAULT partition's
 *       address, so Location headers, Bundle links and fullUrls stay at the base the client used. Every other
 *       partition still gets its {@code /<facility>} segment, exactly as before.</li>
 *   <li>a {@code SystemRequestDetails} whose first token is a resource type also selects DEFAULT (HAPI consumed
 *       that token as a partition name).</li>
 * </ul>
 *
 * <p>No ambiguity with a facility: a facility name must match {@code ^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$} (the CP's
 * {@code PARTITION_NAME} in apps/loom-health-cp/src/jobs/fhir-tenant-config.ts and {@link DesiredPartitions#NAME}),
 * so it is lowercase by construction, and every FHIR resource type starts with an uppercase letter. Membership is
 * tested against {@code FhirContext.getResourceTypes()} rather than "starts uppercase", so an explicit
 * {@code /DEFAULT/...} (HAPI's own admin path, e.g. partition management) is still consumed as a partition name.
 * Pinned by BareBaseDefaultPartitionTest.
 */
public final class LoomTenantIdentificationStrategy implements ITenantIdentificationStrategy {
  /** HAPI's built-in default partition name (id 0), the value its own strategy sets for metadata and $op. */
  public static final String DEFAULT_PARTITION = "DEFAULT";

  private final UrlBaseTenantIdentificationStrategy hapi = new UrlBaseTenantIdentificationStrategy();

  @Override
  public void extractTenant(UrlPathTokenizer tokenizer, RequestDetails rd) {
    if (!tokenizer.hasMoreTokens() || isResourceType(tokenizer.peek(), rd)) {
      // peek() does not consume: the resource type stays the first token RestfulServer parses.
      rd.setTenantId(DEFAULT_PARTITION);
      return;
    }
    hapi.extractTenant(tokenizer, rd);
  }

  @Override
  public String massageServerBaseUrl(String fhirServerBase, RequestDetails rd) {
    if (DEFAULT_PARTITION.equals(rd.getTenantId())) {
      return fhirServerBase;
    }
    return hapi.massageServerBaseUrl(fhirServerBase, rd);
  }

  /**
   * Unchanged from HAPI: a transaction sub-request {@code Patient/1} under a DEFAULT parent becomes
   * {@code DEFAULT/Patient/1}, which {@link #extractTenant} consumes as the DEFAULT partition (the same partition the
   * bare base serves), and {@link #massageServerBaseUrl} still adds no segment.
   */
  @Override
  public String resolveRelativeUrl(String relativeUrl, RequestDetails rd) {
    return hapi.resolveRelativeUrl(relativeUrl, rd);
  }

  static boolean isResourceType(String token, RequestDetails rd) {
    return token != null && !token.isEmpty() && rd.getFhirContext().getResourceTypes().contains(token);
  }
}
