package ai.loom.health.fhir.pdp;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.interceptor.api.Hook;
import ca.uhn.fhir.interceptor.api.Interceptor;
import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.RequestDetails;
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
    request.put("base", rd.getFhirServerBase() == null ? "" : rd.getFhirServerBase());
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
    } catch (PdpUnavailableException e) {
      rd.getUserData().put(PdpOutcome.KEY, outcome(tenant, interaction, type, idPart, op,
          new ArrayList<>(compartment), "error", e.code(), "", 503, TokenView.EMPTY));
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
      b.getEntry().removeIf(e -> e.hasResource() && !visible(ctx, scopes, e.getResource(), tv));
      if (b.hasTotal()) {
        b.setTotal(b.getEntry().size()); // a total of the unfiltered set would leak how much was hidden
      }
      return true;
    }
    if (response instanceof OperationOutcome) {
      return true;
    }
    if (!visible(ctx, scopes, response, tv)) {
      rd.getUserData().put(PdpOutcome.KEY, new PdpOutcome(out.tenant(), out.interaction(), out.resourceType(),
          out.resourceId(), out.op(), out.compartment(), "deny", "response-not-in-scope", out.policyVersion(),
          403, out.subject(), out.clientId()));
      throw new ForbiddenOperationException("Access denied");
    }
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
