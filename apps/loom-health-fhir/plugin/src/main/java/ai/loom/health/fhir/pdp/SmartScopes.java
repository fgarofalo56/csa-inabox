package ai.loom.health.fhir.pdp;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * SMART v2 scopes read from the token the PDP has ALREADY verified, used only to FILTER what
 * comes back (the PDP decides whether the interaction may happen at all).
 *
 * <p>Grammar matches the PDP: {@code (patient|user|system)/(Type|*).letters[?category=value]},
 * letters a subsequence of {@code cruds} in that order. A scope that does not parse, has
 * out-of-order letters or carries any constraint other than {@code category} grants NOTHING.
 */
public final class SmartScopes {
  private static final Pattern SCOPE =
      Pattern.compile("^(patient|user|system)/(\\*|[A-Z][A-Za-z]+)\\.([cruds]+)(?:\\?category=(.+))?$");
  private static final String ORDER = "cruds";

  /** One parsed scope. {@code category} is empty when unconstrained. */
  public record Scope(String context, String type, String letters, String category) {}

  private final List<Scope> scopes;

  private SmartScopes(List<Scope> scopes) {
    this.scopes = scopes;
  }

  public static SmartScopes parse(String scopeClaim) {
    List<Scope> out = new ArrayList<>();
    if (scopeClaim != null) {
      for (String s : scopeClaim.trim().split("\\s+")) {
        Matcher m = SCOPE.matcher(s);
        if (m.matches() && inOrder(m.group(3))) {
          out.add(new Scope(m.group(1), m.group(2), m.group(3), m.group(4) == null ? "" : m.group(4)));
        }
      }
    }
    return new SmartScopes(out);
  }

  private static boolean inOrder(String letters) {
    int last = -1;
    for (char c : letters.toCharArray()) {
      int i = ORDER.indexOf(c);
      if (i <= last) {
        return false; // out of order or repeated: grants nothing (same as the PDP)
      }
      last = i;
    }
    return true;
  }

  public List<Scope> all() {
    return scopes;
  }

  /**
   * True only when these scopes can never hide a resource from a read: some non-patient scope
   * ({@code user/} or {@code system/}) with type {@code *}, letter {@code r} and no category
   * constraint. Used to decide whether the engine's {@code Bundle.total} is still truthful.
   */
  public boolean hidesNothing() {
    for (Scope s : scopes) {
      if (s.letters().contains("r") && s.type().equals("*") && s.category().isEmpty()
          && !s.context().equals("patient")) {
        return true;
      }
    }
    return false;
  }

  /**
   * May the caller see a resource of {@code type} (needs letter {@code r}), given the category
   * forms the resource carries and the patients that own it?
   *
   * @param owners patient ids owning the resource; EMPTY means unbound, which a {@code patient/}
   *     scope never covers (matches the PDP: an unbound target under patient scope denies)
   * @param tokenPatient the token's {@code patient} claim (may be empty)
   */
  public boolean canRead(String type, Set<String> categories, Set<String> owners, String tokenPatient) {
    for (Scope s : scopes) {
      if (!s.letters().contains("r")) {
        continue;
      }
      if (!s.type().equals("*") && !s.type().equals(type)) {
        continue;
      }
      if (!s.category().isEmpty() && !categories.contains(s.category())) {
        continue;
      }
      if (s.context().equals("patient")) {
        if (tokenPatient == null || tokenPatient.isEmpty() || owners.isEmpty()) {
          continue;
        }
        boolean allMine = true;
        for (String o : owners) {
          allMine &= o.equals(tokenPatient);
        }
        if (!allMine) {
          continue;
        }
      }
      return true;
    }
    return false;
  }
}
