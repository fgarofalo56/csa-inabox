import { HttpTransport, enc } from '../http.js';
import type { TokenView, CreateTokenInput, CreateTokenResult } from '../types.js';

/**
 * API-token management — `GET/POST /api/developer/tokens`,
 * `DELETE /api/developer/tokens/{id}`.
 *
 * NOTE: token management is a **cookie-only** surface server-side — a PAT can
 * never mint or revoke tokens. Construct the client with a `cookie` (from a
 * service-principal login), not a `token`, to use these methods.
 */
export class TokensResource {
  constructor(private readonly http: HttpTransport) {}

  /** List the caller's own tokens (never the secret). */
  async list(): Promise<TokenView[]> {
    const res = await this.http.request<{ ok: boolean; tokens: TokenView[] }>('GET', '/api/developer/tokens');
    return res.tokens ?? [];
  }

  /** Create a token. The full secret is returned ONCE in `result.token`. */
  async create(input: CreateTokenInput): Promise<CreateTokenResult> {
    return this.http.request<CreateTokenResult>('POST', '/api/developer/tokens', input);
  }

  /** Revoke one of the caller's tokens. */
  async revoke(id: string): Promise<void> {
    await this.http.requestVoid('DELETE', `/api/developer/tokens/${enc(id)}`);
  }
}
