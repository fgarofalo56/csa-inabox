package ai.loom.health.fhir.pdp;

import java.util.Map;

/** One synchronous decision per interaction. */
public interface PdpClient {

  /**
   * @param accessToken the RAW bearer token (the PDP verifies it; this plugin never does)
   * @param request the {@code input.request} object of {@code apps/loom-health-pdp/input-contract.json}
   * @throws PdpUnavailableException on anything that is not a well-formed decision
   */
  PdpDecision decide(String accessToken, Map<String, Object> request) throws PdpUnavailableException;
}
