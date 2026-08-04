/**
 * LoomAuthenticationProvider — implements `vscode.AuthenticationProvider` with
 * id `loom` (PRP S2). ONE sign-in for every Loom surface and any third-party
 * extension, versus Fabric's two non-shared sign-in commands.
 *
 * Two credential kinds, both landing in `vscode.SecretStorage` (the OS
 * keychain) and NOWHERE else (never a setting, file, or workspace-state — PRP
 * §2.4):
 *   • device-code — mints a `loom_session` cookie via the NDJSON flow
 *     (`auth/device-code.ts`, a port of the CLI's flow);
 *   • PAT — a scoped `loom_pat_…` token, verified against `/api/v1/whoami`
 *     before it is stored (so a bad token fails at paste, not at first use).
 *
 * Multi-deployment is the tenancy model (PRP A2/A4/W11): each deployment holds
 * an independent secret, so a Commercial and a Government session can be held
 * at once. Sessions are keyed by deployment id.
 *
 * Credential values are the SecretStorage payload; non-secret metadata (kind,
 * expiry, PAT scope, account label) lives in globalState so `getScope()` is a
 * synchronous read for the tree + write-guards.
 */
import * as vscode from 'vscode';
import { LoomApi, type Credential, isLoomApiError } from '../api/loom-client';
import { runDeviceCodeLogin, DeviceCodeError, type DevicePrompt } from './device-code';
import type { Deployment } from '../config/deployments';
import { log, logError } from '../logger';

export type Scope = 'read-only' | 'read-write' | 'admin';

interface SessionMeta {
  kind: 'cookie' | 'pat';
  /** Unix seconds a cookie session expires (undefined for PAT). */
  expiresAt?: number;
  /** PAT scope (undefined for a cookie session = full user access). */
  scope?: Scope;
  accountId: string;
  accountLabel: string;
}

type MetaStore = Record<string, SessionMeta>;

const META_STATE_KEY = 'loom.sessionMeta';
const secretKey = (id: string) => `loom.session.${id}`;

/** Skew (secs) before real expiry at which we consider a cookie session dead. */
const EXPIRY_SKEW = 30;

export class LoomAuthenticationProvider implements vscode.AuthenticationProvider {
  static readonly id = 'loom';

  private readonly _onDidChangeSessions =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  readonly onDidChangeSessions = this._onDidChangeSessions.event;

