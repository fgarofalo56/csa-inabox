import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Properties;
import java.util.Set;
import java.util.TreeSet;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

/**
 * SC1 build-time link check for a swapped netty jar (CSA Loom, #4429).
 *
 * WHY THIS EXISTS, and what it does NOT prove
 * -------------------------------------------
 * Replacing netty-handler on a classpath whose OTHER netty modules stay behind
 * can fail in a way no file-listing assertion catches: a class in the new jar
 * referencing a neighbour that the older module does not carry. That is not
 * hypothetical -- on loom-risingwave, netty-handler 4.1.137's
 * {@code LazyX509Certificate$CertFactoryHandle} references
 * {@code io.netty.util.Recycler$EnhancedHandle}, which netty-common 4.1.77 does
 * NOT have. A plain {@code Class.forName} on the owning class does not catch it
 * (HotSpot resolves member references lazily), so this check works from the
 * CONSTANT_Class entries in the jar's own class files instead.
 *
 * What it proves, at BUILD time, against the image's REAL classpath:
 *   1. the jar on disk is the version we intended (its Maven pom.properties);
 *   2. the JVM actually RESOLVES that jar -- no second copy shadows it;
 *   3. which {@code io/netty/**} classes named by the jar are NOT loadable --
 *      written to a file, NOT judged here;
 *   4. an SslContext/SslHandler round-trip through an EmbeddedChannel links
 *      handler -> common -> buffer -> transport for real.
 *
 * (3) IS DELIBERATELY NOT A VERDICT. A netty-handler jar always names classes
 * that a given image cannot load and never could: the optional native OpenSSL
 * provider (io.netty.internal.tcnative), the optional Conscrypt engine, the
 * netty-pkitesting test helper. Judging the raw set would fail every build, and
 * papering over it with a spelling allowlist would just move the lie. So the
 * CALLER runs this twice -- once on the UNMODIFIED jar set (control) and once
 * after the swap (treatment) -- and fails only on the DIFFERENCE. A reference
 * that was unresolvable before the swap is not a regression; one that became
 * unresolvable is. That counterfactual is the whole instrument.
 *
 * What it does NOT prove: METHOD-level resolution. That is covered at authoring
 * time by scripts/ci/netty_link_check.py (forward/backward/callers, each run
 * against a control), and the callers of this class pin the sibling netty
 * version set so the build FAILS if the base image moves out from under that
 * analysis.
 *
 * Deliberately dependency-free and duplicated per app directory: each image is
 * built by `az acr build` from its OWN context (see the app matrix in
 * .github/workflows/build-fiab-images-acr-tasks.yml), so a shared file outside
 * the context cannot be COPYed in.
 *
 * Usage:
 *   java NettyLinkCheck --jar <path> --expect io.netty:netty-handler=4.2.17.Final
 *                       --unresolved-out <path>
 *                       [--jar <path> --expect ...] [--control] [--skip-ssl-probe]
 */
public final class NettyLinkCheck {

  private static final List<String> failures = new ArrayList<>();

  private static void fail(String msg) {
    failures.add(msg);
    System.out.println("  FAIL " + msg);
  }

  private static void ok(String msg) {
    System.out.println("  ok   " + msg);
  }

  /** 1) The jar on disk carries the Maven coordinates we think it does. */
  private static void checkJarVersion(Path jar, String ga, String version) {
    String[] parts = ga.split(":");
    String entry = "META-INF/maven/" + parts[0] + "/" + parts[1] + "/pom.properties";
    try (JarFile jf = new JarFile(jar.toFile())) {
      JarEntry e = jf.getJarEntry(entry);
      if (e == null) {
        fail(jar.getFileName() + " has no " + entry + " -- cannot confirm its version");
        return;
      }
      Properties p = new Properties();
      try (InputStream in = jf.getInputStream(e)) {
        p.load(in);
      }
      String got = p.getProperty("version");
      if (!version.equals(got)) {
        fail(jar.getFileName() + " declares version " + got + ", expected " + version);
      } else {
        ok(ga + " = " + got + "  (" + jar.getFileName() + ")");
      }
    } catch (IOException io) {
      fail("cannot read " + jar + ": " + io);
    }
  }

