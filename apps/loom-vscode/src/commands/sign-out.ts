import type { CommandContext, DeploymentNode } from './context';

/** `Loom: Sign out` (PRP A5). Optional DeploymentNode from the tree context menu. */
export async function signOut(cx: CommandContext, node?: DeploymentNode): Promise<void> {
  await cx.auth.signOut(node?.dep.id);
  await cx.syncAuthState();
  cx.tree.refresh();
}
