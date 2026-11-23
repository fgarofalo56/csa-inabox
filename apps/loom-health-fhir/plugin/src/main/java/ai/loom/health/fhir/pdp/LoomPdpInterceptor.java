package ai.loom.health.fhir.pdp;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.interceptor.api.Hook;
import ca.uhn.fhir.interceptor.api.Interceptor;
import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.RestfulServer;
import ca.uhn.fhir.rest.server.exceptions.AuthenticationException;
import ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException;
import ca.uhn.fhir.rest.server.exceptions.UnclassifiedServerFailureException;
import ca.uhn.fhir.rest.server.servlet.ServletRequestDetails;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.hl7.fhir.instance.model.api.IBaseBundle;
import org.hl7.fhir.instance.model.api.IBaseResource;
import org.hl7.fhir.instance.model.api.IIdType;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.OperationOutcome;

/**
 * LHDS W2-3 authorization: asks the PDP about EVERY interaction before the engine does any
 * work, then filters what comes back by the token's SMART scopes.
 *
 * <p>Rules (CONTRACT-FREEZE-W2.md section 1, ADR-011):
 * <ul>
 *   <li>Only {@code result.allow == true} permits. Deny is 403.</li>
 *   <li>Timeout, connection error, non-200, malformed or empty result is 503, never 200.</li>
 *   <li>No bearer token is 401 and the PDP is not asked (there is nothing to verify).</li>
 *   <li>{@code request.tenant} comes from the engine config or the route, never the body.</li>
 *   <li>The capability statement ({@code GET /metadata}) is the one unauthenticated interaction
 *       (SMART discovery and probes); it is still audited and returns no clinical data.</li>
 * </ul>
 */
@Interceptor
public class LoomPdpInterceptor {
  private final PdpClient pdp;
  private final PluginConfig config;

  /** Instantiated by the HAPI starter from {@code hapi.fhir.custom-interceptor-classes}. */
  public LoomPdpInterceptor() {
    this(PluginConfig.fromEnv(System.getenv()));
  }

  private LoomPdpInterceptor(PluginConfig config) {
    this(
        config.pdpUrl().isEmpty() ? null : new HttpPdpClient(config.pdpUrl(), config.pdpTimeout()),
        config);
  }

  /** @param pdp null means "not configured": every request is answered 503 (fail closed). */
  public LoomPdpInterceptor(PdpClient pdp, PluginConfig config) {
    this.pdp = pdp;
    this.config = config;
  }

  /** Interaction names are the keys of data.lhds.interactions in the PDP bundle. */
  static String interactionOf(RestOperationTypeEnum t) {
    if (t == null) {
      return "unmapped:null";
    }
    switch (t) {
      case READ: return "read";
      case VREAD: return "vread";
      case HISTORY_INSTANCE:
      case HISTORY_TYPE:
      case HISTORY_SYSTEM: return "history";
      case SEARCH_TYPE:
      case SEARCH_SYSTEM:
      case GET_PAGE: return "search";
      case CREATE: return "create";
      case UPDATE: return "update";
      case PATCH: return "patch";
      case DELETE: return "delete";
      case EXTENDED_OPERATION_SERVER:
      case EXTENDED_OPERATION_TYPE:
      case EXTENDED_OPERATION_INSTANCE: return "operation";
      case TRANSACTION:
      case BATCH: return "operation";
      default: return "unmapped:" + t.name(); // PDP: unknown-interaction -> 403
    }
  }

