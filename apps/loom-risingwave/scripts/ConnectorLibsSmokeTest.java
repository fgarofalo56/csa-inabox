import java.lang.reflect.Method;

/**
 * SC1 smoke test for the loom-risingwave connector-node classpath.
 *
 * scripts/sc1-harden.sh replaces one jar in
 * {@code /risingwave/bin/connector-node/libs} (avro) and deletes two
 * (parquet-avro, htrace-core) to clear the Trivy CRITICAL gate. Changing a jar
 * on a wildcard classpath can fail in a way no file-listing assertion catches:
 * a class that no longer resolves its neighbours. So this loads -- and
 * INITIALISES -- every class on the affected paths, and parses an Avro schema
 * for real.
 *
 * Runs at BUILD time; a failure fails the image build. It has already earned its
 * keep once: it rejected the first attempt at the htrace fix (repacking the jar
 * without its shaded jackson), which left org.apache.htrace.impl.MilliSpan
 * unable to run its static initialiser.
 */
public final class ConnectorLibsSmokeTest {

  private static int failures = 0;

  /** The class must load AND run its static initialiser. */
  private static void mustLoad(String className) {
    try {
      Class.forName(className, true, ConnectorLibsSmokeTest.class.getClassLoader());
      System.out.println("  ok   load+init " + className);
    } catch (Throwable t) {
      failures++;
      System.out.println("  FAIL load+init " + className + " -> " + t);
    }
  }

  /**
   * The class must be GONE. Guards the two deletions: if a future base image
   * ships a loadable parquet-avro, or an htrace with no vulnerable jackson in
   * it, this fires and the deletion gets re-argued instead of silently dropping
   * something that had started working.
   */
  private static void mustBeAbsent(String className) {
    try {
      Class.forName(className, false, ConnectorLibsSmokeTest.class.getClassLoader());
      failures++;
      System.out.println("  FAIL expected-absent class is present: " + className);
    } catch (ClassNotFoundException expected) {
      System.out.println("  ok   absent (as designed) " + className);
    } catch (Throwable t) {
      failures++;
      System.out.println("  FAIL unexpected error probing " + className + " -> " + t);
    }
  }

  /** Avro: parse a schema and read the parsed record back. */
  private static void avroRoundTrip() {
    try {
      Class<?> schemaClass = Class.forName("org.apache.avro.Schema");
      Class<?> parserClass = Class.forName("org.apache.avro.Schema$Parser");
      Object parser = parserClass.getDeclaredConstructor().newInstance();
      Method parse = parserClass.getMethod("parse", String.class);
      Object schema =
          parse.invoke(
              parser,
              "{\"type\":\"record\",\"name\":\"LoomSmoke\",\"fields\":["
                  + "{\"name\":\"id\",\"type\":\"long\"},"
                  + "{\"name\":\"payload\",\"type\":[\"null\",\"string\"],\"default\":null}]}");
      // Call through the PUBLIC Schema class: the runtime type is the
      // package-private Schema$RecordSchema, which reflection may not touch.
      Object fields = schemaClass.getMethod("getFields").invoke(schema);
      int n = ((java.util.List<?>) fields).size();
      if (n != 2) {
        throw new IllegalStateException("expected 2 fields, got " + n);
      }
      Object name = schemaClass.getMethod("getName").invoke(schema);
      if (!"LoomSmoke".equals(name)) {
        throw new IllegalStateException("expected record name LoomSmoke, got " + name);
      }
      System.out.println(
          "  ok   avro Schema.Parser round-trip (" + n + " fields, name=" + name + ")");
    } catch (Throwable t) {
      failures++;
      System.out.println("  FAIL avro Schema.Parser round-trip -> " + unwrap(t));
    }
  }

  private static Throwable unwrap(Throwable t) {
    return t.getCause() != null ? t.getCause() : t;
  }

  public static void main(String[] args) {
    System.out.println("SC1 connector-node classpath smoke test");

    // REPLACED jar: avro 1.11.3 -> 1.11.4. Live code -- six other jars on this
    // classpath link against org.apache.avro (hadoop-common,
    // hadoop-mapreduce-client-core, hive-serde, iceberg-core, iceberg-data,
    // iceberg-parquet).
    mustLoad("org.apache.avro.Schema");
    mustLoad("org.apache.avro.generic.GenericData");
    mustLoad("org.apache.avro.generic.GenericDatumWriter");
    mustLoad("org.apache.avro.io.DecoderFactory");
    mustLoad("org.apache.avro.file.DataFileWriter");
    avroRoundTrip();

    // DELETED jar: parquet-avro. Its only referrer, iceberg-parquet, and the
    // parquet core it could not reach must both still load.
    mustBeAbsent("org.apache.parquet.avro.AvroSchemaConverter");
    mustBeAbsent("org.apache.parquet.avro.AvroParquetWriter");
    mustLoad("org.apache.iceberg.parquet.Parquet");
    mustLoad("org.apache.iceberg.data.parquet.GenericParquetWriter");
    mustLoad("org.apache.parquet.schema.MessageType");
    mustLoad("org.apache.parquet.hadoop.ParquetWriter");

    // DELETED jar: htrace-core (dead island -- zero bytecode references from any
    // of the other 460 jars). Assert it is gone, and that the neighbours which
    // could plausibly have wanted it still link.
    mustBeAbsent("org.apache.htrace.Trace");
    mustBeAbsent("org.apache.htrace.impl.MilliSpan");
    mustLoad("org.apache.hadoop.conf.Configuration");
    mustLoad("org.apache.hadoop.fs.FileSystem");
    mustLoad("org.apache.iceberg.hadoop.HadoopFileIO");

    // The connector-node entrypoint itself -- proves the whole service classpath
    // still links after the changes -- plus the sinks Loom actually drives.
    mustLoad("com.risingwave.connector.ConnectorService");
    mustLoad("com.risingwave.connector.JDBCSink");
    mustLoad("com.risingwave.connector.EsSink");

    if (failures > 0) {
      System.out.println("FATAL: " + failures + " connector-node classpath check(s) failed");
      System.exit(1);
    }
    System.out.println("all connector-node classpath checks passed");
  }
}
