package ai.loom.health.fhir.partition;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import javax.sql.DataSource;

/** One statement, {@code GRANT SELECT ON TABLE <table> TO "<role>"}, run as the engine's own role (which owns its tables). */
public final class JdbcPartitionGrant implements PartitionGrant {
  private final DataSource ds;

  public JdbcPartitionGrant(DataSource ds) {
    this.ds = ds;
  }

  /** The exact SQL, exposed so the test asserts the text and not just that something ran. */
  public static String sql(String table, String role) {
    if (!PartitionReconciler.PARTITION_TABLE.equals(table)) {
      throw new IllegalArgumentException("only " + PartitionReconciler.PARTITION_TABLE + " may be granted");
    }
    if (!PartitionReconciler.ROLE.matcher(role).matches()) {
      throw new IllegalArgumentException("malformed role name");
    }
    return "GRANT SELECT ON TABLE " + table + " TO \"" + role + "\"";
  }

  @Override
  public void grantSelect(String table, String role) {
    String sql = sql(table, role);
    try (Connection c = ds.getConnection(); Statement s = c.createStatement()) {
      s.execute(sql);
    } catch (SQLException e) {
      throw new IllegalStateException("partitions.grant.failed: " + sql + " -> " + e.getMessage(), e);
    }
  }
}