  /**
   * 2) The RUNNING classpath resolves this jar, not some other copy. A swap that
   * loses the shadowing race would leave a green build over an unchanged
   * runtime, which is the specific failure this repo calls a gate measuring
   * nothing.
   */
  private static void checkNoShadow(Path jar, String probeClass) {
    try {
      Class<?> c = Class.forName(probeClass, false, NettyLinkCheck.class.getClassLoader());
      URL src = c.getProtectionDomain().getCodeSource() == null
          ? null : c.getProtectionDomain().getCodeSource().getLocation();
      if (src == null) {
        fail(probeClass + " has no code source -- cannot prove which jar won");
        return;
      }
      String where = src.getPath();
      String want = jar.getFileName().toString();
      if (!where.endsWith(want)) {
        fail(probeClass + " resolves from " + where + ", NOT from " + want
            + " -- another copy is shadowing the patched jar");
      } else {
        ok(probeClass + " resolves from " + want);
      }
    } catch (Throwable t) {
      fail("cannot load " + probeClass + ": " + t);
    }
  }

  /** Every CONSTANT_Class entry naming an io/netty/** type, across the jar. */
  private static Set<String> nettyClassRefs(Path jar) throws IOException {
    Set<String> refs = new TreeSet<>();
    try (JarFile jf = new JarFile(jar.toFile())) {
      Enumeration<JarEntry> en = jf.entries();
      while (en.hasMoreElements()) {
        JarEntry e = en.nextElement();
        if (!e.getName().endsWith(".class")) {
          continue;
        }
        try (DataInputStream in = new DataInputStream(jf.getInputStream(e))) {
          refs.addAll(constantPoolClassNames(in));
        }
      }
    }
    Set<String> out = new TreeSet<>();
    for (String r : refs) {
      if (r.startsWith("io/netty/") && !r.startsWith("[")) {
        out.add(r.replace('/', '.'));
      }
    }
    return out;
  }

  /** Minimal class-file constant-pool walk: collect CONSTANT_Class names. */
  private static Set<String> constantPoolClassNames(DataInputStream in) throws IOException {
    in.readInt(); // magic
    in.readUnsignedShort(); // minor
    in.readUnsignedShort(); // major
    int count = in.readUnsignedShort();
    String[] utf8 = new String[count];
    int[] classNameIndex = new int[count];
    int i = 1;
    while (i < count) {
      int tag = in.readUnsignedByte();
      switch (tag) {
        case 1: utf8[i] = in.readUTF(); break;
        case 7: classNameIndex[i] = in.readUnsignedShort(); break;
        case 8: case 16: case 19: case 20: in.readUnsignedShort(); break;
        case 15: in.readUnsignedByte(); in.readUnsignedShort(); break;
        case 3: case 4: case 9: case 10: case 11: case 12: case 17: case 18:
          in.readInt(); break;
        case 5: case 6: in.readLong(); i++; break;
        default: throw new IOException("unknown constant pool tag " + tag);
      }
      i++;
    }
    Set<String> names = new LinkedHashSet<>();
    for (int k = 1; k < count; k++) {
      if (classNameIndex[k] != 0 && utf8[classNameIndex[k]] != null) {
        names.add(utf8[classNameIndex[k]]);
      }
    }
    return names;
  }

  /**
   * 3) RECORD which io.netty classes named by the jar do not load. No verdict
   * here -- see the class javadoc: the caller diffs control against treatment.
   */
  private static Set<String> collectUnresolved(Path jar) {
    Set<String> unresolved = new TreeSet<>();
    Set<String> refs;
    try {
      refs = nettyClassRefs(jar);
    } catch (IOException io) {
      fail("cannot scan " + jar + ": " + io);
      return unresolved;
    }
    for (String r : refs) {
      try {
        Class.forName(r, false, NettyLinkCheck.class.getClassLoader());
      } catch (ClassNotFoundException | NoClassDefFoundError nf) {
        unresolved.add(r);
      } catch (Throwable t) {
        unresolved.add(r);
      }
    }
    System.out.println("  info " + jar.getFileName() + ": " + refs.size()
        + " io.netty class references, " + unresolved.size() + " unresolvable"
        + " (judged by the caller against the control run)");
    return unresolved;
  }

