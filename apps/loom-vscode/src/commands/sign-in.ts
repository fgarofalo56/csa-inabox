import type { CommandContext, DeploymentNode } from './context';

/**
 * `Loom: Sign in` (PRP A1/S2). Invoked from the palette, the status bar, or a
 * per-deployment "Sign in…" tree node (which passes the DeploymentNode).
 */
export async function signIn(cx: CommandContext, node?: DeploymentNode): Promise<void> {
  const dep = node?.dep ?? (await cx.auth.pickDeployment('Sign in to which deployment?'));
  if (!dep) return;
  const session = await cx.auth.signInToDeployment(dep);
  if (session) {
    await cx.syncAuthState();
    cx.tree.refresh();
  }
}