  private meta: MetaStore;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getDeployments: () => Deployment[],
  ) {
    this.meta = context.globalState.get<MetaStore>(META_STATE_KEY, {});
  }

  dispose(): void {
    this._onDidChangeSessions.dispose();
  }

  // --- vscode.AuthenticationProvider ---------------------------------------

  async getSessions(_scopes?: readonly string[]): Promise<vscode.AuthenticationSession[]> {
    const sessions: vscode.AuthenticationSession[] = [];
    for (const dep of this.getDeployments()) {
      const cred = await this.readCredential(dep.id);
      const m = this.meta[dep.id];
      if (cred && m) sessions.push(this.toSession(dep, cred, m));
    }
    return sessions;
  }

  /**
   * VS Code invokes this from `getSession(..., { createIfNone:true })`. We do
   * not know the target deployment here, so we prompt. The `Loom: Sign in`
   * command calls {@link signInToDeployment} directly with a chosen deployment.
   */
  async createSession(_scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
    const dep = await this.pickDeployment('Select a deployment to sign in to');
    if (!dep) throw new Error('Sign-in cancelled: no deployment selected.');
    const session = await this.signInToDeployment(dep);
    if (!session) throw new Error('Sign-in cancelled.');
    return session;
  }

  async removeSession(sessionId: string): Promise<void> {
    const dep = this.getDeployments().find((d) => d.id === sessionId);
    const m = this.meta[sessionId];
    const cred = await this.readCredential(sessionId);
    await this.context.secrets.delete(secretKey(sessionId));
    delete this.meta[sessionId];
    await this.context.globalState.update(META_STATE_KEY, this.meta);
    if (dep && m && cred) {
      this._onDidChangeSessions.fire({ added: [], removed: [this.toSession(dep, cred, m)], changed: [] });
    }
    log(`signed out of ${sessionId}`);
  }

  // --- Public API used by commands / tree / status bar ---------------------

  /** True if a stored, non-expired credential exists for the deployment. */
  async isSignedIn(deploymentId: string): Promise<boolean> {
    const cred = await this.readCredential(deploymentId);
    if (!cred) return false;
    return !this.isExpired(deploymentId);
  }

  /** True if ANY configured deployment has a live session. */
  async hasAnySession(): Promise<boolean> {
    for (const dep of this.getDeployments()) {
      if (await this.isSignedIn(dep.id)) return true;
    }
    return false;
  }

  /** Synchronous PAT-scope read for the tree + write-guards. */
  getScope(deploymentId: string): Scope | undefined {
    return this.meta[deploymentId]?.scope;
  }

  getMeta(deploymentId: string): SessionMeta | undefined {
    return this.meta[deploymentId];
  }

  /** True when the stored session is a read-only PAT (writes must be blocked). */
  isReadOnly(deploymentId: string): boolean {
    return this.meta[deploymentId]?.scope === 'read-only';
  }

  /** Synchronous "is this deployment signed in with a PAT?" — the MCP inclusion filter. */
  hasPat(deploymentId: string): boolean {
    return this.meta[deploymentId]?.kind === 'pat';
  }

  /**
   * The stored PAT for a deployment, or undefined. Returns a value ONLY for a
   * PAT session (a cookie session is never exposed as a bearer token) — this is
   * how the MCP provider gets a `LOOM_TOKEN` for exactly the target deployment
   * and nothing else.
   */
  async getPatFor(deploymentId: string): Promise<string | undefined> {
    if (this.meta[deploymentId]?.kind !== 'pat') return undefined;
    const cred = await this.readCredential(deploymentId);
    return cred?.kind === 'pat' ? cred.value : undefined;
  }

  /** Build an authenticated {@link LoomApi} for a deployment, or undefined. */
  async apiFor(dep: Deployment): Promise<LoomApi | undefined> {
    const cred = await this.readCredential(dep.id);
    if (!cred) return undefined;
    return new LoomApi(dep.apiUrl, cred);
  }

  /**
   * Interactive sign-in for a specific deployment. Prompts for method
   * (device-code / PAT), runs it, stores the secret, fires the change event.
   */
  async signInToDeployment(dep: Deployment): Promise<vscode.AuthenticationSession | undefined> {
    const method = await vscode.window.showQuickPick(
      [
        {
          label: '$(account) Sign in with your account',
          description: 'Device code — opens a browser',
          id: 'device',
        },
        {
          label: '$(key) Paste an API token (PAT)',
          description: 'loom_pat_… from Settings → Developer → API tokens',
          id: 'pat',
        },
      ],
      { title: `Sign in to ${dep.name}`, placeHolder: 'Choose a sign-in method' },
    );
    if (!method) return undefined;

    try {
      if (method.id === 'device') return await this.deviceCodeSignIn(dep);
      return await this.patSignIn(dep);
    } catch (e) {
      logError('signInToDeployment', e);
      const msg = e instanceof Error ? e.message : String(e);
      // Distinguish the known device-code failure classes (PRP T-4) so the
      // remediation is honest rather than a generic "sign-in failed".
      if (e instanceof DeviceCodeError && e.code === 'not_configured') {
        vscode.window.showErrorMessage(
          `${dep.name}: sign-in is not configured on this deployment. ${e.hint ?? ''} You can still sign in with a PAT.`,
        );
      } else if (e instanceof DeviceCodeError && e.status === 0) {
        vscode.window.showErrorMessage(
          `${dep.name} is unreachable from this network. If this is a Government deployment, confirm you are on the admin VPN. (${msg})`,
        );
      } else {
        vscode.window.showErrorMessage(`Sign-in to ${dep.name} failed: ${msg}`);
      }
      return undefined;
    }
  }

  private async deviceCodeSignIn(dep: Deployment): Promise<vscode.AuthenticationSession> {
    const session = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Signing in to ${dep.name}`, cancellable: false },
      async (progress) => {
        const onPrompt = async (p: DevicePrompt) => {
          await vscode.env.clipboard.writeText(p.userCode);
          progress.report({ message: `Enter code ${p.userCode} in the browser (copied to clipboard)` });
          void vscode.window
            .showInformationMessage(
              `To finish signing in to ${dep.name}, enter code ${p.userCode} (copied to your clipboard).`,
              'Open sign-in page',
            )
            .then((choice) => {
              if (choice) void vscode.env.openExternal(vscode.Uri.parse(p.verificationUri));
            });
          // Open immediately too — most users expect the page to pop.
          void vscode.env.openExternal(vscode.Uri.parse(p.verificationUri));
        };
        return runDeviceCodeLogin(dep.apiUrl, (p) => void onPrompt(p));
      },
    );

    const accountLabel = session.claims?.upn || session.claims?.name || session.claims?.oid || 'signed-in user';
    const accountId = session.claims?.oid || accountLabel;
    const meta: SessionMeta = {
      kind: 'cookie',
      expiresAt: session.expiresAt,
      scope: undefined,
      accountId,
      accountLabel,
    };
    await this.store(dep, { kind: 'cookie', value: session.cookie }, meta);
    return this.toSession(dep, { kind: 'cookie', value: session.cookie }, meta);
  }

  private async patSignIn(dep: Deployment): Promise<vscode.AuthenticationSession | undefined> {
    const token = await vscode.window.showInputBox({
      title: `Sign in to ${dep.name} with a PAT`,
      prompt: 'Paste a Loom API token (loom_pat_…). Stored only in the OS keychain.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) =>
        v && v.trim().startsWith('loom_pat_') ? undefined : 'A Loom PAT starts with "loom_pat_".',
    });
    if (!token) return undefined;
    const cred: Credential = { kind: 'pat', value: token.trim() };

    // Verify + resolve scope/identity BEFORE storing (fail at paste, not use).
    let scope: Scope | undefined;
    let accountId = 'pat';
    let accountLabel = 'API token';
    try {
      const who = await new LoomApi(dep.apiUrl, cred).whoami();
      scope = who.scope;
      accountId = who.oid || accountId;
      accountLabel = who.upn || who.name || accountLabel;
    } catch (e) {
      if (isLoomApiError(e) && e.status === 401) {
        throw new Error('That PAT was rejected (401). Check it was copied whole and is not revoked/expired.');
      }
      throw e;
    }

    const meta: SessionMeta = { kind: 'pat', scope, accountId, accountLabel };
    await this.store(dep, cred, meta);
    if (scope === 'read-only') {
      vscode.window.showInformationMessage(
        `Signed in to ${dep.name} with a read-only token. Create / rename / delete are disabled until you re-authenticate with a read-write token.`,
      );
    }
    return this.toSession(dep, cred, meta);
  }

  /** Interactive sign-out. Picks among signed-in deployments if id not given. */
  async signOut(deploymentId?: string): Promise<void> {
    let id = deploymentId;
    if (!id) {
      const signedIn: Deployment[] = [];
      for (const d of this.getDeployments()) if (await this.isSignedIn(d.id)) signedIn.push(d);
      if (signedIn.length === 0) {
        vscode.window.showInformationMessage('No CSA Loom deployments are signed in.');
        return;
      }
      const pick =
        signedIn.length === 1
          ? signedIn[0]
          : (await this.pickFrom(signedIn, 'Sign out of which deployment?'));
      if (!pick) return;
      id = pick.id;
    }
    await this.removeSession(id);
  }

  // --- storage helpers -----------------------------------------------------

  private async store(dep: Deployment, cred: Credential, meta: SessionMeta): Promise<void> {
    await this.context.secrets.store(secretKey(dep.id), cred.value);
    this.meta[dep.id] = meta;
    await this.context.globalState.update(META_STATE_KEY, this.meta);
    this._onDidChangeSessions.fire({ added: [this.toSession(dep, cred, meta)], removed: [], changed: [] });
    log(`signed in to ${dep.id} via ${meta.kind}${meta.scope ? ` (${meta.scope})` : ''}`);
  }

  private async readCredential(deploymentId: string): Promise<Credential | undefined> {
    const value = await this.context.secrets.get(secretKey(deploymentId));
    if (!value) return undefined;
    const m = this.meta[deploymentId];
    const kind = m?.kind ?? (value.startsWith('loom_pat_') ? 'pat' : 'cookie');
    return { kind, value } as Credential;
  }

  private isExpired(deploymentId: string): boolean {
    const m = this.meta[deploymentId];
    if (!m?.expiresAt) return false; // PAT / unknown → not locally expired
    return m.expiresAt <= Math.floor(Date.now() / 1000) + EXPIRY_SKEW;
  }

  private toSession(dep: Deployment, cred: Credential, meta: SessionMeta): vscode.AuthenticationSession {
    return {
      id: dep.id,
      accessToken: cred.value,
      account: { id: meta.accountId, label: `${meta.accountLabel} · ${dep.name}` },
      scopes: meta.scope ? [meta.scope] : [],
    };
  }

  // --- deployment pickers --------------------------------------------------

  async pickDeployment(title: string): Promise<Deployment | undefined> {
    const deps = this.getDeployments();
    if (deps.length === 0) {
      vscode.window.showWarningMessage('No CSA Loom deployments are configured. Run "CSA Loom: Add deployment…" first.');
      return undefined;
    }
    if (deps.length === 1) return deps[0];
    return this.pickFrom(deps, title);
  }

  private async pickFrom(deps: Deployment[], title: string): Promise<Deployment | undefined> {
    const pick = await vscode.window.showQuickPick(
      deps.map((d) => ({ label: d.name, description: d.apiUrl, detail: `cloud: ${d.cloud}`, dep: d })),
      { title, placeHolder: 'Select a deployment' },
    );
    return pick?.dep;
  }
}