  @Hook(Pointcut.SERVER_INCOMING_REQUEST_PRE_HANDLED)
  public void authorize(RequestDetails rd, ServletRequestDetails srd, RestOperationTypeEnum opType) {
    FhirContext ctx = rd.getFhirContext();
    String interaction = interactionOf(opType);
    String type = rd.getResourceName() == null ? "" : rd.getResourceName();
    IIdType id = rd.getId();
    String idPart = id == null ? "" : String.valueOf(id.getIdPart() == null ? "" : id.getIdPart());
    String op = interaction.equals("operation")
        ? (opType == RestOperationTypeEnum.TRANSACTION || opType == RestOperationTypeEnum.BATCH
            ? "$" + opType.name().toLowerCase() : String.valueOf(rd.getOperation()))
        : "";
    if (interaction.equals("operation") && type.isEmpty()) {
      type = (opType == RestOperationTypeEnum.TRANSACTION || opType == RestOperationTypeEnum.BATCH)
          ? "Bundle" : "*";
    }
    if (type.isEmpty()) {
      type = "*"; // system-level search/history: only a wildcard-type scope can cover it
    }
    String tenant = config.resolveTenant(pathOf(srd));

    if (opType == RestOperationTypeEnum.METADATA) {
      rd.getUserData().put(PdpOutcome.KEY, outcome(tenant, "capabilities", "", "", "", List.of(),
          "permit", "public-metadata", "", 0, TokenView.EMPTY));
      return;
    }

    if (tenant == null) {
      // No configured (valid) tenant: fail closed rather than guess one from the URL.
      rd.getUserData().put(PdpOutcome.KEY, outcome(null, interaction, type, idPart, op, List.of(),
          "error", "tenant-unconfigured", "", 503, TokenView.EMPTY));
      throw new UnclassifiedServerFailureException(503, "Engine tenant not configured");
    }

    String auth = rd.getHeader("Authorization");
    if (auth == null || !auth.regionMatches(true, 0, "Bearer ", 0, 7) || auth.length() <= 7) {
      rd.getUserData().put(PdpOutcome.KEY, outcome(tenant, interaction, type, idPart, op, List.of(),
          "deny", "no-token", "", 401, TokenView.EMPTY));
      throw new AuthenticationException("Bearer token required");
    }
    String token = auth.substring(7).trim();

    Set<String> compartment = new LinkedHashSet<>();
    Set<String> categories = new LinkedHashSet<>();
    resolveFromRequest(ctx, rd, type, idPart, compartment, categories);

    Map<String, Object> request = new LinkedHashMap<>();
    request.put("service", "fhir");
    request.put("interaction", interaction);
    request.put("tenant", tenant == null ? "" : tenant);
    request.put("base", publicBase(rd, srd));
    request.put("resource_type", type);
    if (!op.isEmpty()) {
      request.put("op", op);
    }
    request.put("patient_compartment", new ArrayList<>(compartment));
    request.put("categories", new ArrayList<>(categories));

    PdpDecision d;
    if (pdp == null) {
      rd.getUserData().put(PdpOutcome.KEY, outcome(tenant, interaction, type, idPart, op,
          new ArrayList<>(compartment), "error", "pdp-not-configured", "", 503, TokenView.EMPTY));
      throw new UnclassifiedServerFailureException(503, "Authorization service not configured");
    }
    try {
      d = pdp.decide(token, request);
    } catch (PdpUnavailableException | RuntimeException e) {
      // Any RuntimeException (NPE, IllegalArgumentException from a bad URL, ...) is "could not decide":
      // 503, labelled as an error in the audit, never an unhandled 500 mislabelled as a permit/deny.
      String code = e instanceof PdpUnavailableException pe ? pe.code() : "pdp-internal-error";
      rd.getUserData().put(PdpOutcome.KEY, outcome(tenant, interaction, type, idPart, op,
          new ArrayList<>(compartment), "error", code, "", 503, TokenView.EMPTY));
      throw new UnclassifiedServerFailureException(503, "Authorization service unavailable");
    }
    if (!d.allow()) {
      // Reason goes to the audit record only; the client gets no hint which rule fired.
      rd.getUserData().put(PdpOutcome.KEY, outcome(tenant, interaction, type, idPart, op,
          new ArrayList<>(compartment), "deny", d.reason(), d.policyVersion(), 403, TokenView.EMPTY));
      throw new ForbiddenOperationException("Access denied");
    }
    // allow==true means the PDP verified this exact token, so its claims are now trustworthy labels.
    TokenView tv = TokenView.of(token);
    rd.getUserData().put(PdpOutcome.KEY, outcome(tenant, interaction, type, idPart, op,
        new ArrayList<>(compartment), "permit", d.reason(), d.policyVersion(), 0, tv));
    rd.getUserData().put(TokenView.class.getName(), tv);
    rd.getUserData().put(STATE_KEY, new Authorized(token, request));
  }

  private static final String STATE_KEY = "ai.loom.health.fhir.pdp.authorized";

  /** What the second (stored-resource) check needs; lives only on the request. */
  private record Authorized(String token, Map<String, Object> request) {}

