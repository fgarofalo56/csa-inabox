'use client';

/**
 * Capability tree — Fabric-style domain → workload → capability picker.
 * Click a capability row to load its grants and reveal the Add/Remove
 * controls in the detail pane.
 */
import { useMemo, useState } from 'react';
import {
  TreeItem, TreeItemLayout, Tree, Badge, Body1Strong, Caption1,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ShieldKeyhole20Regular, AppGeneric20Regular, ChevronRight16Regular } from '@fluentui/react-icons';
import type { Capability } from '@/lib/auth/feature-catalog';

const useStyles = makeStyles({
  shell: { borderRight: `1px solid ${tokens.colorNeutralStroke2}`, overflowY: 'auto', minWidth: '260px', maxWidth: '360px' },
  domain: { fontSize: tokens.fontSizeBase200, color: tokens.colorBrandForeground1, fontWeight: 600, padding: '8px 12px 2px' },
});

export interface CapabilityTreeProps {
  groups: Array<{ domain: string; workloads: Array<{ name: string; capabilities: Capability[] }> }>;
  /** Map of capabilityId → grant count for the badge. */
  grantCounts: Record<string, number>;
  selected?: string;
  onSelect: (c: Capability) => void;
}

export function CapabilityTree({ groups, grantCounts, selected, onSelect }: CapabilityTreeProps) {
  const styles = useStyles();
  return (
    <div className={styles.shell} role="navigation" aria-label="Capability tree">
      {groups.map((g) => (
        <div key={g.domain}>
          <div className={styles.domain}>{g.domain}</div>
          <Tree aria-label={g.domain}>
            {g.workloads.map((w) => (
              <TreeItem key={`${g.domain}/${w.name}`} itemType="branch">
                <TreeItemLayout iconBefore={<ShieldKeyhole20Regular />}>
                  {w.name}
                </TreeItemLayout>
                <Tree>
                  {w.capabilities.map((c) => (
                    <TreeItem
                      key={c.id}
                      itemType="leaf"
                      onClick={() => onSelect(c)}
                      aria-current={selected === c.id ? 'true' : undefined}
                      style={selected === c.id ? { background: tokens.colorBrandBackground2 } : undefined}
                    >
                      <TreeItemLayout
                        iconBefore={<AppGeneric20Regular />}
                        aside={grantCounts[c.id] ? <Badge appearance="filled" size="small">{grantCounts[c.id]}</Badge> : undefined}
                      >
                        {c.name}
                      </TreeItemLayout>
                    </TreeItem>
                  ))}
                </Tree>
              </TreeItem>
            ))}
          </Tree>
        </div>
      ))}
    </div>
  );
}
