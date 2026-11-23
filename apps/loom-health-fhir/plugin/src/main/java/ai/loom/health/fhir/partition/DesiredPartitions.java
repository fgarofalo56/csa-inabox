package ai.loom.health.fhir.partition;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Parses and validates {@code LOOM_HEALTH_PARTITIONS}: canonical JSON {@code [{"id":1,"name":"site-a"}, ...]} rendered by
 * apps/loom-health-cp/src/jobs/fhir-tenant-config.ts. The name pattern is the control plane's own
 * ({@code PARTITION_NAME} in fhir-tenant-jobs.ts); the two must agree, and anything the pattern refuses is refused here
 * too, because this is the side that writes to the database.
 */
public final class DesiredPartitions {
  public static final Pattern NAME = Pattern.compile("^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$");
  /** Name of HAPI's built-in default partition (id 0). It is never created, and a tenant partition may not shadow it. */
  public static final String RESERVED_DEFAULT = "DEFAULT";
  private static final ObjectMapper JSON = new ObjectMapper();

  private DesiredPartitions() {}

  public static List<DesiredPartition> parse(String json) {
    JsonNode root;
    try {
      root = JSON.readTree(json);
    } catch (Exception e) {
      throw new IllegalArgumentException("LOOM_HEALTH_PARTITIONS is not JSON", e);
    }
    if (root == null || !root.isArray()) {
      throw new IllegalArgumentException("LOOM_HEALTH_PARTITIONS must be a JSON array");
    }
    List<DesiredPartition> out = new ArrayList<>();
    Set<Integer> ids = new HashSet<>();
    Set<String> names = new HashSet<>();
    for (JsonNode n : root) {
      if (!n.isObject() || n.size() != 2 || !n.path("id").isInt() || !n.path("name").isTextual()) {
        throw new IllegalArgumentException("each partition must be exactly {\"id\": <int>, \"name\": <string>}");
      }
      int id = n.get("id").intValue();
      String name = n.get("name").textValue();
      if (id < 1) {
        throw new IllegalArgumentException("partition id " + id + " is refused: ids start at 1, 0 is the default partition");
      }
      if (!NAME.matcher(name).matches() || RESERVED_DEFAULT.equalsIgnoreCase(name)) {
        throw new IllegalArgumentException("partition name is refused (must match " + NAME.pattern() + " and not be the reserved DEFAULT)");
      }
      if (!ids.add(id) || !names.add(name)) {
        throw new IllegalArgumentException("partition list repeats an id or a name");
      }
      out.add(new DesiredPartition(id, name));
    }
    return List.copyOf(out);
  }
}
