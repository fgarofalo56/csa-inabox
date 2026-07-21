'use client';

// pane-section.tsx — PaneSection collapsible header component.

import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Text, Divider } from '@fluentui/react-components';
import { ChevronDown16Regular, ChevronRight16Regular } from '@fluentui/react-icons';
import type { Styles } from './styles';

export function PaneSection({ styles, icon, label, defaultOpen = true, children }: {
  styles: Styles; icon?: ReactElement; label: string; defaultOpen?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={styles.section}>
      <button type="button" className={styles.paneSectionHead} aria-expanded={open}
        onClick={() => setOpen((o) => !o)}>
        <span className={styles.paneSectionChevron} aria-hidden>
          {open ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
        </span>
        {icon && <span className={styles.paneSectionIcon} aria-hidden>{icon}</span>}
        <Text className={styles.paneSectionLabel}>{label}</Text>
      </button>
      <Divider />
      {open && <div className={styles.paneSectionBody}>{children}</div>}
    </div>
  );
}
