/**
 * The Copilot Studio error CONTRACT — the thrown shape, the gate code, and the
 * one envelope every Copilot Studio BFF route returns.
 *
 * WHY THIS IS ITS OWN MODULE. It lives apart from `copilot-studio-client.ts`
 * for two reasons, one structural and one measured:
 *
 *   1. A route that only needs to SHAPE AN ERROR should not have to import the
 *      whole Dataverse/BAP client to do it. This is a contract, not a transport.
 *   2. `check-file-size.mjs` freezes `copilot-studio-client.ts` at 1600 LOC
 *      (`monolith-creep ratchet — WS-E E3`) and adding this contract inline put
 *      it at 1601, taking the REQUIRED `guardrails` check red. The ratchet was
 *      asking for exactly this split, and the repo's own precedent — the
 *      `kql-database-editor` decomposition — extracts into sibling modules
 *      rather than raising a ceiling. Raising it would have been the answer
 *      that makes the number go green while making the problem worse.
 *
 * `copilot-studio-client.ts` re-exports `CopilotStudioError` so the fourteen
 * existing importers keep working unchanged; new code should import from here.
 */

export class CopilotStudioError extends Error {
  status: number;
  body?: unknown;
  endpoint?: string;
  /**
   * Machine-readable cause, when the client KNOWS it.
   *
   * A gate is honest only when it is DOCUMENTED (no-vaporware.md): the prose in
   * `message` tells a human what to do, and `code` is what lets a CONSUMER tell
   * "the add-on is not enabled" from "the server broke". Without it both were a
   * bare 5xx with a string, and anything reading the response had to guess —
   * which is stating a cause the response never established (deploy-integrity.md
   * R7), in whichever direction the reader happened to guess.
   *
   * Empty string means "this client does not know", and that is deliberate: an
   * unexplained failure must NOT acquire a reassuring code. `''` maps to the
   * generic `copilot_studio_error` at the envelope, which is not a gate code.
   */
  code: string;
  constructor(
    message: string,
    status: number,
    body?: unknown,
    endpoint?: string,
    code = '',
  ) {
    super(message);
    this.name = 'CopilotStudioError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
    this.code = code;
  }
}

/**
 * The gate code for "the Copilot Studio add-on is not enabled on this
 * environment".
 *
 * Exported because it is a CONTRACT, not a spelling: `e2e/_lib/copilot-verdict.ts`
 * lists it in GATE_CODES and DELIBERATE_GATE_CODES, and until this existed that
 * list named a code NOTHING in `app/api/**` emitted — so the classifier was
 * matching on a string that could never arrive, while the real gate came back
 * codeless and scored as a server fault.
 */
export const COPILOT_STUDIO_NOT_ENABLED = 'copilot_studio_not_enabled';

/** A CopilotStudioError that did not name its own cause. NOT a gate code. */
export const COPILOT_STUDIO_ERROR = 'copilot_studio_error';

/** The call never reached a backend that could refuse it. NOT a gate code. */
export const COPILOT_STUDIO_UNREACHABLE = 'copilot_studio_unreachable';

/**
 * The envelope every Copilot Studio BFF route returns for a thrown error.
 *
 * ONE copy, on purpose. This expression was hand-duplicated verbatim in
 * fourteen route files:
 *
 *   const status = e instanceof CopilotStudioError ? e.status : 502;
 *   return NextResponse.json({ ok:false, error, body: e?.body, status }, { status });
 *
 * — which is how every one of them ended up codeless together, and how they
 * would have drifted apart one at a time if the `code` had been added fourteen
 * times by hand.
 *
 * `code` is NEVER invented from the status. A CopilotStudioError that did not
 * name its own cause gets the generic `copilot_studio_error`, which is not in
 * GATE_CODES and therefore scores as a fault, not a gate. A non-CopilotStudioError
 * is a 502 `copilot_studio_unreachable`: the call never reached a backend that
 * could refuse it, so "not configured" would be a claim nothing established.
 */
export function copilotStudioErrorEnvelope(e: unknown): {
  status: number;
  body: { ok: false; code: string; error: string; body?: unknown; status: number };
} {
  const isCs = e instanceof CopilotStudioError;
  const status = isCs ? e.status : 502;
  const code = isCs ? (e.code || COPILOT_STUDIO_ERROR) : COPILOT_STUDIO_UNREACHABLE;
  const error = (e as any)?.message || String(e);
  return {
    status,
    body: { ok: false, code, error, body: (e as any)?.body, status },
  };
}
