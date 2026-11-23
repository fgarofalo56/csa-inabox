package ai.loom.health.fhir;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * A stand-in for OPA that speaks the FROZEN decision API (POST /v1/data/lhds/authz/decision,
 * {input:{access_token, request}} -> {result:{allow, reason, policy_version, obligations}}).
 *
 * <p>It mirrors the semantic SUBSET of the real Rego that the interceptor depends on (tenant
 * exact match, scope letter per interaction from the real interactions table, resource type,
 * category constraint, patient compartment). It does NOT verify signatures and does NOT run the
 * Rego: tokens here are unsigned. What these tests prove is the INTERCEPTOR's behaviour against
 * the contract, not the policy.
 */
final class FakePdp implements AutoCloseable {
  enum Mode { NORMAL, SLOW, HTTP_500, EMPTY_RESULT, ALLOW_AS_STRING, ALLOW_ALL, TRICKLE }

  private static final ObjectMapper JSON = new ObjectMapper();
  private final HttpServer server;
  private final JsonNode interactions;
  volatile Mode mode = Mode.NORMAL;
  volatile long slowMs = 1500;
  final List<JsonNode> inputs = new CopyOnWriteArrayList<>();
  final AtomicInteger calls = new AtomicInteger();

  FakePdp(Path interactionsJson) throws IOException {
    this.interactions = JSON.readTree(Files.readString(interactionsJson));
    this.server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext("/v1/data/lhds/authz/decision", ex -> {
      byte[] reqBytes = ex.getRequestBody().readAllBytes();
      JsonNode input = JSON.readTree(reqBytes).get("input");
      inputs.add(input);
      calls.incrementAndGet();
      Mode m = mode;
      try {
        if (m == Mode.SLOW) {
          Thread.sleep(slowMs);
        }
      } catch (InterruptedException ignored) {
        Thread.currentThread().interrupt();
      }
      if (m == Mode.TRICKLE) {
        // Headers + the first body byte go out immediately, the rest 3 s later: the client's
        // header-only timeout is satisfied, only a bound on the WHOLE response catches this.
        try {
          ex.getResponseHeaders().add("Content-Type", "application/json");
          ex.sendResponseHeaders(200, 0);
          ex.getResponseBody().write('{');
          ex.getResponseBody().flush();
          Thread.sleep(3000);
          ex.getResponseBody().write("\"result\":{\"allow\":true}}".getBytes(StandardCharsets.UTF_8));
        } catch (IOException | InterruptedException clientGaveUp) {
          // expected: the interceptor gave up first
        } finally {
          ex.close();
        }
        return;
      }
      int status = 200;
      String body;
      switch (m) {
        case HTTP_500 -> { status = 500; body = "{}"; }
        case EMPTY_RESULT -> body = "{}";
        case ALLOW_AS_STRING -> body = "{\"result\":{\"allow\":\"true\",\"reason\":\"permit\"}}";
        case ALLOW_ALL -> body = "{\"result\":{\"allow\":true,\"reason\":\"permit\",\"policy_version\":\"test\",\"obligations\":[]}}";
        default -> {
          String[] r = decide(input);
          body = "{\"result\":{\"allow\":" + r[0] + ",\"reason\":\"" + r[1]
              + "\",\"policy_version\":\"test\",\"obligations\":[]}}";
        }
      }
      byte[] out = body.getBytes(StandardCharsets.UTF_8);
      ex.getResponseHeaders().add("Content-Type", "application/json");
      try {
        ex.sendResponseHeaders(status, out.length);
        ex.getResponseBody().write(out);
      } catch (IOException clientGaveUp) {
        // the interceptor timed out and closed the socket: expected in SLOW mode
      } finally {
        ex.close();
      }
    });
    // A thread per request: in SLOW mode the handler outlives the client's timeout, and a single
    // dispatcher thread would starve every later test into a (false) timeout.
    server.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
    server.start();
  }

  String url() {
    return "http://127.0.0.1:" + server.getAddress().getPort();
  }

  void reset(Mode m) {
    mode = m;
    inputs.clear();
    calls.set(0);
  }

  /** [allow, reason] */
  private String[] decide(JsonNode input) {
    JsonNode req = input.get("request");
    JsonNode claims;
    try {
      String[] p = input.get("access_token").asText().split("\\.");
      claims = JSON.readTree(Base64.getUrlDecoder().decode(p[1]));
    } catch (Exception e) {
      return new String[] {"false", "token-invalid"};
    }
    // authz.rego aud_ok: an aud claim must equal request.base exactly. Tokens without aud skip this, so older tests are unchanged.
    if (claims.has("aud") && !claims.get("aud").asText().equals(req.path("base").asText())) {
      return new String[] {"false", "audience-mismatch"};
    }
    if (!req.get("tenant").asText().equals(claims.path("tenant").asText())) {
      return new String[] {"false", "tenant-mismatch"};
    }
    String ix = req.get("interaction").asText();
    JsonNode letterNode = interactions.get("fhir").get(ix);
    if (letterNode == null) {
      return new String[] {"false", ix.equals("operation") ? "role-denied" : "unknown-interaction"};
    }
    String letter = letterNode.asText();
    String type = req.get("resource_type").asText();
    List<String> comp = strings(req.path("patient_compartment"));
    List<String> cats = strings(req.path("categories"));
    for (String s : claims.path("scope").asText("").split(" ")) {
      int slash = s.indexOf('/');
      int dot = s.indexOf('.');
      if (slash < 0 || dot < slash) {
        continue;
      }
      String ctx = s.substring(0, slash);
      String t = s.substring(slash + 1, dot);
      String rest = s.substring(dot + 1);
      String letters = rest.contains("?") ? rest.substring(0, rest.indexOf('?')) : rest;
      String constraint = rest.contains("?category=") ? rest.substring(rest.indexOf("?category=") + 10) : "";
      if (!(t.equals("*") || t.equals(type)) || !letters.contains(letter)) {
        continue;
      }
      if (!constraint.isEmpty() && !cats.contains(constraint)) {
        continue;
      }
      if (ctx.equals("patient")) {
        String pat = claims.path("patient").asText("");
        if (pat.isEmpty() || comp.isEmpty() || !comp.stream().allMatch(pat::equals)) {
          continue;
        }
      }
      return new String[] {"true", "permit"};
    }
    return new String[] {"false", "scope-denied"};
  }

  private static List<String> strings(JsonNode arr) {
    List<String> out = new java.util.ArrayList<>();
    arr.forEach(n -> out.add(n.asText()));
    return out;
  }

  @Override
  public void close() {
    server.stop(0);
  }
}
