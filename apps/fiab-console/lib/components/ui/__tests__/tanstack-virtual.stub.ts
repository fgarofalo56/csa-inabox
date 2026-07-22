/**
 * TEST-ONLY bootstrap stub for `@tanstack/react-virtual` (U10).
 *
 * The real package was added to package.json in the U10 PR, but worktree
 * agents cannot run `pnpm install` (parallel installs corrupt the shared
 * node_modules). Until the orchestrator's integration install lands the
 * package on disk, vitest.config.ts aliases the module id to THIS stub —
 * the alias is CONDITIONAL on the package directory being absent, so the
 * moment `pnpm install` runs, the real library takes over and this file is
 * inert (delete it together with types/tanstack-react-virtual.d.ts).
 *
 * Behavior: a windowless virtualizer that reports EVERY item as visible —
 * i.e. component tests exercise the exact full-render output the pre-U10
 * path produced, which is what the existing render assertions cover.
 */

export interface StubVirtualItem {
  index: number;
  start: number;
  end: number;
  size: number;
  key: number;
  lane: number;
}

export function useVirtualizer(opts: {
  count: number;
  getScrollElement: () => Element | null;
  estimateSize: (index: number) => number;
  overscan?: number;
}) {
  const items: StubVirtualItem[] = [];
  let offset = 0;
  for (let index = 0; index < opts.count; index++) {
    const size = opts.estimateSize(index);
    items.push({ index, start: offset, end: offset + size, size, key: index, lane: 0 });
    offset += size;
  }
  return {
    options: opts,
    scrollElement: null as Element | null,
    isScrolling: false,
    getVirtualItems: () => items,
    getVirtualIndexes: () => items.map((i) => i.index),
    getTotalSize: () => offset,
    measureElement: (_node?: Element | null) => undefined,
    measure: () => undefined,
    scrollToIndex: (_index: number, _opts?: unknown) => undefined,
    scrollToOffset: (_offset: number, _opts?: unknown) => undefined,
    scrollBy: (_delta: number, _opts?: unknown) => undefined,
    resizeItem: (_index: number, _size: number) => undefined,
  };
}

export function useWindowVirtualizer(opts: {
  count: number;
  estimateSize: (index: number) => number;
}) {
  return useVirtualizer({ ...opts, getScrollElement: () => null });
}

export function defaultRangeExtractor(range: {
  startIndex: number;
  endIndex: number;
  overscan: number;
  count: number;
}): number[] {
  const start = Math.max(0, range.startIndex - range.overscan);
  const end = Math.min(range.count - 1, range.endIndex + range.overscan);
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}
