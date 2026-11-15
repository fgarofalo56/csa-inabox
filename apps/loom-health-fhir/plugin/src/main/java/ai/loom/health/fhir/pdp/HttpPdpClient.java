package ai.loom.health.fhir.pdp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Calls OPA's Data API: {@code POST /v1/data/lhds/authz/decision}, body
 * {@code {"input":{"access_token":..,"request":{..}}}} (apps/loom-health-pdp/README.md).
 *
 * <p>Fail closed: every path that is not "HTTP 200 with result.allow a JSON boolean" throws
 * {@link PdpUnavailableException}. In particular a 200 with {@code {}} (policy undefined)
 * is NOT a deny the caller can ignore and NOT a permit: it is unavailable, 503.
 */
public final class HttpPdpClient implements PdpClient {
  static final String DECISION_PATH = "/v1/data/lhds/authz/decision";
  private static final ObjectMapper JSON = new ObjectMapper();

  private final HttpClient http;
  private final URI endpoint;
  private final Duration timeout;

  public HttpPdpClient(String baseUrl, Duration timeout) {
    String b = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
    this.endpoint = URI.create(b + DECISION_PATH);
    this.timeout = timeout;
    this.http = HttpClient.newBuilder().connectTimeout(timeout).build();
  }

  @Override
  public PdpDecision decide(String accessToken, Map<String, Object> request)
      throws PdpUnavailableException {
    Map<String, Object> input = new LinkedHashMap<>();
    input.put("access_token", accessToken);
    input.put("request", request);
    String body;
    try {
      body = JSON.writeValueAsString(Map.of("input", input));
    } catch (IOException e) {
      throw new PdpUnavailableException("pdp-encode", "could not encode the PDP input", e);
    }
    HttpResponse<String> resp;
    try {
      resp = http.send(
          HttpRequest.newBuilder(endpoint).timeout(timeout)
              .header("Content-Type", "application/json")
              .POST(HttpRequest.BodyPublishers.ofString(body)).build(),
          HttpResponse.BodyHandlers.ofString());
    } catch (HttpTimeoutException e) { // includes HttpConnectTimeoutException
      throw new PdpUnavailableException("pdp-timeout", "PDP did not answer within " + timeout.toMillis() + " ms", e);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new PdpUnavailableException("pdp-interrupted", "PDP call interrupted", e);
    } catch (IOException e) {
      throw new PdpUnavailableException("pdp-connect", "PDP unreachable: " + e.getClass().getSimpleName(), e);
    }
    if (resp.statusCode() != 200) {
      throw new PdpUnavailableException("pdp-status", "PDP answered HTTP " + resp.statusCode(), null);
    }
    JsonNode root;
    try {
      root = JSON.readTree(resp.body());
    } catch (IOException e) {
      throw new PdpUnavailableException("pdp-malformed", "PDP reply is not JSON", e);
    }
    JsonNode result = root == null ? null : root.get("result");
    if (result == null || !result.isObject()) {
      throw new PdpUnavailableException("pdp-no-result", "PDP reply has no result object", null);
    }
    JsonNode allow = result.get("allow");
    if (allow == null || !allow.isBoolean()) {
      throw new PdpUnavailableException("pdp-malformed", "PDP result.allow is not a boolean", null);
    }
    return new PdpDecision(
        allow.asBoolean(),
        result.path("reason").asText(""),
        result.path("policy_version").asText(""));
  }
}
