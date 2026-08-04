import type { CommandContext } from './context';

/** `Loom: Refresh` — re-fetch the tree and re-probe the status bar. */
export async function refresh(cx: CommandContext): Promise<void> {
  cx.tree.refresh();
  await cx.statusBar.update();
}
