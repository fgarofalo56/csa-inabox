import { HttpTransport, enc } from '../http.js';
import { LoomApiError } from '../errors.js';
import { isKnownItemType } from '../item-types.js';
import type { Item, CreateItemInput, UpdateItemInput } from '../types.js';

/**
 * Item operations. Mirrors the CLI split:
 *   • list/create scope to a workspace (`/api/workspaces/{id}/items`);
 *   • get/update/delete use the typed CRUD (`/api/cosmos-items/{type}/{id}`).
 *
 * `itemType` is validated against the SDK taxonomy so a typo fails fast
 * locally instead of creating a mistyped item server-side.
 */
export class ItemsResource {
  constructor(private readonly http: HttpTransport) {}

  private assertType(t: string): void {
    if (!isKnownItemType(t)) {
      throw new LoomApiError(`Unknown item type "${t}". See ITEM_TYPES for the full list.`, 400, 'unknown_item_type');
    }
  }

  /** List items in a workspace. */
  async list(workspaceId: string): Promise<Item[]> {
    return this.http.request<Item[]>('GET', `/api/workspaces/${enc(workspaceId)}/items`);
  }

  /** Create an item in a workspace. */
  async create(workspaceId: string, input: CreateItemInput): Promise<Item> {
    this.assertType(input.itemType);
    return this.http.request<Item>('POST', `/api/workspaces/${enc(workspaceId)}/items`, input);
  }

  /** Get an item by type + id. */
  async get(type: string, id: string): Promise<Item> {
    this.assertType(type);
    return this.http.request<Item>('GET', `/api/cosmos-items/${enc(type)}/${enc(id)}`);
  }

  /** Update an item's name / description / state. */
  async update(type: string, id: string, patch: UpdateItemInput): Promise<Item> {
    this.assertType(type);
    return this.http.request<Item>('PATCH', `/api/cosmos-items/${enc(type)}/${enc(id)}`, patch);
  }

  /** Delete an item. */
  async delete(type: string, id: string): Promise<void> {
    this.assertType(type);
    await this.http.requestVoid('DELETE', `/api/cosmos-items/${enc(type)}/${enc(id)}`);
  }
}
