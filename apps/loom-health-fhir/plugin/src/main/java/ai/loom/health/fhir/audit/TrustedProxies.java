package ai.loom.health.fhir.audit;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Which TCP peers may vouch for a client address. The audit trail records WHO called; behind the
 * ingress proxy the TCP peer is always the proxy, so the real client is only in the forwarded
 * header, and that header is attacker-controlled unless the request provably came through the proxy.
 *
 * <p>Rules: the header is read ONLY when the TCP peer is in the configured trusted set; the hop list
 * is walked right to left skipping trusted hops, and the first untrusted hop is the client (anything
 * further left was written by the client and is ignored); any hop that is not an IP literal makes
 * the whole header untrusted and the peer address is recorded instead. An empty trusted set (the
 * default) trusts nobody. No hostname is ever resolved: only literals are parsed.
 */
public final class TrustedProxies {
  private static final Pattern V4 = Pattern.compile("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$");
  private static final Pattern V6 = Pattern.compile("^[0-9a-fA-F:]{2,45}$");

  /** Trusts nobody: the recorded address is always the TCP peer. */
  public static final TrustedProxies NONE = new TrustedProxies(List.of());

  private record Net(byte[] addr, int prefix) {}

  private final List<Net> nets;

  private TrustedProxies(List<Net> nets) {
    this.nets = nets;
  }

  /** @param spec comma separated IP literals or CIDRs; an entry that does not parse is dropped (trusts less). */
  public static TrustedProxies parse(String spec) {
    List<Net> out = new ArrayList<>();
    if (spec != null) {
      for (String raw : spec.split(",")) {
        String e = raw.trim();
        if (e.isEmpty()) {
          continue;
        }
        int slash = e.indexOf('/');
        String ip = slash < 0 ? e : e.substring(0, slash);
        byte[] a = literal(ip);
        if (a == null) {
          continue;
        }
        int prefix = a.length * 8;
        if (slash >= 0) {
          try {
            prefix = Integer.parseInt(e.substring(slash + 1).trim());
          } catch (NumberFormatException bad) {
            continue;
          }
          if (prefix < 0 || prefix > a.length * 8) {
            continue;
          }
        }
        out.add(new Net(a, prefix));
      }
    }
    return new TrustedProxies(List.copyOf(out));
  }

  /** IPv4 dotted quad or IPv6 hex-colon literal as bytes, else null. Never touches DNS. */
  static byte[] literal(String s) {
    if (s == null) {
      return null;
    }
    var m = V4.matcher(s);
    if (m.matches()) {
      byte[] b = new byte[4];
      for (int i = 0; i < 4; i++) {
        int v = Integer.parseInt(m.group(i + 1));
        if (v > 255) {
          return null;
        }
        b[i] = (byte) v;
      }
      return b;
    }
    if (V6.matcher(s).matches() && s.indexOf(':') >= 0) {
      try {
        return InetAddress.getByName(s).getAddress(); // a string with ':' and only hex is parsed, never resolved
      } catch (UnknownHostException bad) {
        return null;
      }
    }
    return null;
  }

  public boolean isTrusted(String ip) {
    byte[] a = literal(ip);
    if (a == null) {
      return false;
    }
    for (Net n : nets) {
      if (n.addr().length == a.length && sharesPrefix(n.addr(), a, n.prefix())) {
        return true;
      }
    }
    return false;
  }

  private static boolean sharesPrefix(byte[] a, byte[] b, int bits) {
    for (int i = 0; i < bits; i++) {
      int mask = 0x80 >> (i % 8);
      if ((a[i / 8] & mask) != (b[i / 8] & mask)) {
        return false;
      }
    }
    return true;
  }

  /**
   * @param peer the TCP peer address ({@code getRemoteAddr()})
   * @param forwarded all values of the configured forwarded header joined with commas, or null
   * @return the address to record as the client
   */
  public String clientAddress(String peer, String forwarded) {
    if (peer == null) {
      return "";
    }
    if (forwarded == null || forwarded.isBlank() || !isTrusted(peer)) {
      return peer;
    }
    String[] hops = forwarded.split(",");
    for (int i = hops.length - 1; i >= 0; i--) {
      String h = hops[i].trim();
      if (literal(h) == null) {
        return peer; // not an address: the header cannot be trusted at all
      }
      if (!isTrusted(h)) {
        return h;
      }
    }
    return hops[0].trim(); // every hop is one of our own proxies: the leftmost is the origin
  }
}
