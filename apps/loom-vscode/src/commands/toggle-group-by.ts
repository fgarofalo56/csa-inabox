import type { CommandContext } from './context';

/** `Loom: Toggle group by type` (PRP W2). */
export async function toggleGroupBy(cx: CommandContext): Promise<void> {
  await cx.tree.toggleGroupBy();
}
