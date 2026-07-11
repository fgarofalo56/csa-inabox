'use client';

/**
 * ResourcesPane — the Loom notebook "Resources" folder + in-notebook file
 * editor (R4-NB-3 / Fabric notebook E5). A Unix-like set of small text files
 * (CSV / TXT / PY / SQL / YML / HTML / JSON …) bundled WITH the notebook. Loom-
 * native: the files persist in the notebook definition (Cosmos), so they travel
 * with the notebook and need no Fabric/OneLake or AML file share.
 *
 * Fabric's resources pane is a Unix-like folder scoped to one notebook, with a
 * built-in editor for text files ≤1 MB and a manual save. This mirrors that:
 * new file / rename / delete / edit (Monaco keyword highlighting per extension)
 * / manual Save. Files are readable from a cell via a normal relative path once
 * the notebook syncs them to the session working dir on run.
 *
 * Learn: https://learn.microsoft.com/fabric/data-engineering/how-to-use-notebook#notebook-resources
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Button, Input, Caption1, Subtitle2, Text, Badge, Tooltip,
  MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Dismiss20Regular, DocumentAdd20Regular, Delete16Regular, Save16Regular,
  Document16Regular, FolderOpen20Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea, type MonacoLanguage } from '@/lib/components/editor/monaco-textarea';
import { EmptyState } from '@/lib/components/empty-state';
import type { NotebookResourceFile } from '@/lib/types/notebook-cell';

const MAX_FILE_BYTES = 1_000_000; // 1 MB per file, matching Fabric's editor cap.

/** Monaco language for a resource file, by extension. */
function langForPath(path: string): MonacoLanguage {
  const ext = (path.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'py': return 'python';
    case 'sql': return 'sql';
    case 'r': return 'r';
    case 'scala': return 'scala';
    case 'yml': case 'yaml': return 'yaml';
    case 'json': return 'json';
    case 'html': case 'htm': return 'xml'; // HTML highlights well under the XML grammar
    case 'md': return 'markdown';
    default: return 'plaintext'; // csv / txt / anything else
  }
}

const useStyles = makeStyles({
  layout: { display: 'flex', gap: tokens.spacingHorizontalM, height: '100%', minHeight: 0 },
  list: {
    width: '220px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`, paddingRight: tokens.spacingHorizontalS, overflowY: 'auto',
  },
  fileRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusMedium, cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  fileRowActive: { backgroundColor: tokens.colorBrandBackground2 },
  fileName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  editorCol: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  editorHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  spacer: { flex: 1 },
  newRow: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'flex-end' },
});

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resources: NotebookResourceFile[];
  /** Update local resources (in-memory). */
  onChange: (next: NotebookResourceFile[]) => void;
  /** Persist the resource set to Cosmos (manual Save). */
  onPersist: (next: NotebookResourceFile[]) => Promise<void> | void;
  /** Honest gate: no notebook is open yet (files persist per-notebook). */
  notebookOpen: boolean;
}

