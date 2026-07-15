import { HttpTransport, enc } from '../http.js';
import type { CatalogSearchResult, CatalogSearchOptions } from '../types.js';

/** Federated catalog search — `GET /api/catalog/search`. */
export class CatalogResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Search across Purview + Unity Catalog + OneLake. Pass an empty query for a
   * recent-items browse.
   */
  async search(query: string, opts: CatalogSearchOptions = {}): Promise<CatalogSearchResult> {
    const params = new URLSearchParams();
    params.set('q', query ?? '');
    if (opts.source) params.set('source', Array.isArray(opts.source) ? opts.source.join(',') : opts.source);
    if (opts.limit != null) params.set('limit', String(opts.limit));
    return this.http.request<CatalogSearchResult>('GET', `/api/catalog/search?${params.toString()}`);
  }
}
