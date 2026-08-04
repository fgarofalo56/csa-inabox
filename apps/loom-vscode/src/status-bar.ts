/**
 * Status bar (PRP A5): shows the signed-in identity + deployment + PAT scope.
 * Identity is read live from `GET /api/auth/me` (the task-named route); scope
 * comes from the stored session metadata (resolved from `/api/v1/whoami` at
 * sign-in). Refreshes whenever sessions or deployments change.
 */
import * as vscode from 'vscode';
import type { LoomAuthenticationProvider } from './auth/loom-auth-provider';
import type { Deployment } from './config/deployments';
import { logError } from './logger';

export class StatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(
    context: vscode.ExtensionContext,
    private readonly auth: LoomAuthenticationProvider,
    private readonly getDeployments: () => Deployment[],
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.name = 'CSA Loom';
    context.subscriptions.push(this.item);
  }

  async update(): Promise<void> {
    const deps = this.getDeployments();
    const signedIn: Deployment[] = [];
    for (const d of deps) if (await this.auth.isSignedIn(d.id)) signedIn.push(d);

    if (signedIn.length === 0) {
      this.item.text = '$(sign-in) Loom: Sign in';
      this.item.tooltip = deps.length
        ? 'CSA Loom — not signed in. Click to sign in.'
        : 'CSA Loom — no deployments configured. Click to add one.';
      this.item.command = deps.length ? 'loom.signIn' : 'loom.addDeployment';
      this.item.show();
      return;
    }

    const primary = signedIn[0];
    let identity = this.auth.getMeta(primary.id)?.accountLabel ?? 'signed in';
    try {
      const api = await this.auth.apiFor(primary);
      if (api) {
        const me = await api.me();
        identity = me.upn || me.name || me.email || identity;
      }
    } catch (e) {
      logError('status-bar me()', e);
    }
    const scope = this.auth.getScope(primary.id);
    const scopeSuffix = scope ? ` · ${scope}` : '';
    const more = signedIn.length > 1 ? ` (+${signedIn.length - 1})` : '';
    this.item.text = `$(account) ${identity} · ${primary.name}${scopeSuffix}${more}`;

    const lines = ['**CSA Loom**', ''];
    for (const d of signedIn) {
      const m = this.auth.getMeta(d.id);
      lines.push(`- ${d.name} (${d.cloud}) — ${m?.accountLabel ?? 'signed in'}${m?.scope ? ` · ${m.scope}` : ''}`);
    }
    lines.push('', '_Click to sign out._');
    this.item.tooltip = new vscode.MarkdownString(lines.join('\n'));
    this.item.command = 'loom.signOut';
    this.item.show();
  }
}
