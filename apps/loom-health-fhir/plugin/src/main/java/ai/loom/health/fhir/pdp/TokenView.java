package ai.loom.health.fhir.pdp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * Reads claims from a JWT payload WITHOUT verifying it. Safe only because it is called
 * strictly AFTER the PDP returned allow=true for this exact token (the PDP verifies the
 * ES384 signature, issuer, audience, expiry). Never use it to make an access decision, and
 * never call it on a denied or unevaluated token for anything but a best-effort audit label.
 */
public record TokenView(String scope, String patient, String subject, String clientId) {
  private static final ObjectMapper JSON = new ObjectMapper();
  public static final TokenView EMPTY = new TokenView("", "", "", "");

  public static TokenView of(String jwt) {
    try {
      String[] parts = jwt.split("\\.");
      if (parts.length != 3) {
        return EMPTY;
      }
      JsonNode p = JSON.readTree(Base64.getUrlDecoder().decode(parts[1].getBytes(StandardCharsets.US_ASCII)));
      return new TokenView(
          p.path("scope").asText(""),
          p.path("patient").asText(""),
          p.path("sub").asText(""),
          p.path("client_id").asText(""));
    } catch (Exception e) {
      return EMPTY;
    }
  }
}
