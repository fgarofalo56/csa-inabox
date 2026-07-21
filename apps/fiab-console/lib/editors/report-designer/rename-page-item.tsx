'use client';

// rename-page-item.tsx — inline rename control for page action menus.

import { useState } from 'react';
import { Button, Input, MenuItem, tokens } from '@fluentui/react-components';
import { Edit20Regular } from '@fluentui/react-icons';

export function RenamePageItem({ name, onRename }: { name: string; onRename: (n: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(name);
  if (!editing) {
    return <MenuItem icon={<Edit20Regular />} persistOnClick onClick={(e) => { e?.preventDefault?.(); setVal(name); setEditing(true); }}>Rename page</MenuItem>;
  }
  return (
    <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, padding: tokens.spacingVerticalXS }}>
      <Input size="small" value={val} autoFocus onClick={(e) => e.stopPropagation()}
        onChange={(_e, d) => setVal(d.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { onRename(val.trim() || name); setEditing(false); } }} />
      <Button size="small" appearance="primary" onClick={() => { onRename(val.trim() || name); setEditing(false); }}>OK</Button>
    </div>
  );
}
