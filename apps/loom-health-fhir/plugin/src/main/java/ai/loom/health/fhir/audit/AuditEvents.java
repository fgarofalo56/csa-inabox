package ai.loom.health.fhir.audit;

import ca.uhn.fhir.context.FhirContext;
import org.hl7.fhir.r4.model.AuditEvent;
import org.hl7.fhir.r4.model.Coding;
import org.hl7.fhir.r4.model.Reference;

/** Builds the R4 {@code AuditEvent} (rest interaction) for one {@link AuditRecord}. */
public final class AuditEvents {
  private static final FhirContext R4 = FhirContext.forR4Cached();

  private AuditEvents() {}

  static AuditEvent.AuditEventAction action(String interaction) {
    switch (interaction) {
      case "create": return AuditEvent.AuditEventAction.C;
      case "update":
      case "patch": return AuditEvent.AuditEventAction.U;
      case "delete": return AuditEvent.AuditEventAction.D;
      case "operation": return AuditEvent.AuditEventAction.E;
      default: return AuditEvent.AuditEventAction.R; // read, vread, history, search, capabilities
    }
  }

  /** FHIR outcome: 0 success, 4 minor failure (denied), 8 serious failure (could not decide / error). */
  static AuditEvent.AuditEventOutcome outcome(AuditRecord r) {
    if (r.decision().equals("deny")) {
      return AuditEvent.AuditEventOutcome._4;
    }
    if (r.decision().equals("error") || r.status() >= 500) {
      return AuditEvent.AuditEventOutcome._8;
    }
    if (r.status() >= 400) {
      return AuditEvent.AuditEventOutcome._4;
    }
    return AuditEvent.AuditEventOutcome._0;
  }

  public static String toJson(AuditRecord r) {
    AuditEvent ae = new AuditEvent();
    ae.setType(new Coding("http://terminology.hl7.org/CodeSystem/audit-event-type", "rest", "RESTful Operation"));
    ae.addSubtype(new Coding("http://hl7.org/fhir/restful-interaction", r.interaction(), r.interaction()));
    ae.setAction(action(r.interaction()));
    ae.setRecorded(java.util.Date.from(java.time.Instant.parse(r.recorded())));
    ae.setOutcome(outcome(r));
    ae.setOutcomeDesc(r.decision() + ": " + r.reason());
    AuditEvent.AuditEventAgentComponent agent = ae.addAgent();
    agent.setRequestor(true);
    agent.getWho().setDisplay(!r.clientId().isEmpty() ? r.clientId() : !r.subject().isEmpty() ? r.subject() : "unverified");
    if (!r.remoteAddr().isEmpty()) {
      agent.getNetwork().setAddress(r.remoteAddr());
      agent.getNetwork().setType(AuditEvent.AuditEventAgentNetworkType._2);
    }
    ae.getSource().setSite(r.tenant());
    ae.getSource().getObserver().setDisplay("loom-health-fhir");
    if (!r.resourceType().isEmpty() && !r.resourceType().equals("*")) {
      AuditEvent.AuditEventEntityComponent e = ae.addEntity();
      e.setWhat(new Reference(r.resourceId().isEmpty() ? r.resourceType() : r.resourceType() + "/" + r.resourceId()));
      if (!r.paramNames().isEmpty()) {
        e.addDetail().setType("search-parameter-names").setValue(new org.hl7.fhir.r4.model.StringType(String.join(",", r.paramNames())));
      }
    }
    for (String p : r.patient()) {
      ae.addEntity().setWhat(new Reference("Patient/" + p));
    }
    // What the response filter did, as patient ids only (never a body): returned vs hidden.
    for (String p : r.patientsReturned()) {
      AuditEvent.AuditEventEntityComponent e = ae.addEntity().setWhat(new Reference("Patient/" + p));
      e.addDetail().setType("filter-result").setValue(new org.hl7.fhir.r4.model.StringType("returned"));
    }
    for (String p : r.patientsHidden()) {
      AuditEvent.AuditEventEntityComponent e = ae.addEntity().setWhat(new Reference("Patient/" + p));
      e.addDetail().setType("filter-result").setValue(new org.hl7.fhir.r4.model.StringType("hidden"));
    }
    if (r.hiddenResourceCount() > 0) {
      ae.addEntity().addDetail().setType("hidden-resource-count")
          .setValue(new org.hl7.fhir.r4.model.StringType(String.valueOf(r.hiddenResourceCount())));
    }
    if (!r.policyVersion().isEmpty()) {
      ae.addEntity().addDetail().setType("policy_version").setValue(new org.hl7.fhir.r4.model.StringType(r.policyVersion()));
    }
    return R4.newJsonParser().encodeResourceToString(ae);
  }
}
