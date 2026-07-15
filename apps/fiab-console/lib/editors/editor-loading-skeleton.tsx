'use client';

/**
 * PSR-9 — shared loading skeleton for the route-level code-split editors.
 *
 * Every entry in the editor registry is `next/dynamic(..., { ssr: false })`, so
 * a heavy editor's JS chunk (Monaco, the React-Flow canvas, the report designer)
 * downloads AFTER the route shell paints. Without a `loading:` fallback the pane
 * is blank for that window; this skeleton fills it — a ribbon strip + a left
 * rail + a content block — so the surface reads as "loading this editor", not
 * "broken". Fluent v9 + Loom tokens only (web3-ui.md); no data, no backend.
 */

import { Skeleton, SkeletonItem, makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL,
    height: '100%',
    minHeight: 0,
  },
  ribbon: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center' },
  ribbonBtn: { width: '96px', height: '32px', borderRadius: tokens.borderRadiusMedium },
  body: { display: 'flex', gap: tokens.spacingHorizontalL, flex: 1, minHeight: 0 },
  rail: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, width: '220px' },
  railItem: { height: '20px', borderRadius: tokens.borderRadiusSmall },
  main: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, flex: 1, minWidth: 0 },
  block: { height: '160px', borderRadius: tokens.borderRadiusLarge },
  line: { height: '16px', borderRadius: tokens.borderRadiusSmall },
});

export function EditorLoadingSkeleton() {
  const s = useStyles();
  return (
    <div className={s.root} role="status" aria-label="Loading editor">
      <Skeleton aria-label="Loading editor" animation="pulse">
        <div className={s.ribbon}>
          <SkeletonItem className={s.ribbonBtn} />
          <SkeletonItem className={s.ribbonBtn} />
          <SkeletonItem className={s.ribbonBtn} />
        </div>
        <div className={s.body}>
          <div className={s.rail}>
            {Array.from({ length: 6 }).map((_, i) => <SkeletonItem key={i} className={s.railItem} />)}
          </div>
          <div className={s.main}>
            <SkeletonItem className={s.block} />
            <SkeletonItem className={s.line} style={{ width: '80%' }} />
            <SkeletonItem className={s.line} style={{ width: '60%' }} />
            <SkeletonItem className={s.line} style={{ width: '70%' }} />
          </div>
        </div>
      </Skeleton>
    </div>
  );
}

export default EditorLoadingSkeleton;
