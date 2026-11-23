package ai.loom.health.fhir.partition;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;

/**
 * LHDS W2-2b B2e: the engine creates its own partitions in-process and grants SELECT on the partition table only.
 * Every assertion names the input that breaks it.
 */
class PartitionReconcilerTest {
  static final String ROLE = "id-lhds-dev01-pgadmin";

  /** In-memory partition table. Records every create so "untouched" is a count, not an absence of a diff. */
  static final class FakeStore implements PartitionStore {
    final List<DesiredPartition> rows = new ArrayList<>();
    final List<DesiredPartition> creates = new ArrayList<>();
    RuntimeException createFails;
    boolean createLosesRace;

    FakeStore(DesiredPartition... have) {
      rows.addAll(List.of(have));
    }

    @Override
    public List<DesiredPartition> list() {
      return List.copyOf(rows);
    }

    @Override
    public void create(DesiredPartition p) {
      creates.add(p);
      if (createFails != null) {
        throw createFails;
      }
      rows.add(p);
      if (createLosesRace) {
        throw new IllegalStateException("duplicate key: another pod created it first");
      }
    }
  }

  /** Real JdbcPartitionGrant over a recording DataSource: the SQL text that reaches the driver is what is asserted. */
  static final class RecordingDs {
    final List<String> sql = new ArrayList<>();
    /** Connection/statement calls in order: autocommit settings and executes. */
    final List<String> events = new ArrayList<>();
    final DataSource ds = (DataSource) Proxy.newProxyInstance(
        DataSource.class.getClassLoader(), new Class<?>[] {DataSource.class}, (p, m, a) -> {
          if (m.getName().equals("getConnection")) {
            return Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[] {Connection.class}, (cp, cm, ca) -> {
              if (cm.getName().equals("setAutoCommit")) {
                events.add("autocommit=" + ca[0]);
                return null;
              }
              if (cm.getName().equals("createStatement")) {
                return Proxy.newProxyInstance(Statement.class.getClassLoader(), new Class<?>[] {Statement.class}, (sp, sm, sa) -> {
                  if (sm.getName().startsWith("execute")) {
                    sql.add((String) sa[0]);
                    events.add("execute");
                    return false;
                  }
                  return sm.getName().equals("close") ? null : null;
                });
              }
              return cm.getName().equals("close") ? null : null;
            });
          }
          throw new UnsupportedOperationException(m.getName());
        });
  }

  static DesiredPartition p(int id, String name) {
    return new DesiredPartition(id, name);
  }

  @Test
  void missingPartitionsAreCreatedAndExistingOnesAreNotTouched() {
    // BREAKS when: reconcile skips create (site-b would be absent, creates empty) or re-creates site-a (creates would hold it).
    FakeStore store = new FakeStore(p(1, "site-a"));
    RecordingDs db = new RecordingDs();
    List<String> log = new ArrayList<>();
    new PartitionReconciler(store, new JdbcPartitionGrant(db.ds), log::add).reconcile(List.of(p(1, "site-a"), p(2, "site-b")), ROLE);
    assertEquals(List.of(p(2, "site-b")), store.creates, "only the missing partition is created");
    assertEquals(List.of(p(1, "site-a"), p(2, "site-b")), store.rows);
    assertTrue(log.get(log.size() - 1).contains("\"event\":\"partitions.reconciled\"") && log.get(log.size() - 1).contains("\"created\":1,\"unchanged\":1"),
        "structured partitions.reconciled line with created=1 unchanged=1, got " + log);
  }

  @Test
  void aSecondRunWithTheSameListCreatesNothing() {
    // BREAKS when: the reconciler is not idempotent (the second run would put 1 entry in creates).
    FakeStore store = new FakeStore();
    PartitionReconciler r = new PartitionReconciler(store, new JdbcPartitionGrant(new RecordingDs().ds), s -> {});
    r.reconcile(List.of(p(1, "site-a")), ROLE);
    assertEquals(1, store.creates.size(), "positive control: the first run did create");
    r.reconcile(List.of(p(1, "site-a")), ROLE);
    assertEquals(1, store.creates.size(), "second run must not create again");
  }

  @Test
  void sameIdWithAnotherNameIsAConflictThatStopsStartupBeforeAnyWrite() {
    // BREAKS when: the id collision is tolerated (no exception) or renamed (rows would change).
    FakeStore store = new FakeStore(p(1, "site-a"));
    RecordingDs db = new RecordingDs();
    List<String> log = new ArrayList<>();
    PartitionConflictException e = assertThrows(PartitionConflictException.class,
        () -> new PartitionReconciler(store, new JdbcPartitionGrant(db.ds), log::add).reconcile(List.of(p(1, "site-other"), p(2, "site-b")), ROLE));
    assertTrue(e.getMessage().startsWith("partitions.conflict:"), e.getMessage());
    assertEquals(List.of(p(1, "site-a")), store.rows, "nothing renamed, nothing created");
    assertTrue(store.creates.isEmpty(), "no create may precede the conflict being found");
    assertTrue(db.sql.isEmpty(), "no GRANT on a conflicted engine");
    assertTrue(log.stream().anyMatch(l -> l.contains("\"event\":\"partitions.conflict\"")), "named log line, got " + log);
  }

  @Test
  void sameNameUnderAnotherIdIsAConflict() {
    // BREAKS when: only ids are compared (site-a under id 9 would be created as a second partition named site-a).
    FakeStore store = new FakeStore(p(1, "site-a"));
    assertThrows(PartitionConflictException.class,
        () -> new PartitionReconciler(store, new JdbcPartitionGrant(new RecordingDs().ds), s -> {}).reconcile(List.of(p(9, "site-a")), ROLE));
    assertTrue(store.creates.isEmpty());
  }

  @Test
  void exactlyOneGrantOnExactlyThePartitionTable() {
    // BREAKS when: the grant widens (e.g. ALL PRIVILEGES, another table, ALL TABLES IN SCHEMA) or is issued twice.
    FakeStore store = new FakeStore();
    RecordingDs db = new RecordingDs();
    new PartitionReconciler(store, new JdbcPartitionGrant(db.ds), s -> {}).reconcile(List.of(p(1, "site-a"), p(2, "site-b")), ROLE);
    assertEquals(List.of("GRANT SELECT ON TABLE hfj_partition TO \"" + ROLE + "\""), db.sql);
  }

  @Test
  void theGrantRunsInAutocommitModeSetBeforeTheStatement() {
    // BREAKS when: setAutoCommit(true) is removed (events would be just [execute]) or is called after the GRANT
    // (a pooled connection with autocommit off would leave the GRANT in an open transaction, never committed).
    RecordingDs db = new RecordingDs();
    new JdbcPartitionGrant(db.ds).grantSelect("hfj_partition", ROLE);
    assertEquals(List.of("autocommit=true", "execute"), db.events);
  }

  @Test
  void theGrantIsStillIssuedForAnEmptyDesiredList() {
    // BREAKS when: the grant is skipped for [] (the CP readback of a tenant with no facility yet would be permission denied).
    RecordingDs db = new RecordingDs();
    new PartitionReconciler(new FakeStore(), new JdbcPartitionGrant(db.ds), s -> {}).reconcile(List.of(), ROLE);
    assertEquals(1, db.sql.size());
  }

  @Test
  void aGrantTargetOtherThanThePartitionTableIsRefused() {
    // BREAKS when: JdbcPartitionGrant accepts any table name.
    assertThrows(IllegalArgumentException.class, () -> JdbcPartitionGrant.sql("hfj_resource", ROLE));
    assertThrows(IllegalArgumentException.class, () -> JdbcPartitionGrant.sql("hfj_partition, hfj_resource", ROLE));
    assertEquals("GRANT SELECT ON TABLE hfj_partition TO \"x\"", JdbcPartitionGrant.sql("hfj_partition", "x"));
  }

  @Test
  void aMalformedRoleIsRefusedBeforeAnythingIsCreated() {
    // BREAKS when: the role is interpolated unchecked (the quote breaks out of the identifier) or validated after the creates.
    for (String bad : List.of("x\"; DROP TABLE hfj_resource; --", "", "a b", "-lead")) {
      FakeStore store = new FakeStore();
      RecordingDs db = new RecordingDs();
      assertThrows(IllegalArgumentException.class,
          () -> new PartitionReconciler(store, new JdbcPartitionGrant(db.ds), s -> {}).reconcile(List.of(p(1, "site-a")), bad), "role [" + bad + "]");
      assertTrue(store.creates.isEmpty() && db.sql.isEmpty(), "nothing written for role [" + bad + "]");
    }
  }

  @Test
  void reservedAndInvalidNamesAreRefusedAndValidOnesAreAccepted() {
    // BREAKS when: DEFAULT (any case), id 0, a name outside the control plane's pattern, or a repeat is accepted.
    assertEquals(List.of(p(1, "site-a"), p(2, "b2")), DesiredPartitions.parse("[{\"id\":1,\"name\":\"site-a\"},{\"id\":2,\"name\":\"b2\"}]"));
    assertEquals(List.of(), DesiredPartitions.parse("[]"));
    for (String bad : List.of(
        "[{\"id\":1,\"name\":\"DEFAULT\"}]",
        "[{\"id\":1,\"name\":\"default\"}]",
        "[{\"id\":0,\"name\":\"site-a\"}]",
        "[{\"id\":1,\"name\":\"Site_A\"}]",
        "[{\"id\":1,\"name\":\"a\"}]",
        "[{\"id\":1,\"name\":\"-a\"}]",
        "[{\"id\":1,\"name\":\"a\\\"b\"}]",
        "[{\"id\":1,\"name\":\"site-a\"},{\"id\":2,\"name\":\"site-a\"}]",
        "[{\"id\":1,\"name\":\"site-a\"},{\"id\":1,\"name\":\"site-b\"}]",
        "[{\"id\":1,\"name\":\"site-a\",\"extra\":1}]",
        "[{\"id\":\"1\",\"name\":\"site-a\"}]",
        "{\"id\":1}",
        "not json")) {
      assertThrows(IllegalArgumentException.class, () -> DesiredPartitions.parse(bad), "input " + bad);
    }
  }

  @Test
  void aCreateThatLostARaceToAnotherPodIsFineButAFailedCreateIsNot() {
    // BREAKS when: the race is fatal (the first assertion throws) or any create error is swallowed (the second would not throw).
    FakeStore raced = new FakeStore();
    raced.createLosesRace = true;
    new PartitionReconciler(raced, new JdbcPartitionGrant(new RecordingDs().ds), s -> {}).reconcile(List.of(p(1, "site-a")), ROLE);
    FakeStore broken = new FakeStore();
    broken.createFails = new IllegalStateException("db is read-only");
    RecordingDs db = new RecordingDs();
    assertThrows(IllegalStateException.class, () -> new PartitionReconciler(broken, new JdbcPartitionGrant(db.ds), s -> {}).reconcile(List.of(p(1, "site-a")), ROLE));
    assertTrue(db.sql.isEmpty(), "no GRANT after a failed create");
  }

  @Test
  void environmentHandling() {
    // BREAKS when: one variable alone is accepted (a role with no list, or a list with no grant target), or both-unset is not a no-op.
    FakeStore store = new FakeStore();
    RecordingDs db = new RecordingDs();
    LoomPartitionConfiguration.run(Map.of(), () -> store, () -> new JdbcPartitionGrant(db.ds));
    assertTrue(store.creates.isEmpty() && db.sql.isEmpty(), "both unset: nothing happens");
    assertThrows(IllegalStateException.class, () -> LoomPartitionConfiguration.run(Map.of("LOOM_HEALTH_PARTITIONS", "[]"), () -> store, () -> new JdbcPartitionGrant(db.ds)));
    assertThrows(IllegalStateException.class, () -> LoomPartitionConfiguration.run(Map.of("LOOM_HEALTH_PG_ADMIN_ROLE", ROLE), () -> store, () -> new JdbcPartitionGrant(db.ds)));
    LoomPartitionConfiguration.run(
        Map.of("LOOM_HEALTH_PARTITIONS", "[{\"id\":1,\"name\":\"site-a\"}]", "LOOM_HEALTH_PG_ADMIN_ROLE", ROLE), () -> store, () -> new JdbcPartitionGrant(db.ds));
    assertEquals(List.of(p(1, "site-a")), store.creates);
    assertFalse(db.sql.isEmpty());
  }
}
