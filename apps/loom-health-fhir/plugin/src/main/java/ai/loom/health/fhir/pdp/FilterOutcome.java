package ai.loom.health.fhir.pdp;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * What the response filter did to one response, left in {@code RequestDetails.userData} for the
 * audit interceptor. Patient IDS only (never a body, never a name): which patient compartments the
 * caller was shown and which were removed or refused.
 *
 * <p>The id lists are capped at {@link #MAX_IDS} each so one huge search cannot make an audit row
 * unbounded; {@code hiddenCount} is NOT capped and also counts unbound resources (no owner), so a
 * truncated list never under-reports how much was hidden.
 */
public record FilterOutcome(List<String> returned, List<String> hidden, int hiddenCount) {
  public static final String KEY = "ai.loom.health.fhir.pdp.filter-outcome";
  public static final int MAX_IDS = 100;
  public static final FilterOutcome NONE = new FilterOutcome(List.of(), List.of(), 0);

  /** Accumulates while the filter walks a bundle. */
  public static final class Builder {
    private final Set<String> returned = new LinkedHashSet<>();
    private final Set<String> hidden = new LinkedHashSet<>();
    private int hiddenCount;

    public void kept(Set<String> owners) {
      returned.addAll(owners);
    }

    public void removed(Set<String> owners) {
      hidden.addAll(owners);
      hiddenCount++;
    }

    public FilterOutcome build() {
      // A patient shown in one resource and hidden in another is reported in BOTH lists on purpose.
      return new FilterOutcome(cap(returned), cap(hidden), hiddenCount);
    }

    private static List<String> cap(Set<String> s) {
      List<String> all = new ArrayList<>(s);
      return all.size() > MAX_IDS ? new ArrayList<>(all.subList(0, MAX_IDS)) : all;
    }
  }
}