  /** 4) Functional: handler -> common -> buffer -> transport, for real. */
  private static void sslRoundTrip() {
    try {
      Class<?> builder = Class.forName("io.netty.handler.ssl.SslContextBuilder");
      Object b = builder.getMethod("forClient").invoke(null);
      Object ctx = builder.getMethod("build").invoke(b);

      Class<?> allocCls = Class.forName("io.netty.buffer.ByteBufAllocator");
      Object alloc = Class.forName("io.netty.buffer.UnpooledByteBufAllocator")
          .getField("DEFAULT").get(null);
      Object handler = Class.forName("io.netty.handler.ssl.SslContext")
          .getMethod("newHandler", allocCls).invoke(ctx, alloc);

      Class<?> chCls = Class.forName("io.netty.channel.ChannelHandler");
      Object array = java.lang.reflect.Array.newInstance(chCls, 1);
      java.lang.reflect.Array.set(array, 0, handler);
      Object channel = Class.forName("io.netty.channel.embedded.EmbeddedChannel")
          .getConstructor(array.getClass()).newInstance(array);

      Object res = channel.getClass().getMethod("finishAndReleaseAll").invoke(channel);
      ok("SslContextBuilder.forClient().build() -> SslHandler -> EmbeddedChannel"
          + " round-trip (finishAndReleaseAll=" + res + ")");
    } catch (Throwable t) {
      Throwable c = t.getCause() != null ? t.getCause() : t;
      fail("SSL round-trip through the real classpath: " + c);
    }
  }

  public static void main(String[] args) throws Exception {
    List<Path> jars = new ArrayList<>();
    List<String> expects = new ArrayList<>();
    Path unresolvedOut = null;
    boolean sslProbe = true;
    boolean control = false;
    for (int i = 0; i < args.length; i++) {
      switch (args[i]) {
        case "--jar": jars.add(Path.of(args[++i])); break;
        case "--expect": expects.add(args[++i]); break;
        case "--unresolved-out": unresolvedOut = Path.of(args[++i]); break;
        case "--skip-ssl-probe": sslProbe = false; break;
        case "--control": control = true; break;
        default: throw new IllegalArgumentException("unknown arg " + args[i]);
      }
    }
    System.out.println("SC1 netty link check (#4429) -- "
        + (control ? "CONTROL (unmodified jar set)" : "TREATMENT (after the swap)"));
    if (jars.isEmpty() || jars.size() != expects.size()) {
      throw new IllegalArgumentException("need one --expect per --jar");
    }
    if (unresolvedOut == null) {
      throw new IllegalArgumentException("--unresolved-out is required");
    }

    Set<String> unresolved = new TreeSet<>();
    for (int i = 0; i < jars.size(); i++) {
      Path jar = jars.get(i);
      if (!Files.isRegularFile(jar)) {
        fail(jar + " does not exist -- the install step did not land");
        continue;
      }
      String[] gav = expects.get(i).split("=");
      checkJarVersion(jar, gav[0], gav[1]);
      unresolved.addAll(collectUnresolved(jar));
      // A shadowed swap would leave a green build over an unchanged runtime, so
      // this is asserted on the treatment run only -- in the control the old
      // jar is reached through a symlink farm and the file name differs.
      if (!control) {
        if (gav[0].endsWith(":netty-handler")) {
          checkNoShadow(jar, "io.netty.handler.ssl.SslHandler");
        } else if (gav[0].endsWith(":netty-common")) {
          checkNoShadow(jar, "io.netty.util.Recycler");
        } else if (gav[0].endsWith(":netty-buffer")) {
          checkNoShadow(jar, "io.netty.buffer.ByteBufAllocator");
        }
      }
    }

    Files.write(unresolvedOut, unresolved);
    System.out.println("  info wrote " + unresolved.size()
        + " unresolvable io.netty class name(s) to " + unresolvedOut);

    if (sslProbe) {
      sslRoundTrip();
    }

    if (!failures.isEmpty()) {
      System.out.println("FATAL: " + failures.size() + " netty link check(s) failed");
      System.exit(1);
    }
    System.out.println((control ? "control" : "treatment") + " run complete");
  }
}
