'use client';

/**
 * SC-9 — <CommandSearch> (the ribbon/title-bar command search box).
 *
 * A visible, in-ribbon search box — Fabric's "Search (Alt+Q)" / ADF's Ctrl+Q —
 * that surfaces EVERY action a surface registers in the shared
 * `canvas-command-registry`. Results render Combobox-style: grouped by the
 * command's `group` (e.g. its ribbon tab), each row a Fluent glyph + label +
 * one-line hint. Selecting a row RUNS the action (the same handler the ribbon
 * button fires). Ctrl+Q (ADF) and Alt+Q (Fabric) both focus the box and open
 * the dropdown from anywhere on the surface.
 *
 * This is intentionally decoupled from any specific editor: it reads the global
 * registry, so ANY surface that registers its actions (see `ribbon-commands.ts`
 * `useRegisterRibbonCommands`, or a canvas host's `registerCanvasCommands`) gets
 * a working command search with zero per-surface UI code — just the box.
 *
 * Fluent v9 + Loom tokens only; theme-aware (light + dark) via `tokens.*`. No
 * raw px/hex. The registry is a pure singleton so this file has no coupling to
 * the editor registry (no circular dep).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Input, Caption1, Body1, makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import { Search20Regular } from '@fluentui/react-icons';
import {
  getCanvasCommands, subscribeCanvasCommands, type CanvasCommand,
} from '@/lib/components/canvas/canvas-command-registry';

const DEFAULT_GROUP = 'Actions';

const useStyles = makeStyles({
  // Anchor for the absolutely-positioned results dropdown.
  root: {
    position: 'relative',
    flexShrink: 0,
    minWidth: '180px',
    maxWidth: '280px',
    width: '100%',
  },
  input: { width: '100%' },
  // Results dropdown — floats over the ribbon body.
  panel: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    left: 0,
    right: 0,
    zIndex: 1000,
    maxHeight: '52vh',
    overflowY: 'auto',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow16,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
  },
  groupLabel: {
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    cursor: 'pointer',
    borderLeft: `3px solid transparent`,
  },
  itemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    borderLeftColor: tokens.colorBrandStroke1,
  },
  itemIcon: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: tokens.colorNeutralForeground2,
    width: '20px',
    height: '20px',
  },
  itemText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  itemLabel: {
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  itemSub: {
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  empty: {
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    color: tokens.colorNeutralForeground3,
  },
});

export interface CommandSearchProps {
  /** Placeholder text. Defaults to the Fabric-style "Search actions (Ctrl+Q)". */
  placeholder?: string;
  /** aria-label for the input. */
  ariaLabel?: string;
}

/**
 * Ribbon command-search box. Reads every registered surface command from the
 * shared registry, filters as you type, and runs the selected action.
 */
export function CommandSearch({ placeholder, ariaLabel }: CommandSearchProps) {
  const s = useStyles();
  const [commands, setCommands] = useState<CanvasCommand[]>([]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Mirror the registry into local state; re-render whenever a surface
  // registers/deregisters its actions (registry excludes disabled commands).
  useEffect(() => {
    const sync = () => setCommands(getCanvasCommands());
    sync();
    return subscribeCanvasCommands(sync);
  }, []);

  // Filtered, flattened, grouped view of the current registry.
  const { flat, groups } = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matched = needle
      ? commands.filter(
          (c) =>
            c.label.toLowerCase().includes(needle) ||
            c.sub.toLowerCase().includes(needle) ||
            (c.group ?? '').toLowerCase().includes(needle),
        )
      : commands;
    // Stable group ordering by first appearance.
    const order: string[] = [];
    const byGroup = new Map<string, CanvasCommand[]>();
    for (const c of matched) {
      const g = c.group ?? DEFAULT_GROUP;
      if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g); }
      byGroup.get(g)!.push(c);
    }
    const flatList: CanvasCommand[] = [];
    const groupList = order.map((g) => {
      const items = byGroup.get(g)!;
      flatList.push(...items);
      return { group: g, items };
    });
    return { flat: flatList, groups: groupList };
  }, [commands, q]);

  // Keep the highlighted row in range as the filtered set changes.
  useEffect(() => { setCursor((c) => Math.min(c, Math.max(0, flat.length - 1))); }, [flat.length]);

  const run = useCallback((c: CanvasCommand | undefined) => {
    if (!c) return;
    setOpen(false);
    setQ('');
    // Defer so the dropdown unmounts before the action (which may itself open a
    // dialog / move focus) fires.
    setTimeout(() => { try { c.run(); } catch { /* host handles its own errors */ } }, 0);
  }, []);

  // Ctrl+Q (ADF) / Alt+Q (Fabric) focus + open the box from anywhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.altKey) && !e.shiftKey && !e.metaKey && e.key.toLowerCase() === 'q') {
        e.preventDefault();
        setOpen(true);
        setCursor(0);
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Close on outside pointer-down (the dropdown floats over the ribbon body).
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { setOpen(true); setCursor((c) => Math.min(flat.length - 1, c + 1)); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { setCursor((c) => Math.max(0, c - 1)); e.preventDefault(); }
    else if (e.key === 'Enter') { run(flat[cursor]); e.preventDefault(); }
    else if (e.key === 'Escape') { setOpen(false); }
  }

  // Flat index counter so per-group rendering shares one highlight cursor.
  let flatIndex = 0;

  return (
    <div className={s.root} ref={rootRef}>
      <Input
        ref={inputRef}
        className={s.input}
        size="small"
        contentBefore={<Search20Regular />}
        placeholder={placeholder ?? 'Search actions (Ctrl+Q)'}
        value={q}
        onChange={(_, d) => { setQ(d.value); setOpen(true); setCursor(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onInputKey}
        input={{
          role: 'combobox',
          'aria-label': ariaLabel ?? 'Search surface actions',
          'aria-expanded': open,
          'aria-controls': 'command-search-listbox',
          'aria-autocomplete': 'list',
        }}
      />
      {open && (
        <div className={s.panel} id="command-search-listbox" role="listbox" aria-label="Surface actions">
          {flat.length === 0 ? (
            <div className={s.empty}>
              <Caption1>
                {commands.length === 0
                  ? 'No actions registered for this surface yet.'
                  : 'No matching actions.'}
              </Caption1>
            </div>
          ) : (
            groups.map((grp) => (
              <div key={grp.group}>
                <div className={s.groupLabel}>{grp.group}</div>
                {grp.items.map((c) => {
                  const me = flatIndex++;
                  return (
                    <div
                      key={c.id}
                      className={mergeClasses(s.item, me === cursor && s.itemActive)}
                      role="option"
                      aria-selected={me === cursor}
                      // preventDefault keeps input focus so click-to-run works.
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setCursor(me)}
                      onClick={() => run(c)}
                    >
                      {c.icon != null && <span className={s.itemIcon} aria-hidden="true">{c.icon}</span>}
                      <span className={s.itemText}>
                        <Body1 className={s.itemLabel}>{c.label}</Body1>
                        {c.sub && <Caption1 className={s.itemSub}>{c.sub}</Caption1>}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default CommandSearch;
