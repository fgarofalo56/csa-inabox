package ai.loom.health.fhir.pdp;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.util.FhirTerser;
import java.util.LinkedHashSet;
import java.util.Set;
import org.hl7.fhir.instance.model.api.IBase;
import org.hl7.fhir.instance.model.api.IBaseReference;
import org.hl7.fhir.instance.model.api.IBaseResource;
import org.hl7.fhir.r4.model.CodeableConcept;
import org.hl7.fhir.r4.model.Coding;

/**
 * Engine-side resolution of the two PROVISIONAL PDP input fields from a resource
 * (CONFIRMED by W2-3, see apps/loom-health-pdp/input-contract.json):
 * <ul>
 *   <li>{@code patient_compartment}: the Patient id for a Patient, else the Patient ids named by
 *       {@code subject}, {@code patient} or {@code beneficiary}. A resource with none is UNBOUND (empty).</li>
 *   <li>{@code categories}: for every {@code category} coding, both {@code code} and
 *       {@code system|code}. The PDP compares by exact string; nothing is normalised here.</li>
 * </ul>
 */
public final class ResourceFacts {
  private static final String[] OWNER_PATHS = {"subject", "patient", "beneficiary"};

  private ResourceFacts() {}

  public static Set<String> owners(FhirContext ctx, IBaseResource r) {
    Set<String> out = new LinkedHashSet<>();
    String type = ctx.getResourceType(r);
    if ("Patient".equals(type)) {
      String id = r.getIdElement() == null ? null : r.getIdElement().getIdPart();
      if (id != null && !id.isEmpty()) {
        out.add(id);
      }
      return out;
    }
    FhirTerser t = ctx.newTerser();
    for (String p : OWNER_PATHS) {
      if (ctx.getResourceDefinition(r).getChildByName(p) == null) {
        continue; // the terser throws for a path the type does not define
      }
      for (IBase v : t.getValues(r, p)) {
        if (v instanceof IBaseReference ref && ref.getReferenceElement() != null) {
          var e = ref.getReferenceElement();
          if ("Patient".equals(e.getResourceType()) && e.getIdPart() != null && !e.getIdPart().isEmpty()) {
            out.add(e.getIdPart());
          }
        }
      }
    }
    return out;
  }

  public static Set<String> categories(FhirContext ctx, IBaseResource r) {
    Set<String> out = new LinkedHashSet<>();
    if (ctx.getResourceDefinition(r).getChildByName("category") == null) {
      return out; // e.g. Patient: the terser throws for a path the type does not define
    }
    for (IBase v : ctx.newTerser().getValues(r, "category")) {
      if (v instanceof CodeableConcept cc) {
        for (Coding c : cc.getCoding()) {
          if (c.getCode() != null) {
            out.add(c.getCode());
            if (c.getSystem() != null) {
              out.add(c.getSystem() + "|" + c.getCode());
            }
          }
        }
      }
    }
    return out;
  }
}