export function ResourcesPane({ open, onOpenChange, resources, onChange, onPersist, notebookOpen }: Props) {
  const s = useStyles();
  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [draft, setDraft] = useState<string>('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const current = useMemo(
    () => resources.find((f) => f.path === selected) || null,
    [resources, selected],
  );

  // Seed the editor draft when the selected file changes.
  useEffect(() => {
    setDraft(current?.content ?? '');
    setDirty(false);
  }, [current?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select the first file when the pane opens with files present.
  useEffect(() => {
    if (open && !selected && resources.length) setSelected(resources[0].path);
  }, [open, selected, resources]);

  const addFile = () => {
    const name = newName.trim();
    if (!name) return;
    if (resources.some((f) => f.path === name)) { setErr(`A file named "${name}" already exists.`); return; }
    setErr(null);
    const next: NotebookResourceFile[] = [
      ...resources,
      { path: name, content: '', updatedAt: new Date().toISOString() },
    ];
    onChange(next);
    setSelected(name);
    setNewName('');
  };

  const deleteFile = (path: string) => {
    const next = resources.filter((f) => f.path !== path);
    onChange(next);
    if (selected === path) setSelected(next[0]?.path ?? null);
    void onPersist(next);
  };

  const saveCurrent = async () => {
    if (!current) return;
    const bytes = new TextEncoder().encode(draft).length;
    if (bytes > MAX_FILE_BYTES) {
      setErr(`File is ${(bytes / 1e6).toFixed(2)} MB — the limit is 1 MB per resource file.`);
      return;
    }
    setErr(null); setSaving(true);
    const next = resources.map((f) =>
      f.path === current.path ? { ...f, content: draft, updatedAt: new Date().toISOString() } : f,
    );
    onChange(next);
    try { await onPersist(next); setDirty(false); }
    catch (e: any) { setErr(e?.message || String(e)); }
    finally { setSaving(false); }
  };

  return (
    <Drawer type="overlay" position="end" open={open} onOpenChange={(_, d) => onOpenChange(d.open)} size="large">
      <DrawerHeader>
        <DrawerHeaderTitle
          action={<Button appearance="subtle" icon={<Dismiss20Regular />} aria-label="Close" onClick={() => onOpenChange(false)} />}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
            <FolderOpen20Regular /> Resources
          </span>
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        {!notebookOpen ? (
          <MessageBar intent="info">
            <MessageBarBody>
              Open or create a notebook first — resource files are stored with the notebook.
            </MessageBarBody>
          </MessageBar>
        ) : (
          <div className={s.layout}>
            <div className={s.list}>
              <div className={s.newRow}>
                <Input
                  size="small" placeholder="utils.py" value={newName} aria-label="New file name"
                  onChange={(_, d) => setNewName(d.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addFile(); }}
                />
                <Tooltip content="New file" relationship="label">
                  <Button size="small" icon={<DocumentAdd20Regular />} onClick={addFile} disabled={!newName.trim()} />
                </Tooltip>
              </div>
              {err && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{err}</Caption1>}
              {resources.length === 0 ? (
                <EmptyState
                  icon={<Document16Regular />}
                  title="No resource files"
                  body="Add a small text file (.py, .sql, .csv, .yml…) that ships with this notebook and is readable from a cell by its relative path."
                />
              ) : resources.map((f) => (
                <div
                  key={f.path}
                  className={`${s.fileRow} ${selected === f.path ? s.fileRowActive : ''}`}
                  onClick={() => setSelected(f.path)}
                >
                  <Document16Regular />
                  <Caption1 className={s.fileName} title={f.path}>{f.path}</Caption1>
                  <Tooltip content="Delete" relationship="label">
                    <Button
                      size="small" appearance="transparent" icon={<Delete16Regular />} aria-label={`Delete ${f.path}`}
                      onClick={(e) => { e.stopPropagation(); deleteFile(f.path); }}
                    />
                  </Tooltip>
                </div>
              ))}
            </div>
            <div className={s.editorCol}>
              {current ? (
                <>
                  <div className={s.editorHead}>
                    <Subtitle2>{current.path}</Subtitle2>
                    <Badge appearance="tint" color="informative" size="small">{langForPath(current.path)}</Badge>
                    <div className={s.spacer} />
                    {dirty && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Unsaved</Caption1>}
                    <Button
                      size="small" appearance="primary" icon={<Save16Regular />}
                      onClick={saveCurrent} disabled={!dirty || saving}
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </Button>
                  </div>
                  <MonacoTextarea
                    value={draft}
                    onChange={(v) => { setDraft(v); setDirty(true); }}
                    language={langForPath(current.path)}
                    height={420}
                    ariaLabel={`Edit ${current.path}`}
                  />
                  <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                    Persisted with the notebook · 1 MB max · read from a cell by relative path once synced on run.
                  </Text>
                </>
              ) : (
                <EmptyState
                  icon={<Document16Regular />}
                  title="Select a file"
                  body="Pick a resource file to edit, or create one with the field on the left."
                />
              )}
            </div>
          </div>
        )}
      </DrawerBody>
    </Drawer>
  );
}
