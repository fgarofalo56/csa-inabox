'use client';

/**
 * WorkspaceSwitcher — sticky topbar control showing the ACTIVE workspace and
 * letting the operator switch context (Fabric's workspace switcher). Backed by
 * the real ACL-aware list (GET /api/workspaces → owned + shared per rel-T11).
 * Picking a workspace sets the active context (persisted via useUi) and
 * navigates to it; "All workspaces" clears the scope. Recent picks are pinned
 * at the top so the common ones are one click away.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  MenuGroup, MenuGroupHeader, MenuDivider, Tooltip, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Building24Regular, ChevronDown16Regular, Checkmark16Regular,
  Grid24Regular, Add16Regular,
} from '@fluentui/react-icons';
import { listWorkspaces, type Workspace } from '@/lib/api/workspaces';
import { WorkspaceAvatar } from '@/lib/components/workspace-avatar';
import { useUi } from '@/lib/stores/ui';

const useStyles = makeStyles({
  // Matches the sibling topbar controls (white-on-dark, subtle hover).
  trigger: {
    color: 'white',
    minWidth: 0,
    maxWidth: '220px',
    justifyContent: 'flex-start',
    gap: 'var(--loom-space-1)',
    transition: 'background-color var(--loom-motion-fast) var(--loom-motion-ease)',
    ':hover': { backgroundColor: 'rgba(255,255,255,0.10)' },
    flexShrink: 0,
  },
  label: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '140px',
    fontWeight: tokens.fontWeightRegular,
  },
});

export function WorkspaceSwitcher() {
  const styles = useStyles();
  const router = useRouter();
  const { activeWorkspace, recentWorkspaces, setActiveWorkspace } = useUi();
  const [open, setOpen] = useState(false);
  // Full ACL-aware list, fetched lazily on first open. null = not loaded yet.
  const [all, setAll] = useState<Workspace[] | null>(null);

  useEffect(() => {
    if (!open || all !== null) return;
    let cancelled = false;
    listWorkspaces()
      .then((ws) => { if (!cancelled) setAll(ws); })
      .catch(() => { if (!cancelled) setAll([]); });
    return () => { cancelled = true; };
  }, [open, all]);

  function pick(w: { id: string; name: string }) {
    setActiveWorkspace({ id: w.id, name: w.name });
    setOpen(false);
    router.push(`/workspaces/${w.id}`);
  }
  function pickAll() {
    setActiveWorkspace(null);
    setOpen(false);
    router.push('/workspaces');
  }

  const activeId = activeWorkspace?.id;
  // Resolve the active workspace's image from the full list when it has loaded,
  // so the trigger shows the custom avatar (falls back to an initials chip).
  const activeImage = activeId ? (all ?? []).find((w) => w.id === activeId)?.image : undefined;
  const byId = new Map((all ?? []).map((w) => [w.id, w] as const));
  const recentIds = new Set(recentWorkspaces.map((w) => w.id));
  // "All" section excludes anything already shown under Recent to avoid dupes.
  const others = (all ?? []).filter((w) => !recentIds.has(w.id));

  return (
    <Menu open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <MenuTrigger disableButtonEnhancement>
        <Tooltip content="Switch workspace" relationship="label">
          <Button appearance="transparent" className={styles.trigger}
            icon={activeWorkspace
              ? <WorkspaceAvatar workspaceId={activeWorkspace.id} name={activeWorkspace.name} image={activeImage} size={20} />
              : <Building24Regular />}
            aria-label={`Workspace: ${activeWorkspace?.name ?? 'All workspaces'}. Switch workspace`}>
            <span className={styles.label}>{activeWorkspace?.name ?? 'All workspaces'}</span>
            <ChevronDown16Regular />
          </Button>
        </Tooltip>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem
            icon={!activeId ? <Checkmark16Regular /> : <Grid24Regular />}
            onClick={pickAll}
          >
            All workspaces
          </MenuItem>

          {recentWorkspaces.length > 0 && (
            <MenuGroup>
              <MenuGroupHeader>Recent</MenuGroupHeader>
              {recentWorkspaces.map((w) => (
                <MenuItem
                  key={w.id}
                  icon={activeId === w.id
                    ? <Checkmark16Regular />
                    : <WorkspaceAvatar workspaceId={w.id} name={w.name} image={byId.get(w.id)?.image} size={20} />}
                  onClick={() => pick(w)}
                >
                  {w.name}
                </MenuItem>
              ))}
            </MenuGroup>
          )}

          <MenuDivider />
          <MenuGroup>
            <MenuGroupHeader>All workspaces</MenuGroupHeader>
            {all === null && <MenuItem disabled>Loading…</MenuItem>}
            {all !== null && all.length === 0 && (
              <MenuItem icon={<Add16Regular />} onClick={pickAll}>
                No workspaces yet — create one
              </MenuItem>
            )}
            {others.map((w) => (
              <MenuItem
                key={w.id}
                icon={activeId === w.id ? <Checkmark16Regular /> : <Building24Regular />}
                onClick={() => pick(w)}
              >
                {w.name}
              </MenuItem>
            ))}
          </MenuGroup>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
