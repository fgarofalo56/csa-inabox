package ai.loom.health.fhir.partition;

import ca.uhn.fhir.interceptor.api.Hook;
import ca.uhn.fhir.interceptor.api.Interceptor;
import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.rest.api.server.RequestDetails;

/**
 * Keeps a search Bundle's {@code self} link correct at the bare base (#5489).
 *
 * <p>HAPI 8.12.0 {@code RestfulServerUtils.createLinkSelfWithoutGivenParameters} builds the self link as
 * {@code base + substringAfter(requestPath, tenantId)}: it assumes the tenant is the first segment of the request path.
 * When {@link LoomTenantIdentificationStrategy} implies DEFAULT for {@code Patient?...} the path has no tenant segment,
 * {@code substringAfter} returns "" and the link loses its resource type ({@code {base}?_count=1}, measured).
 * Offset paging links ({@code createOffsetPagingLink}) strip a leading {@code <tenant>/} only when present.
 *
 * <p>So, once RestfulServer has stored the request path (SERVER_INCOMING_REQUEST_PRE_HANDLER_SELECTED fires right after
 * {@code setRequestPath}; handler selection itself uses RestfulServer's local copy), an implied-DEFAULT path that starts
 * with a resource type is given the {@code DEFAULT/} segment those two helpers expect and then strip again. An explicit
 * {@code DEFAULT/...} or {@code <facility>/...} path does not start with a resource type and is left alone. Registered
 * by {@link LoomTenantStrategyConfiguration#install} together with the strategy, never separately.
 */
@Interceptor
public final class ImpliedDefaultPathInterceptor {
  @Hook(Pointcut.SERVER_INCOMING_REQUEST_PRE_HANDLER_SELECTED)
  public void prefixImpliedDefault(RequestDetails rd) {
    String path = rd.getRequestPath();
    if (path == null || path.isEmpty() || !LoomTenantIdentificationStrategy.DEFAULT_PARTITION.equals(rd.getTenantId())) {
      return;
    }
    int slash = path.indexOf('/');
    String first = slash < 0 ? path : path.substring(0, slash);
    if (LoomTenantIdentificationStrategy.isResourceType(first, rd)) {
      rd.setRequestPath(LoomTenantIdentificationStrategy.DEFAULT_PARTITION + "/" + path);
    }
  }
}
