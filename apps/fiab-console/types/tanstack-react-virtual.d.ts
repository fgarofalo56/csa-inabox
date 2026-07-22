/**
 * ⚠️ TEMPORARY TYPE SHIM — DELETE THIS FILE AT INTEGRATION ⚠️
 *
 * `@tanstack/react-virtual` was added to package.json in the U10 PR, but the
 * worktree agents cannot run `pnpm install` (parallel installs corrupt the
 * shared node_modules — see the worktree gotcha memory). This ambient
 * declaration mirrors the documented v3 API surface Loom uses so `tsc` type-
 * checks before the package lands on disk.
 *
 * INTEGRATION STEP (orchestrator): run
 *   pnpm --filter fiab-console add @tanstack/react-virtual@^3.13.0
 * (updates pnpm-lock.yaml) and DELETE this file in the same commit — the
 * package ships its own complete types, and this shim would otherwise
 * conflict-augment them.
 */
declare module '@tanstack/react-virtual' {
  export interface VirtualItem {
    index: number;
    /** Offset (px) of the item's leading edge within the scroll content. */
    start: number;
    /** Offset (px) of the item's trailing edge. */
    end: number;
    /** Measured or estimated size (px). */
    size: number;
    key: string | number | bigint;
    lane: number;
  }

  export interface VirtualizerOptions<
    TScrollElement extends Element | Window,
    TItemElement extends Element,
  > {
    count: number;
    getScrollElement: () => TScrollElement | null;
    estimateSize: (index: number) => number;
    overscan?: number;
    horizontal?: boolean;
    paddingStart?: number;
    paddingEnd?: number;
    scrollPaddingStart?: number;
    scrollPaddingEnd?: number;
    gap?: number;
    lanes?: number;
    enabled?: boolean;
    getItemKey?: (index: number) => string | number | bigint;
    onChange?: (
      instance: Virtualizer<TScrollElement, TItemElement>,
      sync: boolean,
    ) => void;
    measureElement?: (
      element: TItemElement,
      entry: ResizeObserverEntry | undefined,
      instance: Virtualizer<TScrollElement, TItemElement>,
    ) => number;
    initialOffset?: number | (() => number);
    isScrollingResetDelay?: number;
    useScrollendEvent?: boolean;
    isRtl?: boolean;
  }

  export interface Virtualizer<
    TScrollElement extends Element | Window,
    TItemElement extends Element,
  > {
    options: Required<VirtualizerOptions<TScrollElement, TItemElement>>;
    scrollElement: TScrollElement | null;
    isScrolling: boolean;
    getVirtualItems: () => VirtualItem[];
    getVirtualIndexes: () => number[];
    getTotalSize: () => number;
    /** Ref-callback used to measure a rendered item's real size. */
    measureElement: (node: TItemElement | null | undefined) => void;
    measure: () => void;
    scrollToIndex: (
      index: number,
      options?: { align?: 'start' | 'center' | 'end' | 'auto'; behavior?: 'auto' | 'smooth' },
    ) => void;
    scrollToOffset: (
      offset: number,
      options?: { align?: 'start' | 'center' | 'end' | 'auto'; behavior?: 'auto' | 'smooth' },
    ) => void;
    scrollBy: (delta: number, options?: { behavior?: 'auto' | 'smooth' }) => void;
    resizeItem: (index: number, size: number) => void;
  }

  /**
   * React adapter — re-renders on scroll/measure with the windowed item set.
   * Signature per https://tanstack.com/virtual/latest/docs/api/virtualizer.
   */
  export function useVirtualizer<
    TScrollElement extends Element,
    TItemElement extends Element,
  >(
    options: VirtualizerOptions<TScrollElement, TItemElement>,
  ): Virtualizer<TScrollElement, TItemElement>;

  export function useWindowVirtualizer<TItemElement extends Element>(
    options: Omit<VirtualizerOptions<Window, TItemElement>, 'getScrollElement'>,
  ): Virtualizer<Window, TItemElement>;

  export function defaultRangeExtractor(range: {
    startIndex: number;
    endIndex: number;
    overscan: number;
    count: number;
  }): number[];
}
