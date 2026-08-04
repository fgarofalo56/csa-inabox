/**
 * LoomUriHandler (N9) — handles `vscode://csa-loom.loom-vscode/open?…` deep links
 * so a Console "Open in VS Code" button opens the exact item in the editor.
 *
 * Registered in `activate()` via `vscode.window.registerUriHandler`; the manifest
 * adds `onUri` to `activationEvents` so a cold-start deep link activates the
 * extension first. All parsing/matching is delegated to the PURE `open-uri.ts`
 * (unit-tested); this thin shell resolves the target deployment and opens the
 * item's `loom:` definition — the same document the tree opens on click.
 *
 * Honesty (no-vaporware.md): a link to a deployment the user has NOT configured
 * offers to add it (never a silent no-op); a link to an unknown path is ignored,
 * not guessed.
 */
import * as vscode from 'vscode';
import type { Deployment } from '../config/deployments';
import type { LoomAuthenticationProvider } from '../auth/loom-auth-provider';
import { LoomFileSystemProvider } from '../fs/loom-fs-provider';
import { buildDefinitionPath } from '../fs/definition-uri';
import { parseOpenUri, hostOf, type OpenTarget } from './open-uri';
import { log, logError } from '../logger';

export interface UriHandlerDeps {
  getDeployments: () => Deployment[];
  auth: LoomAuthenticationProvider;
}

export class LoomUriHandler implements vscode.UriHandler {
  constructor(private readonly deps: UriHandlerDeps) {}

  async handleUri(uri: vscode.Uri): Promise<void> {
    const target = parseOpenUri(uri.path, uri.query);
    if (!target) {
      log(`UriHandler ignored unrecognised link: ${uri.toString()}`);
      return;
    }
    try {
      await this.open(target);
    } catch (e) {
      logError('UriHandler.open', e);
      vscode.window.showErrorMessage(
        `CSA Loom: could not open ${target.itemType}/${target.itemId} — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Resolve the deployment + open the item's definition, or guide the user. */
  private async open(target: OpenTarget): Promise<void> {
    const dep = this.resolveDeployment(target);
    if (!dep) {
      const add = 'Add deployment…';
      const detail = target.apiUrl ? ` (${target.apiUrl})` : '';
      const choice = await vscode.window.showWarningMessage(
        `This link points at a CSA Loom deployment${detail} that isn't configured here. Add it, then open the link again.`,
        add,
      );
      if (choice === add) await vscode.commands.executeCommand('loom.addDeployment');
      return;
    }

    if (!(await this.deps.auth.isSignedIn(dep.id))) {
      const signIn = 'Sign in';
      const choice = await vscode.window.showWarningMessage(
        `Sign in to ${dep.name} to open ${target.itemType} “${target.itemId}”.`,
        signIn,
      );
      if (choice !== signIn) return;
      await vscode.commands.executeCommand('loom.signIn', { kind: 'deployment', dep });
      if (!(await this.deps.auth.isSignedIn(dep.id))) return;
    }

    const loomUri = vscode.Uri.from({
      scheme: LoomFileSystemProvider.scheme,
      path: buildDefinitionPath({
        deploymentId: dep.id,
        itemType: target.itemType,
        itemId: target.itemId,
        displayName: target.itemId,
      }),
    });
    await vscode.commands.executeCommand('vscode.open', loomUri, { preview: false });
    log(`UriHandler opened ${target.itemType}/${target.itemId} on ${dep.id}`);
  }

  /** Match a link's target to a configured deployment: by id, then by apiUrl host. */
  private resolveDeployment(target: OpenTarget): Deployment | undefined {
    const deps = this.deps.getDeployments();
    if (target.deploymentId) {
      const byId = deps.find((d) => d.id === target.deploymentId);
      if (byId) return byId;
    }
    if (target.apiUrl) {
      const host = hostOf(target.apiUrl);
      if (host) {
        const byHost = deps.find((d) => hostOf(d.apiUrl) === host);
        if (byHost) return byHost;
      }
    }
    // A bare deployment token might itself be an apiUrl host the user configured.
    if (target.deploymentId && /\./.test(target.deploymentId)) {
      const asHost = target.deploymentId.toLowerCase();
      const byHost = deps.find((d) => hostOf(d.apiUrl) === asHost);
      if (byHost) return byHost;
    }
    return undefined;
  }
}
