import { HttpTransport, enc } from '../http.js';
import type { Workspace, CreateWorkspaceInput, UpdateItemInput } from '../types.js';

/**
 * Workspace operations — `GET/POST /api/workspaces`,
 * `GET/PATCH/DELETE /api/workspaces/{id}`.
 */
export class WorkspacesResource {
  constructor(private readonly http: HttpTransport) {}

  /** List workspaces accessible to the caller. */
  async list(opts: { count?: boolean } = {}): Promise<Workspace[]> {
    const q = opts.count ? '?count=true' : '';
    return this.http.request<Workspace[]>('GET', `/api/workspaces${q}`);
  }

  /** Get one workspace by id. */
  async get(id: string): Promise<Workspace> {
    return this.http.request<Workspace>('GET', `/api/workspaces/${enc(id)}`);
  }

  /** Create a workspace. */
  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    return this.http.request<Workspace>('POST', '/api/workspaces', input);
  }

  /** Update a workspace's name / description. */
  async update(id: string, patch: Pick<UpdateItemInput, 'displayName' | 'description'> & { name?: string }): Promise<Workspace> {
    return this.http.request<Workspace>('PATCH', `/api/workspaces/${enc(id)}`, patch);
  }

  /** Delete a workspace. */
  async delete(id: string): Promise<void> {
    await this.http.requestVoid('DELETE', `/api/workspaces/${enc(id)}`);
  }
}
