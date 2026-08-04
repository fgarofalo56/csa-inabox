/**
 * `McpServerDefinitionProvider` (Phase 4 / PRP M1+M5) — contributes the SHIPPED
 * `apps/loom-mcp` servers (bundled into `dist/mcp/` by `build.mjs`) to VS Code's
 * MCP registry, wired to the SELECTED deployment's `apiUrl` and the extension's
 * stored PAT. No hand-edited `mcp.json` (PRP S6), one sign-in reused (PRP §2.4).
 *
 * Blast-radius default (task security requirement): only the READ-ONLY servers
 * (`loom-catalog`, `loom-query`) are enabled by default. The write/admin servers
 * (`loom-author`, `loom-ops`, `loom-admin`) appear ONLY when the user has opted
 * them into `loom.mcp.enabledServers` — this provider never emits a server whose
 * id is not in that list.
 *
 * Secret handling: the PAT is injected at RESOLVE time (when a server is about to
 * start), looked up by the descriptor's own deployment id — so a token can never
 * reach a server pointed at a different deployment. Only PAT sessions produce a
 * definition (the MCP servers authenticate with `LOOM_TOKEN`); a cookie-only /
 * signed-out deployment yields no server, and the resolve path names the fix.
 *
 * Capability-guarded: on a VS Code without the MCP provider API (pre-1.102) this
 * no-ops, so Phases 1–3 keep working (PRP T-5).
 */
import * as vscode from 'vscode';
import type { LoomAuthenticationProvider } from '../auth/loom-auth-provider';
import type { Deployment } from '../config/deployments';
import type { ActiveDeploymentStore } from './active-deployment';
import {
  buildServerDefinitions,
  resolveServerEnv,
  coerceEnabledServers,
  type McpDefinitionDescriptor,
  type McpDeployment,
} from './server-definitions';
import { log } from '../logger';

export const MCP_PROVIDER_ID = 'loom';

interface McpProviderDeps {
  context: vscode.ExtensionContext;
  auth: LoomAuthenticationProvider;
  getDeployments: () => Deployment[];
  activeDeployment: ActiveDeploymentStore;
}

/** True when this VS Code exposes the finalized MCP provider API (1.102+). */
export function mcpApiAvailable(): boolean {
  const lm = (vscode as unknown as { lm?: Record<string, unknown> }).lm;
  return (
    typeof lm?.registerMcpServerDefinitionProvider === 'function' &&
    typeof (vscode as unknown as { McpStdioServerDefinition?: unknown }).McpStdioServerDefinition === 'function'
  );
}

/**
 * Register the Loom MCP provider. Returns `{ registered, refresh }`: `registered`
 * is false if the host lacks the API (honest no-op); `refresh` forces a
 * re-provide of the server list.
 */
export function registerMcpProvider(deps: McpProviderDeps): { registered: boolean; refresh: () => void } {
  if (!mcpApiAvailable()) {
    log('MCP server-definition API unavailable on this VS Code — @loom MCP servers not contributed (needs 1.102+).');
    return { registered: false, refresh: () => undefined };
  }

  const didChange = new vscode.EventEmitter<void>();
  // descriptor lookup for resolve, keyed by the stable label.
  let byLabel = new Map<string, McpDefinitionDescriptor>();

  const enabledIds = (): ReturnType<typeof coerceEnabledServers> =>
    coerceEnabledServers(vscode.workspace.getConfiguration('loom').get('mcp.enabledServers'));

  /** Deployments the extension can drive an MCP server for = those with a PAT session. */
  const patDeployments = (): McpDeployment[] =>
    deps
      .getDeployments()
      .filter((d) => deps.auth.hasPat(d.id))
      .map((d) => ({ id: d.id, name: d.name, apiUrl: d.apiUrl, cloud: d.cloud }));

  const provider = {
    onDidChangeMcpServerDefinitions: didChange.event,

    provideMcpServerDefinitions: async (): Promise<vscode.McpServerDefinition[]> => {
      const descriptors = buildServerDefinitions(patDeployments(), { enabled: enabledIds() });
      byLabel = new Map(descriptors.map((d) => [d.label, d]));
      const StdioDef = (vscode as unknown as { McpStdioServerDefinition: new (o: unknown) => vscode.McpServerDefinition })
        .McpStdioServerDefinition;
      return descriptors.map((desc) => {
        const binPath = vscode.Uri.joinPath(
          deps.context.extensionUri,
          'dist',
          'mcp',
          desc.server.bundle,
        ).fsPath;
        // No token yet — env carries only the non-secret base URL + scope hint.
        // ELECTRON_RUN_AS_NODE lets the VS Code binary run the bundle as node,
        // so no system `node` on PATH is required.
        const env = resolveServerEnv(desc, {});
        return new StdioDef({
          label: desc.label,
          command: process.execPath,
          args: [binPath],
          env: { ELECTRON_RUN_AS_NODE: '1', ...env },
          version: (deps.context.extension?.packageJSON?.version as string) || '0.1.0',
        });
      });
    },

    resolveMcpServerDefinition: async (
      server: vscode.McpServerDefinition,
    ): Promise<vscode.McpServerDefinition | undefined> => {
      const desc = byLabel.get(server.label);
      if (!desc) return server;
      const token = await deps.auth.getPatFor(desc.deploymentId);
      if (!token) {
        void vscode.window.showWarningMessage(
          `The MCP server "${desc.server.label}" needs a Personal Access Token for ${desc.deploymentName}. ` +
            `Run "CSA Loom: Sign in" and choose "Paste an API token".`,
          'Sign in',
        ).then((choice) => {
          if (choice) void vscode.commands.executeCommand('loom.signIn');
        });
        return undefined; // cancel start — never point a server at a token-less deployment
      }
      const binPath = vscode.Uri.joinPath(deps.context.extensionUri, 'dist', 'mcp', desc.server.bundle).fsPath;
      const env = resolveServerEnv(desc, { [desc.deploymentId]: token });
      const StdioDef = (vscode as unknown as { McpStdioServerDefinition: new (o: unknown) => vscode.McpServerDefinition })
        .McpStdioServerDefinition;
      return new StdioDef({
        label: desc.label,
        command: process.execPath,
        args: [binPath],
        env: { ELECTRON_RUN_AS_NODE: '1', ...env },
        version: (deps.context.extension?.packageJSON?.version as string) || '0.1.0',
      });
    },
  };

  const lm = (vscode as unknown as {
    lm: { registerMcpServerDefinitionProvider: (id: string, p: typeof provider) => vscode.Disposable };
  }).lm;
  deps.context.subscriptions.push(lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, provider));
  deps.context.subscriptions.push(didChange);

  // Re-provide when sessions, deployments, the enabled-set, or the active
  // deployment change (a PAT sign-in should surface its servers immediately).
  deps.context.subscriptions.push(deps.auth.onDidChangeSessions(() => didChange.fire()));
  deps.context.subscriptions.push(deps.activeDeployment.onDidChange(() => didChange.fire()));
  deps.context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('loom.mcp.enabledServers') || e.affectsConfiguration('loom.deployments')) {
        didChange.fire();
      }
    }),
  );

  log('MCP server-definition provider registered (default: catalog + query, read-only).');
  return { registered: true, refresh: () => didChange.fire() };
}
