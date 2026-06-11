'use client';

/**
 * /admin/tenant-settings — REAL editable tenant settings page wired to
 * /api/admin/tenant-settings. 15 categories, ~50 toggles, Cosmos-backed
 * persistence with per-toggle audit-log emission.
 *
 * Replaces the AdminGate stub. Save persists; reload confirms persistence.
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Spinner, Button, Switch, Caption1, Subtitle2, Body1, Input, Badge,
  MessageBar, MessageBarBody, MessageBarTitle, SpinButton, Field,
  Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  Tooltip, makeStyles, tokens,
} from '@fluentui/react-components';
import { Search24Regular, Save24Regular, ArrowReset24Regular, Open16Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { Section } from '@/lib/components/ui/section';
import { useAdminTabStyles } from '@/lib/components/ui/admin-tab-styles';
import { CopilotAgentsConfig } from '@/lib/components/admin/copilot-agents-config';
import { ToggleScopePicker } from '@/lib/components/admin/toggle-scope-picker';
import type { AppliesToConfig } from '@/lib/types/tenant-settings';

interface NumericParamDef {
  id: string;
  label: string;
  unit?: string;
  min: number;
  max: number;
  default: number;
}
interface ToggleDef {
  id: string;
  label: string;
  help: string;
  default: boolean;
  learnUrl?: string;
  scope?: 'tenant' | 'capacity' | 'domain';
  scopable?: boolean;
  numericParam?: NumericParamDef;
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
  numericBlock: {
    marginTop: tokens.spacingVerticalS,
    display: 'flex', flexDirection: 'column', gap: '2px', maxWidth: '260px',
  },
  filterInput: { width: '100%', maxWidth: '360px', minWidth: '200px' },
  changeNote: { marginTop: tokens.spacingVerticalXS, fontSize: tokens.fontSizeBase200 },
  metaLine: { display: 'block', color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalM },
  emptyMsg: { color: tokens.colorNeutralForeground3, padding: tokens.spacingVerticalXXL },
  toggleId: { color: tokens.colorNeutralForeground3, fontFamily: 'Consolas, monospace', fontSize: '11px' },
  spinWidth: { width: '140px' },
});

export default function TenantSettingsPage() {
  const s = useStyles();
  const a = useAdminTabStyles();
  const [groups, setGroups] = useState<ToggleGroup[] | null>(null);
  const [settings, setSettings] = useState<Record<string, boolean> | null>(null);
  const [original, setOriginal] = useState<Record<string, boolean> | null>(null);
  const [scopeConfig, setScopeConfig] = useState<Record<string, AppliesToConfig>>({});
  const [originalScope, setOriginalScope] = useState<Record<string, AppliesToConfig>>({});
  const [numericParams, setNumericParams] = useState<Record<string, number>>({});
  const [originalNumeric, setOriginalNumeric] = useState<Record<string, number>>({});
  const [groupNames, setGroupNames] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ updatedAt?: string; updatedBy?: string }>({});
  const [dpBackend, setDpBackend] = useState<{
    backend: 'cosmos' | 'unified-catalog';
    label: string;
    options: Array<{ id: string; label: string }>;
    details?: { boundary?: string; govFallThrough?: boolean; unconfiguredGate?: boolean };
  } | null>(null);
  const [q, setQ] = useState('');
  // Dirty ref so the Ctrl+S handler sees fresh state.
  const dirtyRef = useRef(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await clientFetch('/api/admin/tenant-settings');
      if (r.status === 401 || r.status === 403) { setLoadError('Sign-in required'); return; }
      const j = await r.json();
      if (!j.ok) { setLoadError(j.error || `HTTP ${r.status}`); return; }
      setGroups(j.groups);
      setSettings({ ...j.settings });
      setOriginal({ ...j.settings });
      setScopeConfig({ ...(j.scopeConfig ?? {}) });
      setOriginalScope({ ...(j.scopeConfig ?? {}) });
      setNumericParams({ ...(j.numericParams ?? {}) });
      setOriginalNumeric({ ...(j.numericParams ?? {}) });
      setMeta({ updatedAt: j.updatedAt, updatedBy: j.updatedBy });
      // Resolve display names for every stored scope group id (best-effort).
      const allIds = Object.values(j.scopeConfig ?? {} as Record<string, AppliesToConfig>)
        .flatMap((c) => (c as AppliesToConfig).groupIds ?? []);
      const uniqueIds = [...new Set(allIds.filter(Boolean))];
      if (uniqueIds.length > 0) {
        try {
          const gr = await clientFetch(`/api/admin/tenant-settings/groups?ids=${encodeURIComponent(uniqueIds.join(','))}`);
          const gj = await gr.json();
          if (gj.ok && Array.isArray(gj.groups)) {
            const map: Record<string, string> = {};
            for (const g of gj.groups) map[g.id] = g.displayName;
            setGroupNames(map);
          }
        } catch { /* group-name resolution is best-effort; chips fall back to OID */ }
      }
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Live data-product backend indicator (read-only; reflects deployment env).
  useEffect(() => {
    (async () => {
      try {
        const r = await clientFetch('/api/admin/data-products-backend');
        if (!r.ok) return;
        const j = await r.json();
        if (j.ok) setDpBackend({ backend: j.backend, label: j.label, options: j.options || [], details: j.details });
      } catch { /* indicator is best-effort */ }
    })();
  }, []);

  const sortedIds = (c?: AppliesToConfig) => (c ? [...c.groupIds].sort().join(',') : '');

  const dirty = useMemo(() => {
    if (!settings || !original) return false;
    for (const k of Object.keys(settings)) if (settings[k] !== original[k]) return true;
    const scopeKeys = new Set([...Object.keys(scopeConfig), ...Object.keys(originalScope)]);
    for (const k of scopeKeys) {
      const a = scopeConfig[k], b = originalScope[k];
      if ((a?.mode ?? 'entire-org') !== (b?.mode ?? 'entire-org')) return true;
      if (sortedIds(a) !== sortedIds(b)) return true;
    }
    for (const k of Object.keys(numericParams)) if (numericParams[k] !== originalNumeric[k]) return true;
    return false;
  }, [settings, original, scopeConfig, originalScope, numericParams, originalNumeric]);

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
      const r = await clientFetch('/api/admin/tenant-settings', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings, scopeConfig, numericParams }),
      });
      const j = await r.json();
      if (!j.ok) { setSaveError(j.error || `HTTP ${r.status}`); setStatusMsg(null); return; }
      setOriginal({ ...j.settings });
      setSettings({ ...j.settings });
      setScopeConfig({ ...(j.scopeConfig ?? {}) });
      setOriginalScope({ ...(j.scopeConfig ?? {}) });
      setNumericParams({ ...(j.numericParams ?? {}) });
      setOriginalNumeric({ ...(j.numericParams ?? {}) });
      setMeta({ updatedAt: j.updatedAt, updatedBy: meta.updatedBy });
      const total = (j.changedCount ?? 0) + (j.scopeChangedCount ?? 0) + (j.numericChangedCount ?? 0);
      setStatusMsg(`Saved ${total} change${total === 1 ? '' : 's'} at ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setSaveError(e?.message || String(e));
      setStatusMsg(null);
    } finally { setSaving(false); }
  }, [settings, saving, scopeConfig, numericParams, meta.updatedBy]);

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
    setScopeConfig({ ...originalScope });
    setNumericParams({ ...originalNumeric });
    setStatusMsg('Discarded unsaved changes.');
  }, [original, originalScope, originalNumeric]);

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
          className={s.filterInput}
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
        <MessageBar intent="error" className={a.messageBar}>
          <MessageBarBody>
            <MessageBarTitle>Save failed</MessageBarTitle>
            {saveError}
          </MessageBarBody>
        </MessageBar>
      )}

      {statusMsg && !saveError && (
        <MessageBar intent={statusMsg.startsWith('Saved') ? 'success' : 'info'} className={a.messageBar}>
          <MessageBarBody>
            {statusMsg}
            {changedList.length > 0 && dirty && (
              <div className={s.changeNote}>{changedList.join(' · ')}</div>
            )}
          </MessageBarBody>
        </MessageBar>
      )}

      {meta.updatedAt && (
        <Caption1 className={s.metaLine}>
          Last updated: {new Date(meta.updatedAt).toLocaleString()}{meta.updatedBy ? ` · by ${meta.updatedBy}` : ''}
        </Caption1>
      )}

      {/* Tenant-wide Copilot & Agents config (Foundry account + model deployments). */}
      <CopilotAgentsConfig />

      {/* Data-product store backend indicator (read-only; env-driven routing). */}
      {dpBackend && (
        <MessageBar intent={dpBackend.backend === 'unified-catalog' ? 'success' : 'info'} className={a.messageBar}>
          <MessageBarBody>
            <MessageBarTitle>Data product store backend</MessageBarTitle>
            Backend:{' '}
            {dpBackend.options.map((o, i) => (
              <span key={o.id}>
                {i > 0 && ' | '}
                {o.id === dpBackend.backend ? <strong>{o.label}</strong> : o.label}
              </span>
            ))}
            {dpBackend.details?.govFallThrough && (
              <div className={s.changeNote}>
                Purview Unified Catalog was requested but this is a{' '}
                <code>{dpBackend.details.boundary}</code> deployment — the Unified Catalog
                data plane is Commercial-only, so data products use Cosmos.
              </div>
            )}
            {dpBackend.details?.unconfiguredGate && (
              <div className={s.changeNote}>
                Purview Unified Catalog is selected but no account is wired — set{' '}
                <code>LOOM_PURVIEW_UNIFIED_ACCOUNT</code> (or <code>LOOM_PURVIEW_UC_ENDPOINT</code>)
                and grant the Console UAMI the Catalog Reader + Data Product Owner roles in the
                target governance domain. Until then the data-product surfaces show an honest gate.
              </div>
            )}
          </MessageBarBody>
        </MessageBar>
      )}

      {!groups && !loadError && <Spinner label="Loading settings…" />}

      {groups && visibleGroups.length === 0 && filter && (
        <Body1 className={s.emptyMsg}>
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
                    <Badge appearance="filled" color="warning" size="small" className={a.badgeGap}>
                      {groupChangedCount} unsaved
                    </Badge>
                  )}
                </AccordionHeader>
                <AccordionPanel>
                  {g.description && <Body1 className={s.groupDesc}>{g.description}</Body1>}
                  {g.toggles.map((t) => {
                    const v = settings?.[t.id] ?? t.default;
                    const changed = settings && original && settings[t.id] !== original[t.id];
                    const sc = scopeConfig[t.id] ?? { mode: 'entire-org', groupIds: [] };
                    const scopeChanged = t.scopable && (
                      (sc.mode !== (originalScope[t.id]?.mode ?? 'entire-org')) ||
                      (sortedIds(sc) !== sortedIds(originalScope[t.id]))
                    );
                    const numVal = t.numericParam ? (numericParams[t.numericParam.id] ?? t.numericParam.default) : 0;
                    const numChanged = t.numericParam && numericParams[t.numericParam.id] !== originalNumeric[t.numericParam.id];
                    return (
                      <div key={t.id} className={s.toggleRow}>
                        <div className={s.toggleLabel}>
                          <div className={s.toggleName}>
                            {t.label}
                            {changed && <Badge appearance="outline" color="warning" size="small" className={a.badgeGap}>changed</Badge>}
                            {(scopeChanged || numChanged) && !changed && <Badge appearance="outline" color="warning" size="small" className={a.badgeGap}>changed</Badge>}
                          </div>
                          <div className={s.toggleHelp}>
                            {t.help}
                            {t.learnUrl && (
                              <a className={s.learn} href={t.learnUrl} target="_blank" rel="noreferrer">
                                Learn more <Open16Regular />
                              </a>
                            )}
                          </div>
                          <Caption1 className={s.toggleId}>
                            {t.id}
                          </Caption1>
                          {t.scopable && v && (
                            <ToggleScopePicker
                              config={sc}
                              onChange={(next) => setScopeConfig((prev) => ({ ...prev, [t.id]: next }))}
                              disabled={saving}
                              resolvedGroupNames={groupNames}
                            />
                          )}
                          {t.numericParam && v && (
                            <div className={s.numericBlock}>
                              <Field label={`${t.numericParam.label}${t.numericParam.unit ? ` (${t.numericParam.unit})` : ''}`}>
                                <SpinButton
                                  value={numVal}
                                  min={t.numericParam.min}
                                  max={t.numericParam.max}
                                  disabled={saving}
                                  onChange={(_e, d) => {
                                    const np = t.numericParam!;
                                    const raw = d.value ?? (d.displayValue != null ? parseInt(d.displayValue, 10) : undefined);
                                    if (raw === undefined || Number.isNaN(raw)) return;
                                    const clamped = Math.max(np.min, Math.min(np.max, Math.round(Number(raw))));
                                    setNumericParams((prev) => ({ ...prev, [np.id]: clamped }));
                                  }}
                                  className={s.spinWidth}
                                />
                              </Field>
                            </div>
                          )}
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
