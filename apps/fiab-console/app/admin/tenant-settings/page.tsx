'use client';

/**
 * /admin/tenant-settings — REAL editable tenant settings page wired to
 * /api/admin/tenant-settings. 15 categories, ~50 toggles, Cosmos-backed
 * persistence with per-toggle audit-log emission.
 *
 * Replaces the AdminGate stub. Save persists; reload confirms persistence.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Spinner, Button, Switch, Caption1, Subtitle2, Body1, Input, Badge,
  MessageBar, MessageBarBody, MessageBarTitle,
  Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  Tooltip, makeStyles, tokens,
} from '@fluentui/react-components';
import { Search24Regular, Save24Regular, ArrowReset24Regular, Open16Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { Section } from '@/lib/components/ui/section';
import { CopilotAgentsConfig } from '@/lib/components/admin/copilot-agents-config';

interface ToggleDef {
  id: string;
  label: string;
  help: string;
  default: boolean;
  learnUrl?: string;
  scope?: 'tenant' | 'capacity' | 'domain';
}
interface ToggleGroup {
  id: string;
  label: string;
  description?: string;
  toggles: ToggleDef[];
}

const useStyles = makeStyles({
  toolbar: {
    display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center',
    paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM,
    marginBottom: tokens.spacingVerticalL,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    position: 'sticky', top: 0, zIndex: 10,
    backgroundColor: tokens.colorNeutralBackground1,
    flexWrap: 'wrap',
  },
  spacer: { flex: 1 },
  toggleRow: {
    display: 'grid', gridTemplateColumns: '1fr auto', gap: tokens.spacingHorizontalXL,
    paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS,
    borderTop: `1px solid ${tokens.colorNeutralStroke3}`,
    alignItems: 'center',
  },
  toggleLabel: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
  toggleName: { fontSize: '14px', fontWeight: 500 },
  toggleHelp: { fontSize: '12px', color: tokens.colorNeutralForeground3, lineHeight: 1.45 },
  groupDesc: { color: tokens.colorNeutralForeground3, fontSize: '13px', marginBottom: tokens.spacingVerticalS, display: 'block' },
  groupCount: { color: tokens.colorNeutralForeground3, fontSize: '12px', marginLeft: '8px' },
  diff: { color: tokens.colorPaletteYellowForeground2, fontSize: '12px' },
  learn: { display: 'inline-flex', alignItems: 'center', gap: '4px', marginLeft: '6px' },
});

export default function TenantSettingsPage() {
  const s = useStyles();
  const [groups, setGroups] = useState<ToggleGroup[] | null>(null);
  const [settings, setSettings] = useState<Record<string, boolean> | null>(null);
  const [original, setOriginal] = useState<Record<string, boolean> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ updatedAt?: string; updatedBy?: string }>({});
  const [q, setQ] = useState('');
  // Dirty ref so the Ctrl+S handler sees fresh state.
  const dirtyRef = useRef(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await fetch('/api/admin/tenant-settings');
      if (r.status === 401 || r.status === 403) { setLoadError('Sign-in required'); return; }
      const j = await r.json();
      if (!j.ok) { setLoadError(j.error || `HTTP ${r.status}`); return; }
      setGroups(j.groups);
      setSettings({ ...j.settings });
      setOriginal({ ...j.settings });
      setMeta({ updatedAt: j.updatedAt, updatedBy: j.updatedBy });
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const dirty = useMemo(() => {
    if (!settings || !original) return false;
    for (const k of Object.keys(settings)) if (settings[k] !== original[k]) return true;
    return false;
  }, [settings, original]);

  dirtyRef.current = dirty;

  const changedCount = useMemo(() => {
    if (!settings || !original) return 0;
    let n = 0;
    for (const k of Object.keys(settings)) if (settings[k] !== original[k]) n++;
    return n;
  }, [settings, original]);

  const save = useCallback(async () => {
    if (!settings || saving || !dirtyRef.current) return;
    setSaving(true); setSaveError(null); setStatusMsg('Saving…');
    try {
      const r = await fetch('/api/admin/tenant-settings', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings }),
      });
      const j = await r.json();
      if (!j.ok) { setSaveError(j.error || `HTTP ${r.status}`); setStatusMsg(null); return; }
      setOriginal({ ...j.settings });
      setSettings({ ...j.settings });
      setMeta({ updatedAt: j.updatedAt, updatedBy: meta.updatedBy });
      setStatusMsg(`Saved ${j.changedCount} setting${j.changedCount === 1 ? '' : 's'} at ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setSaveError(e?.message || String(e));
      setStatusMsg(null);
    } finally { setSaving(false); }
  }, [settings, saving, meta.updatedBy]);

  // Ctrl+S / Cmd+S shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirtyRef.current && !saving) void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, saving]);

  const discard = useCallback(() => {
    if (!original) return;
    setSettings({ ...original });
    setStatusMsg('Discarded unsaved changes.');
  }, [original]);

  function flip(id: string, v: boolean) {
    setSettings((prev) => prev ? { ...prev, [id]: v } : prev);
  }

  // Filter
  const filter = q.toLowerCase().trim();
  const visibleGroups = useMemo(() => {
    if (!groups) return [];
    if (!filter) return groups;
    return groups
      .map((g) => ({
        ...g,
        toggles: g.toggles.filter((t) =>
          t.label.toLowerCase().includes(filter) ||
          t.help.toLowerCase().includes(filter) ||
          t.id.toLowerCase().includes(filter) ||
          g.label.toLowerCase().includes(filter)
        ),
      }))
      .filter((g) => g.toggles.length > 0);
  }, [groups, filter]);

  // Build a list of changed toggle labels for the save status bar.
  const changedList = useMemo(() => {
    if (!groups || !settings || !original) return [];
    const out: string[] = [];
    for (const g of groups) {
      for (const t of g.toggles) {
        if (settings[t.id] !== original[t.id]) out.push(t.label);
      }
    }
    return out;
  }, [groups, settings, original]);

  return (
    <AdminShell sectionTitle="Tenant settings">
      <div className={s.toolbar}>
        <Input
          contentBefore={<Search24Regular />}
          placeholder="Filter settings by name, key, or description…"
          value={q}
          onChange={(_, d) => setQ(d.value)}
          style={{ width: '100%', maxWidth: 360, minWidth: 200 }}
        />
        <div className={s.spacer} />
        {dirty && (
          <Caption1 className={s.diff}>
            {changedCount} unsaved change{changedCount === 1 ? '' : 's'}
          </Caption1>
        )}
        <Button icon={<ArrowReset24Regular />} disabled={!dirty || saving} onClick={discard}>
          Discard
        </Button>
        <Button
          appearance="primary"
          icon={<Save24Regular />}
          disabled={!dirty || saving}
          onClick={save}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>

      {loadError && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load tenant settings</MessageBarTitle>
            {loadError}
          </MessageBarBody>
        </MessageBar>
      )}

      {saveError && (
        <MessageBar intent="error" style={{ marginBottom: 12 }}>
          <MessageBarBody>
            <MessageBarTitle>Save failed</MessageBarTitle>
            {saveError}
          </MessageBarBody>
        </MessageBar>
      )}

      {statusMsg && !saveError && (
        <MessageBar intent={statusMsg.startsWith('Saved') ? 'success' : 'info'} style={{ marginBottom: 12 }}>
          <MessageBarBody>
            {statusMsg}
            {changedList.length > 0 && dirty && (
              <div style={{ marginTop: 4, fontSize: 12 }}>{changedList.join(' · ')}</div>
            )}
          </MessageBarBody>
        </MessageBar>
      )}

      {meta.updatedAt && (
        <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
          Last updated: {new Date(meta.updatedAt).toLocaleString()}{meta.updatedBy ? ` · by ${meta.updatedBy}` : ''}
        </Caption1>
      )}

      {/* Tenant-wide Copilot & Agents config (Foundry account + model deployments). */}
      <CopilotAgentsConfig />

      {!groups && !loadError && <Spinner label="Loading settings…" />}

      {groups && visibleGroups.length === 0 && filter && (
        <Body1 style={{ color: tokens.colorNeutralForeground3, padding: 24 }}>
          No settings match &ldquo;{q}&rdquo;.
        </Body1>
      )}

      {visibleGroups.length > 0 && (
        <Section title="Settings">
        <Accordion multiple collapsible defaultOpenItems={visibleGroups.map((g) => g.id)}>
          {visibleGroups.map((g) => {
            const groupChangedCount = g.toggles.filter(
              (t) => settings && original && settings[t.id] !== original[t.id]
            ).length;
            return (
              <AccordionItem key={g.id} value={g.id}>
                <AccordionHeader>
                  <Subtitle2>{g.label}</Subtitle2>
                  <Caption1 className={s.groupCount}>{g.toggles.length} setting{g.toggles.length === 1 ? '' : 's'}</Caption1>
                  {groupChangedCount > 0 && (
                    <Badge appearance="filled" color="warning" size="small" style={{ marginLeft: 8 }}>
                      {groupChangedCount} unsaved
                    </Badge>
                  )}
                </AccordionHeader>
                <AccordionPanel>
                  {g.description && <Body1 className={s.groupDesc}>{g.description}</Body1>}
                  {g.toggles.map((t) => {
                    const v = settings?.[t.id] ?? t.default;
                    const changed = settings && original && settings[t.id] !== original[t.id];
                    return (
                      <div key={t.id} className={s.toggleRow}>
                        <div className={s.toggleLabel}>
                          <div className={s.toggleName}>
                            {t.label}
                            {changed && <Badge appearance="outline" color="warning" size="small" style={{ marginLeft: 8 }}>changed</Badge>}
                          </div>
                          <div className={s.toggleHelp}>
                            {t.help}
                            {t.learnUrl && (
                              <a className={s.learn} href={t.learnUrl} target="_blank" rel="noreferrer">
                                Learn more <Open16Regular />
                              </a>
                            )}
                          </div>
                          <Caption1 style={{ color: tokens.colorNeutralForeground3, fontFamily: 'Consolas, monospace', fontSize: 11 }}>
                            {t.id}
                          </Caption1>
                        </div>
                        <Tooltip content={v ? 'Click to disable' : 'Click to enable'} relationship="label">
                          <Switch
                            checked={v}
                            onChange={(_, d) => flip(t.id, !!d.checked)}
                            disabled={saving}
                          />
                        </Tooltip>
                      </div>
                    );
                  })}
                </AccordionPanel>
              </AccordionItem>
            );
          })}
        </Accordion>
        </Section>
      )}
    </AdminShell>
  );
}
