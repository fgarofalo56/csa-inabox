/**
 * LOOM BRAIN W10 — the scan's credential, and the assertion on it (#3936).
 *
 * The IMPURE half of `../token-identity.ts`. Everything that decides anything
 * lives there and is proven with fixtures; this file constructs the SDK object
 * and wires the decision in at the one place every Azure call passes through.
 *
 * ── WHY A WRAPPER AND NOT A DIFFERENT CREDENTIAL (review of #4014, B1) ─────
 * Three constraints meet here, and only one shape satisfies all three:
 *
 *  1. `scripts/ci/check-workspace-credential-adoption.mjs` is a SHRINK-ONLY
 *     ratchet on `new ChainedTokenCredential(` at baseline 130. Composing an
 *     explicit two-leg chain would take the repo to 131 and fail the gate — the
 *     exact trap the note in `../cosmos-finding-store.ts` records this lane
 *     falling into once already.
 *
 *  2. `tsconfig.cli.json` declares NO `paths` mapping, so nothing in the CLI's
 *     emit closure may use the `@/` alias. `lib/azure/arm-credential.ts` and its
 *     transitive imports are therefore unavailable here, whatever the lint gate
 *     would prefer.
 *
 *  3. `AZURE_TOKEN_CREDENTIALS` narrows `DefaultAzureCredential` to exactly ONE
 *     credential, not to a chain. Setting it to `managedidentitycredential`
 *     would work on the in-VNet Commercial runner and would make the Gov job —
 *     which runs on `ubuntu-latest`, where no managed identity exists at all —
 *     fail with an IMDS timeout instead of the reason it actually has. One
 *     boundary's fix would become the other boundary's new defect, which is the
 *     `cloud-parity.md` failure this whole finding is about.
 *
 * So: keep the SDK's own chain, remove what was SHADOWING it (the job-level
 * `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` / `AZURE_TENANT_ID` are gone from
 * both jobs), and then ASSERT the outcome rather than trusting it. The assertion
 * is what makes this durable: the chain may reorder, a runner may lose its
 * identity, an env var may come back — and any of those now fails LOUDLY with
 * the principal it actually got, instead of silently 403-ing inside Cosmos three
 * steps later.
 *
 * ── THE ASSERTION RUNS ONCE, AND ITS RESULT IS STICKY ──────────────────────
 * `getToken` is called many times per run (one ARM token, one Cosmos token, and
 * again on refresh). Decoding on every call would put the same line in the log
 * dozens of times and would let a LATER token quietly differ from the one that
 * was checked. So the verdict is computed on the first token and REMEMBERED,
 * and every subsequent token is checked against the same expectation — a
 * mismatch at any point fails, not just at the first.
 */

import { DefaultAzureCredential, type AccessToken, type TokenCredential } from '@azure/identity';
import { assertTokenIdentity, type IdentityVerdict } from '../token-identity';

/** Raised when the run authenticated as a principal it did not declare. */
export class ScanIdentityError extends Error {
  readonly verdict: IdentityVerdict;
  constructor(verdict: IdentityVerdict) {
    super(verdict.message);
    this.name = 'ScanIdentityError';
    this.verdict = verdict;
  }
}

export interface ScanCredentialOptions {
  /**
   * The identity this run DECLARES it will use — `LOOM_UAMI_CLIENT_ID`, which
   * the platform bicep emits onto the console app and the workflow reads back
   * off it. Empty means no expectation is declared; the identity is then
   * REPORTED rather than asserted.
   */
  readonly expectedClientId: string;
  /** Boundary label, for the message only. */
  readonly cloud: string;
  /**
   * Called ONCE, with the verdict, the first time a token is minted.
   *
   * Deliberately a callback rather than a `console.log`: this module sits in the
   * CLI's emit closure and the CLI owns where its output goes.
   */
  readonly onIdentity?: (verdict: IdentityVerdict) => void;
}

/**
 * Wraps a credential and asserts WHO minted each token it hands back.
 *
 * Exported so `__tests__` can drive it with a fake inner credential — the point
 * of splitting the decision into `../token-identity.ts` is undone if the wiring
 * itself is only observable against a live tenant.
 */
export class IdentityAssertingCredential implements TokenCredential {
  private reported = false;

  constructor(
    private readonly inner: TokenCredential,
    private readonly options: ScanCredentialOptions,
  ) {}

  async getToken(
    scopes: string | string[],
    options?: Parameters<TokenCredential['getToken']>[1],
  ): Promise<AccessToken | null> {
    const token = await this.inner.getToken(scopes, options);
    // A null token is NOT an identity failure — it is the SDK saying it could
    // not authenticate at all, and the caller classifies that as `auth`. Making
    // it an identity error here would replace a true reason with a wrong one.
    if (token === null) return null;

    const verdict = assertTokenIdentity({
      token: token.token,
      expectedClientId: this.options.expectedClientId,
      cloud: this.options.cloud,
    });

    if (!this.reported) {
      this.reported = true;
      this.options.onIdentity?.(verdict);
    }
    // Checked on EVERY token, not only the first: a refresh that came back as a
    // different principal is the same defect arriving later.
    if (!verdict.ok) throw new ScanIdentityError(verdict);

    return token;
  }
}

/**
 * The credential every Azure call in this lane goes through.
 *
 * `managedIdentityClientId` still selects WHICH managed identity, which is
 * meaningful now that nothing shadows that leg. What changed is that the outcome
 * is no longer taken on trust.
 */
export function scanCredential(options: ScanCredentialOptions): TokenCredential {
  const clientId = options.expectedClientId.trim();
  const inner = new DefaultAzureCredential(
    clientId ? { managedIdentityClientId: clientId } : {},
  );
  return new IdentityAssertingCredential(inner, { ...options, expectedClientId: clientId });
}
