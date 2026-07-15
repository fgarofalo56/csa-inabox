import { HttpTransport } from '../http.js';
import type { ThreadEdge } from '../types.js';

/** Loom Thread (Weave) lineage — `GET /api/thread/edges`. */
export class ThreadResource {
  constructor(private readonly http: HttpTransport) {}

  /** The caller's Loom Thread edge graph, most recent first. */
  async edges(): Promise<ThreadEdge[]> {
    const res = await this.http.request<{ ok: boolean; edges: ThreadEdge[] }>('GET', '/api/thread/edges');
    return res.edges ?? [];
  }
}
