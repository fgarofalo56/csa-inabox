/**
 * Active-deployment selection (Phase 4). Both the MCP provider and the `@loom`
 * chat participant act against ONE deployment at a time — the "active" one. The
 * tree stays multi-deployment; this is only the target for MCP + chat.
 *
 * The resolution is a PURE function so it is unit-testable; the store is a thin
 * `globalState` wrapper around it.
 */
import * as vscode from 'vscode';
import type { Deployment } from '../config/deployments';

const ACTIVE_KEY = 'loom.activeDeploymentId';

/**
 * Resolve the active deployment: the stored id if it still exists, else the sole
 * deployment, else the first configured one, else undefined (none configured).
 */
export function resolveActiveDeployment(
  deployments: readonly Deployment[],
  storedId: string | undefined,
): Deployment | undefined {
  if (deployments.length === 0) return undefined;
  if (storedId) {
    const match = deployments.find((d) => d.id === storedId);
    if (match) return match;
  }
  return deployments[0];
}

export class ActiveDeploymentStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getDeployments: () => Deployment[],
  ) {}

  /** The resolved active deployment (undefined = none configured). */
  get(): Deployment | undefined {
    return resolveActiveDeployment(this.getDeployments(), this.context.globalState.get<string>(ACTIVE_KEY));
  }

  /** Set (and persist) the active deployment id, then notify listeners. */
  async set(id: string): Promise<void> {
    await this.context.globalState.update(ACTIVE_KEY, id);
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
