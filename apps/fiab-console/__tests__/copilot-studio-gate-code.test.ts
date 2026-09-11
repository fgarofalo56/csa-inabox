/**
 * The Copilot Studio enablement gate must NAME ITSELF, all the way to the wire.
 *
 * WHY THIS SUITE EXISTS. `e2e/_lib/copilot-verdict.ts` listed
 * `copilot_studio_not_enabled` in GATE_CODES and DELIBERATE_GATE_CODES, and
 * NOTHING under `app/api/**` emitted it — `git grep` returned hits only in the
 * classifier and a comment. The real gate was a CODELESS 503 thrown by
 * `lib/azure/copilot-studio-client.ts` and passed through a `handleErr` that
 * built `{ ok, error, body, status }` with no `code` field at all. So the
 * classifier's honest-gate branch could never fire for Copilot Studio, and once
 * the codeless-5xx rule landed the honest gate scored as a server fault.
 *
 * Both halves are pinned here, and the JOIN between them:
 *   1. the client throws with the code,
 *   2. the envelope every Copilot Studio route returns carries it,
 *   3. the UAT classifier reads that envelope as a GATE, not a fail.
 *
 * Asserting (1) and (2) separately would not catch a route that builds its own
 * envelope, and asserting (3) on a hand-written fixture would only prove the
 * classifier matches a string this file invented. (3) therefore runs on the
 * bytes (2) actually produces.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classify, gateIsFailure, GATE_CODES, DELIBERATE_GATE_CODES } from '../e2e/_lib/copilot-verdict';

const powerPlatformFetch = vi.fn();

vi.mock('@/lib/azure/power-platform-auth', () => ({
  powerPlatformFetch: (...a: any[]) => powerPlatformFetch(...a),
  bapBase: () => 'https://api.bap.microsoft.com',
  bapScope: () => 'https://api.bap.microsoft.com/.default',
}));

/** A `Response`-alike with just the surface `rawCall` touches. */
function res(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const ENV_ID = '11111111-1111-1111-1111-111111111111';
const DV_HOST = 'contoso.crm.dynamics.com';
const BAP_HOST = 'api.bap.microsoft.com';

/**
 * Which backend a mocked call is going to, by ORIGIN — never by substring.
 *
 * `url.includes('bap.microsoft.com')` is what this was, and CodeQL flagged it
 * twice as HIGH (`js/incomplete-url-substring-sanitization`). Nothing was
 * exploitable — the test builds the URL it then inspects — but the rule is
 * pointing at something real even in a fixture: a substring test matches
 * `https://evil.example.com/?x=bap.microsoft.com` and, more to the point here,
 * it would silently keep matching if `bapBase()` ever moved to a sovereign host
 * that merely CONTAINS the commercial one. Parsing the URL makes the fixture
 * stricter as well as quiet, which is why this is the fix rather than an escape
 * edit — the last `useless-escape` "fix" in this repo shipped a SyntaxError.
 */
const isBapCall = (url: string) => new URL(url).hostname === BAP_HOST;

/** The BAP environment list, so `envHost()` resolves before the Dataverse call. */
const BAP_ENVS = {
  value: [{
    name: ENV_ID,
    properties: {
      displayName: 'UAT',
      linkedEnvironmentMetadata: { instanceUrl: `https://${DV_HOST}` },
    },
  }],
};

/**
 * The literal Dataverse body for a missing entity set. The client keys its
 * classification off this exact phrasing, so the fixture has to carry it
 * verbatim — a paraphrase would exercise the fallback branch instead and the
 * suite would pass while proving the wrong thing.
 */
const DV_NOT_ENABLED = {
  error: { message: "Resource not found for the segment 'msdyn_copilots'." },
};

beforeEach(() => {
  vi.resetModules();
  powerPlatformFetch.mockReset();
});

describe('the client throws the enablement gate WITH its code', () => {
  it('a Dataverse 404 on msdyn_copilots becomes a 503 copilot_studio_not_enabled', async () => {
    powerPlatformFetch.mockImplementation(async (url: string) => {
      if (isBapCall(url)) return { res: res(200, BAP_ENVS), identity: 'sp' };
      return { res: res(404, DV_NOT_ENABLED), identity: 'sp' };
    });
    const { listAgents, CopilotStudioError, COPILOT_STUDIO_NOT_ENABLED } =
      await import('@/lib/azure/copilot-studio-client');

    const err = await listAgents(ENV_ID).then(() => null, (e) => e);
    expect(err, 'listAgents must reject on a missing entity set').toBeInstanceOf(CopilotStudioError);
    expect(err.status).toBe(503);
    expect(err.code).toBe(COPILOT_STUDIO_NOT_ENABLED);
    expect(err.code).toBe('copilot_studio_not_enabled');
  });

  it('a Dataverse 404 on some OTHER table does NOT get the enablement code', async () => {
    // The distinction is load-bearing: a genuinely wrong table name reported as
    // "enable Copilot Studio" is an R7 untruth, and it is also how a real schema
    // defect would read as a supported configuration.
    powerPlatformFetch.mockImplementation(async (url: string) => {
      if (isBapCall(url)) return { res: res(200, BAP_ENVS), identity: 'sp' };
      return { res: res(404, { error: { message: "Resource not found for the segment 'msdyn_botchannels'." } }), identity: 'sp' };
    });
    const { listAgents } = await import('@/lib/azure/copilot-studio-client');
    const err = await listAgents(ENV_ID).then(() => null, (e) => e);
    // The BRANCH is pinned first. Without this the assertion passed on a 409
    // raised before the Dataverse call was ever made — a fixture whose BAP
    // shape was wrong never reached the code under test, and "the code is not
    // the enablement code" was trivially true of an error from somewhere else.
    // The honest schema error is a codeless 502 naming the entity.
    expect(err.status).toBe(502);
    expect(err.message).toContain("msdyn_botchannels");
    expect(err.code).not.toBe('copilot_studio_not_enabled');
    // …and it therefore still scores as a FAILURE, which is the point: a real
    // schema defect must not acquire a gate code and start reading as
    // "supported configuration".
    const { copilotStudioErrorEnvelope } = await import('@/lib/azure/copilot-studio-client');
    const { status, body } = copilotStudioErrorEnvelope(err);
    expect(classify({ status, ct: 'application/json', text: JSON.stringify(body) }).verdict)
      .toBe('fail');
  });
});

describe('the client still re-exports the contract (14 importers depend on it)', () => {
  // The contract moved to `lib/azure/copilot-studio-error.ts` so the client
  // stays under its `check-file-size.mjs` ceiling. Fourteen files import
  // `CopilotStudioError` off the CLIENT, so the re-export is a compatibility
  // surface, not decoration — and a surface nothing asserts is one refactor
  // away from disappearing quietly.
  it('exposes CopilotStudioError, the gate code and the envelope', async () => {
    const mod: any = await import('@/lib/azure/copilot-studio-client');
    expect(typeof mod.CopilotStudioError).toBe('function');
    expect(mod.COPILOT_STUDIO_NOT_ENABLED).toBe('copilot_studio_not_enabled');
    expect(typeof mod.copilotStudioErrorEnvelope).toBe('function');
  });

  it('re-exports the SAME class the contract module defines', async () => {
    // Not merely "a function called CopilotStudioError" — identity, so an
    // `instanceof` check inside the envelope cannot silently start comparing
    // against a different class.
    const viaClient: any = await import('@/lib/azure/copilot-studio-client');
    const viaContract: any = await import('@/lib/azure/copilot-studio-error');
    expect(viaClient.CopilotStudioError).toBe(viaContract.CopilotStudioError);
  });
});

describe('the envelope every Copilot Studio route returns', () => {
  it('carries the gate code for the enablement 503', async () => {
    const { CopilotStudioError, copilotStudioErrorEnvelope, COPILOT_STUDIO_NOT_ENABLED } =
      await import('@/lib/azure/copilot-studio-client');
    const { status, body } = copilotStudioErrorEnvelope(
      new CopilotStudioError('Copilot Studio is not enabled…', 503, null, undefined, COPILOT_STUDIO_NOT_ENABLED),
    );
    expect(status).toBe(503);
    expect(body).toMatchObject({ ok: false, code: 'copilot_studio_not_enabled', status: 503 });
  });

  it('gives an unexplained CopilotStudioError the GENERIC code, never a gate code', async () => {
    const { CopilotStudioError, copilotStudioErrorEnvelope } =
      await import('@/lib/azure/copilot-studio-client');
    const { body } = copilotStudioErrorEnvelope(new CopilotStudioError('boom', 503));
    expect(body.code).toBe('copilot_studio_error');
    expect(GATE_CODES).not.toContain(body.code);
  });

  it('a non-CopilotStudioError is a 502 copilot_studio_unreachable, not a gate', async () => {
    const { copilotStudioErrorEnvelope } = await import('@/lib/azure/copilot-studio-client');
    const { status, body } = copilotStudioErrorEnvelope(new Error('getaddrinfo ENOTFOUND'));
    expect(status).toBe(502);
    expect(body.code).toBe('copilot_studio_unreachable');
    expect(GATE_CODES).not.toContain(body.code);
  });
});

describe('the JOIN — the UAT classifier reads the real envelope correctly', () => {
  /** Exactly what a route returns: `NextResponse.json(body, { status })`. */
  async function probeFor(e: unknown) {
    const { copilotStudioErrorEnvelope } = await import('@/lib/azure/copilot-studio-client');
    const { status, body } = copilotStudioErrorEnvelope(e);
    return { status, ct: 'application/json', text: JSON.stringify(body) };
  }

  it('the enablement gate scores GATE — this is the case that was scoring fail', async () => {
    const { CopilotStudioError, COPILOT_STUDIO_NOT_ENABLED } =
      await import('@/lib/azure/copilot-studio-client');
    const p = await probeFor(
      new CopilotStudioError('Copilot Studio is not enabled…', 503, null, undefined, COPILOT_STUDIO_NOT_ENABLED),
    );
    expect(classify(p).verdict).toBe('gate');
    // And it is a DELIBERATE gate: a Power Platform add-on nobody turned on is
    // a choice, not a broken Loom deployment.
    expect(DELIBERATE_GATE_CODES).toContain('copilot_studio_not_enabled');
    expect(gateIsFailure(p, 'gate', { requireReal: true })).toBe(false);
  });

  it('an unexplained 503 still scores FAIL — the rule is not weakened', async () => {
    const { CopilotStudioError } = await import('@/lib/azure/copilot-studio-client');
    const p = await probeFor(new CopilotStudioError('boom', 503));
    expect(classify(p).verdict).toBe('fail');
  });

  it('an unreachable backend scores FAIL, not "not configured"', async () => {
    const p = await probeFor(new Error('getaddrinfo ENOTFOUND'));
    expect(classify(p).verdict).toBe('fail');
  });

  it('a token failure stays a tolerated 401 infra gate (Power Platform not wired)', async () => {
    // The default "no Power Platform in this deployment" shape: the client's
    // shared transport turns a minting failure into CopilotStudioError(…, 401).
    // It must NOT become a failure — Loom provisions no Power Platform tenant.
    const { CopilotStudioError } = await import('@/lib/azure/copilot-studio-client');
    const p = await probeFor(new CopilotStudioError('no Dataverse credential', 401));
    expect(classify(p).verdict).toBe('gate');
  });
});