  /**
   * UPDATE is authorized against the STORED resource as well as the new body. Without this a
   * {@code patient/*.cruds} token for p1 could PUT p2's Observation with {@code subject=Patient/p1}
   * (the body check passes) and take it over, and a category-constrained scope could overwrite a
   * resource of another category with a body that claims the allowed one. The JPA layer fires this
   * hook with the matched existing resource for plain AND conditional updates; it is null when the
   * update creates the resource, in which case the body check already was the whole decision.
   */
  @Hook(Pointcut.STORAGE_PRESTORAGE_RESOURCE_UPDATED)
  public void authorizeStored(IBaseResource oldResource, IBaseResource newResource, RequestDetails rd) {
    if (oldResource == null || rd == null) {
      return;
    }
    Authorized a = (Authorized) rd.getUserData().get(STATE_KEY);
    PdpOutcome out = (PdpOutcome) rd.getUserData().get(PdpOutcome.KEY);
    if (a == null || out == null) {
      return; // not an external request this interceptor authorized (internal job): nothing to re-check
    }
    FhirContext ctx = rd.getFhirContext();
    Map<String, Object> request = new LinkedHashMap<>(a.request());
    request.put("patient_compartment", new ArrayList<>(ResourceFacts.owners(ctx, oldResource)));
    request.put("categories", new ArrayList<>(ResourceFacts.categories(ctx, oldResource)));
    String code;
    int status;
    try {
      PdpDecision d = pdp.decide(a.token(), request);
      if (d.allow()) {
        return;
      }
      code = "stored-resource:" + d.reason();
      status = 403;
    } catch (PdpUnavailableException | RuntimeException e) {
      code = e instanceof PdpUnavailableException pe ? pe.code() : "pdp-internal-error";
      status = 503;
    }
    rd.getUserData().put(PdpOutcome.KEY, new PdpOutcome(out.tenant(), out.interaction(), out.resourceType(),
        out.resourceId(), out.op(), out.compartment(), status == 403 ? "deny" : "error", code,
        out.policyVersion(), status, out.subject(), out.clientId()));
    if (status == 403) {
      throw new ForbiddenOperationException("Access denied");
    }
    throw new UnclassifiedServerFailureException(503, "Authorization service unavailable");
  }

  /**
   * The server's PUBLIC base for the PDP's {@code request.base}: the configured server address
   * ({@code hapi.fhir.server_address}, the tenant's {@code <stampBaseUrl>/<tenant>/fhir}) WITHOUT the
   * facility-partition segment, no trailing slash. The PDP compares it exactly with the token {@code aud}
   * and the bundle's bases (authz.rego aud_ok), so it must name the tenant's public base whatever the transport.
   *
   * <p>Why not {@code rd.getFhirServerBase()}: with request tenant partitioning on, HAPI's
   * UrlBaseTenantIdentificationStrategy.massageServerBaseUrl appends "/" + the partition name to it
   * (RestfulServer.getServerBaseForRequest, 8.12.0), so it would be {@code .../fhir/<facility>} and never equal
   * a bundle base. The server-address strategy is asked directly instead of cutting the string; the string cut
   * is only the fallback when no RestfulServer is reachable.
   */
  static String publicBase(RequestDetails rd, ServletRequestDetails srd) {
    String base = null;
    try {
      if (srd != null && srd.getServer() instanceof RestfulServer rs && srd.getServletRequest() != null) {
        base = rs.getServerAddressStrategy()
            .determineServerBase(srd.getServletRequest().getServletContext(), srd.getServletRequest());
      }
    } catch (RuntimeException e) {
      base = null;
    }
    if (base == null || base.isBlank()) {
      base = rd.getFhirServerBase() == null ? "" : rd.getFhirServerBase();
      String partition = rd.getTenantId();
      while (base.endsWith("/")) {
        base = base.substring(0, base.length() - 1);
      }
      if (partition != null && !partition.isEmpty() && base.endsWith("/" + partition)) {
        base = base.substring(0, base.length() - partition.length() - 1);
      }
    }
    while (base.endsWith("/")) {
      base = base.substring(0, base.length() - 1);
    }
    return base;
  }

  private static String pathOf(ServletRequestDetails srd) {
    String uri = srd.getServletRequest() == null ? "" : srd.getServletRequest().getRequestURI();
    return uri == null ? "" : uri;
  }

  private static PdpOutcome outcome(String tenant, String interaction, String type, String id, String op,
      List<String> compartment, String decision, String reason, String policy, int status, TokenView tv) {
    return new PdpOutcome(tenant == null ? "" : tenant, interaction, type, id, op, compartment, decision,
        reason, policy, status, tv.subject(), tv.clientId());
  }

  /** Resolve patient_compartment / categories from the route, the query and (writes) the body. */
  private static void resolveFromRequest(FhirContext ctx, RequestDetails rd, String type, String idPart,
      Set<String> compartment, Set<String> categories) {
    if ("Patient".equals(type) && !idPart.isEmpty()) {
      compartment.add(idPart);
    }
    Map<String, String[]> params = rd.getParameters();
    if (params != null) {
      addParam(params.get("patient"), compartment, true);
      addParam(params.get("subject"), compartment, true);
      if ("Patient".equals(type)) {
        addParam(params.get("_id"), compartment, false);
      }
      addParam(params.get("category"), categories, false);
    }
    RestOperationTypeEnum t = rd.getRestOperationType();
    if (t == RestOperationTypeEnum.CREATE || t == RestOperationTypeEnum.UPDATE) {
      try {
        byte[] body = rd.loadRequestContents();
        if (body != null && body.length > 0) {
          String s = new String(body, java.nio.charset.StandardCharsets.UTF_8);
          IBaseResource r = s.stripLeading().startsWith("{")
              ? ctx.newJsonParser().parseResource(s) : ctx.newXmlParser().parseResource(s);
          if (!"Patient".equals(type) || compartment.isEmpty()) {
            compartment.addAll(ResourceFacts.owners(ctx, r));
          }
          categories.addAll(ResourceFacts.categories(ctx, r));
        }
      } catch (RuntimeException e) {
        // unparseable body: leave compartment/categories empty (unbound), the engine will 400 it
      }
    }
  }

