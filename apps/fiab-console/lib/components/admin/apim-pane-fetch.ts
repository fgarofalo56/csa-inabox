/**
 * Shared safe-fetch for the APIM admin panes.
 *
 * Why this exists: the panes used to do `fetch(url).then(r => r.json())`. When
 * the target route was missing, Next.js returned its HTML 404 page and
 * `r.json()` threw "Unexpected token '<' … is not valid JSON" — a hard crash
 * with no actionable message. This helper reads the body as text first and
 * parses defensively, so a non-JSON body or an honest 503 config-gate surfaces
 * as a readable error (naming the missing env var) instead of a parse crash.
 *
 * Returns the parsed `{ ok, ... }` payload on success, or throws an Error whose
 * message is suitable to drop straight into a Fluent MessageBar.
 */
export interface ApimJsonOk {
  ok: boolean;
  error?: string;
  code?: string;
  missing?: string;
  [k: string]: unknown;
}

export async function apimFetchJson(input: string, init?: RequestInit): Promise<ApimJsonOk> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (e) {
    throw new Error(`Network error calling ${input}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const text = await res.text();
  let parsed: ApimJsonOk | null = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as ApimJsonOk;
    } catch {
      // Non-JSON body (e.g. an HTML 404/500 page). Don't let JSON.parse crash
      // the pane — surface an honest, readable message instead.
      parsed = null;
    }
  }

  // Honest config-gate: routes return 503 { code:'not_configured', missing }.
  if (res.status === 503 && parsed?.code === 'not_configured') {
    throw new Error(parsed.error || `API Management is not configured for this deployment${parsed.missing ? ` (set ${parsed.missing})` : ''}.`);
  }

  if (!parsed) {
    throw new Error(
      res.ok
        ? `Unexpected non-JSON response from ${input}.`
        : `Request to ${input} failed (HTTP ${res.status}). The endpoint returned a non-JSON response.`,
    );
  }

  if (!res.ok && !parsed.ok) {
    throw new Error(parsed.error || `Request to ${input} failed (HTTP ${res.status}).`);
  }

  return parsed;
}