  private static void addParam(String[] values, Set<String> into, boolean stripPatientPrefix) {
    if (values == null) {
      return;
    }
    for (String v : values) {
      for (String piece : v.split(",")) {
        String p = piece.trim();
        if (stripPatientPrefix && p.startsWith("Patient/")) {
          p = p.substring("Patient/".length());
        }
        if (!p.isEmpty()) {
          into.add(p);
        }
      }
    }
  }

  /**
   * Response filtering. Applies to read, vread, history and search only (writes return what the
   * caller just wrote). A search or history bundle loses every entry the token's scopes do not
   * cover (this is what stops {@code _include} / {@code _revinclude} leaking other types or other
   * patients); a single resource the scopes do not cover becomes 403.
   */
  @Hook(Pointcut.SERVER_OUTGOING_RESPONSE)
  public boolean filterResponse(RequestDetails rd, IBaseResource response) {
    PdpOutcome out = (PdpOutcome) rd.getUserData().get(PdpOutcome.KEY);
    TokenView tv = (TokenView) rd.getUserData().get(TokenView.class.getName());
    if (out == null || tv == null || !"permit".equals(out.decision())) {
      return true;
    }
    String ix = out.interaction();
    if (!(ix.equals("read") || ix.equals("vread") || ix.equals("history") || ix.equals("search"))) {
      return true;
    }
    FhirContext ctx = rd.getFhirContext();
    SmartScopes scopes = SmartScopes.parse(tv.scope());
    if (response instanceof IBaseBundle) {
      Bundle b = (Bundle) response;
      FilterOutcome.Builder fo = new FilterOutcome.Builder();
      b.getEntry().removeIf(e -> {
        if (!e.hasResource()) {
          return false;
        }
        boolean keep = visible(ctx, scopes, e.getResource(), tv);
        if (!(e.getResource() instanceof OperationOutcome)) {
          Set<String> owners = ResourceFacts.owners(ctx, e.getResource());
          if (keep) {
            fo.kept(owners);
          } else {
            fo.removed(owners);
          }
        }
        return !keep;
      });
      rd.getUserData().put(FilterOutcome.KEY, fo.build());
      // Bundle.total is the engine's count of the UNFILTERED match set (and _summary=count carries no
      // entries to subtract). Neither the entry count (a lie: it is one page) nor the engine's total
      // (a leak: it counts what the caller may not see) is safe, and a policy-aware count would need the
      // whole result set walked per request. So total is kept only when the token's scopes cannot hide
      // anything, and omitted otherwise: absent is honest, a wrong or leaking number is not.
      if (b.hasTotal() && !scopes.hidesNothing()) {
        b.setTotalElement(null);
      }
      return true;
    }
    if (response instanceof OperationOutcome) {
      return true;
    }
    if (!visible(ctx, scopes, response, tv)) {
      rd.getUserData().put(FilterOutcome.KEY,
          new FilterOutcome(List.of(), new ArrayList<>(ResourceFacts.owners(ctx, response)), 1));
      rd.getUserData().put(PdpOutcome.KEY, new PdpOutcome(out.tenant(), out.interaction(), out.resourceType(),
          out.resourceId(), out.op(), out.compartment(), "deny", "response-not-in-scope", out.policyVersion(),
          403, out.subject(), out.clientId()));
      throw new ForbiddenOperationException("Access denied");
    }
    rd.getUserData().put(FilterOutcome.KEY,
        new FilterOutcome(new ArrayList<>(ResourceFacts.owners(ctx, response)), List.of(), 0));
    return true;
  }

  private static boolean visible(FhirContext ctx, SmartScopes scopes, IBaseResource r, TokenView tv) {
    String type = ctx.getResourceType(r);
    if (type.equals("OperationOutcome")) {
      return true;
    }
    return scopes.canRead(type, ResourceFacts.categories(ctx, r), ResourceFacts.owners(ctx, r), tv.patient());
  }
}
