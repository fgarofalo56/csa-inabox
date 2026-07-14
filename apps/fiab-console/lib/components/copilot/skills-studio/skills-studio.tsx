'use client';

/**
 * SkillsStudio — the CTS-07 Copilot skills library surface.
 *
 * A Web-3.0 catalog grid of every skill the Copilot can load (seeded MS +
 * Power BI built-ins ∪ tenant custom skills), each on a Loom-token card with:
 *   • a Fluent Switch wired to PATCH /api/copilot/skills/:id/state — the
 *     per-user toggle-over-tenant-default (default-ON, opt-out);
 *   • Built-in / Custom + pane + opt-in-MCP badges;
 *   • Edit / Duplicate / Delete for custom skills (built-ins are toggle-only,
 *     with a Duplicate affordance to fork an editable copy).
 *
 * "New skill" opens a FORM-based builder dialog (Field/Input/Textarea/Dropdown +
 * comma tag inputs — NO raw JSON config, per loom_no_freeform_config). A Sandbox
 * input resolves which skills are ACTIVE for the caller on a given pane slug via
 * the same GET route (?pane=), so the toggle policy is observable.
 *
 * Fluent v9 + Loom design tokens throughout (no raw px/hex); EmptyState for the
 * (rare) empty catalog. Real backend per no-vaporware.md — every card + switch
 * reflects live Cosmos state through clientFetch.
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Field, Input, Textarea, Dropdown, Option, Switch, Badge, Spinner, Text, Body1, Caption1,
  Title3, Subtitle2, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Edit20Regular, Delete20Regular, Copy20Regular,
  Sparkle24Regular, Wrench20Regular, Search20Regular, BrainCircuit24Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';

// ── Data shapes (mirror the BFF /api/copilot/skills routes) ──────────────────
interface Skill {
  id: string;
  name: string;
  whenToUse: string;
  guidance: string;
  toolNames: string[];
  panes: string[];
  mcpToolPrefix?: string;
  category?: string;
  tags?: string[];
  isBuiltin: boolean;
  enabled: boolean;
  effectiveEnabled: boolean;
  userOverride: boolean | null;
  attribution?: string;
}

interface SkillFormState {
  name: string;
  whenToUse: string;
  guidance: string;
  panes: string;      // comma-separated
  toolNames: string;  // comma-separated
  mcpToolPrefix: string;
  category: string;
}

const EMPTY_FORM: SkillFormState = {
  name: '', whenToUse: '', guidance: '', panes: '', toolNames: '', mcpToolPrefix: '', category: 'Custom',
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  header: { display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalL, flexWrap: 'wrap' },
  headerIcon: {
    flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '48px', height: '48px', borderRadius: tokens.borderRadiusLarge,
    color: tokens.colorNeutralForegroundOnBrand,
    backgroundImage: `linear-gradient(135deg, ${tokens.colorBrandBackground2}, ${tokens.colorBrandBackground})`,
  },
  headerText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, flex: 1, minWidth: '240px' },
  headerActions: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3 },
  // Sandbox
  sandbox: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalL, borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  sandboxRow: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' },
  sandboxField: { minWidth: '240px' },
  chipWrap: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXS },
  // Toolbar
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  filter: { minWidth: '260px' },
  count: { color: tokens.colorNeutralForeground3, marginLeft: 'auto' },
  // Grid
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    minWidth: 0, height: '100%',
    padding: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': { boxShadow: tokens.shadow16 },
  },
  cardHead: { display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalS },
  cardIcon: { color: tokens.colorBrandForeground1, flexShrink: 0, marginTop: tokens.spacingVerticalXXS },
  cardTitleCol: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0, flex: 1 },
  cardTitleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  cardName: { overflowWrap: 'anywhere', wordBreak: 'break-word' },
  cardWhen: { color: tokens.colorNeutralForeground2, flex: 1 },
  badgeRow: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  cardFoot: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap',
    marginTop: 'auto', paddingTop: tokens.spacingVerticalM,
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  footSpacer: { flex: 1 },
  loadingRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, padding: tokens.spacingVerticalL },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, marginTop: tokens.spacingVerticalM },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: tokens.spacingHorizontalL },
});

// Category → header/card icon (web3-ui: every card carries a section icon).
function iconForSkill(skill: Skill) {
  if (skill.isBuiltin) return <BrainCircuit24Regular />;
  return <Sparkle24Regular />;
}

function SkillFormDialog({
  open, onOpenChange, initial, editingId, onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: SkillFormState;
  editingId: string | null;
  onSaved: () => void;
}) {
  const s = useStyles();
  const [form, setForm] = useState<SkillFormState>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (open) { setForm(initial); setError(null); } }, [open, initial]);

  const set = <K extends keyof SkillFormState>(k: K, v: SkillFormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const save = useCallback(async () => {
    setSaving(true); setError(null);
    const payload = {
      name: form.name.trim(),
      whenToUse: form.whenToUse.trim(),
      guidance: form.guidance.trim(),
      panes: form.panes.split(',').map((p) => p.trim()).filter(Boolean),
      toolNames: form.toolNames.split(',').map((t) => t.trim()).filter(Boolean),
      mcpToolPrefix: form.mcpToolPrefix.trim() || undefined,
      category: form.category.trim() || 'Custom',
    };
    try {
      const url = editingId ? `/api/copilot/skills/${encodeURIComponent(editingId)}` : '/api/copilot/skills';
      const r = await clientFetch(url, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      onOpenChange(false);
      onSaved();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setSaving(false); }
  }, [form, editingId, onOpenChange, onSaved]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{editingId ? 'Edit skill' : 'New skill'}</DialogTitle>
          <DialogContent>
            <div className={s.form}>
              <Field label="Name" required hint="Display name for this skill.">
                <Input value={form.name} onChange={(_, d) => set('name', d.value)} placeholder="Medallion loader" />
              </Field>
              <Field label="When to use" hint="One line: when should Copilot reach for this skill?">
                <Input
                  value={form.whenToUse}
                  onChange={(_, d) => set('whenToUse', d.value)}
                  placeholder="Loading bronze → silver → gold Delta tables in a lakehouse."
                />
              </Field>
              <Field label="Guidance" required hint="Best-practice system text injected when the skill is active. Ground it in REAL tools — no vaporware.">
                <Textarea
                  value={form.guidance}
                  onChange={(_, d) => set('guidance', d.value)}
                  resize="vertical"
                  rows={6}
                  placeholder="SKILL: …  Follow the medallion layout; write Delta with lakehouse_write; …"
                />
              </Field>
              <div className={s.formGrid}>
                <Field label="Panes" required hint="Comma-separated pane / persona slugs (e.g. lakehouse, notebook, default).">
                  <Input value={form.panes} onChange={(_, d) => set('panes', d.value)} placeholder="lakehouse, default" />
                </Field>
                <Field label="Tools" hint="Comma-separated names of REAL registered tools this skill drives.">
                  <Input value={form.toolNames} onChange={(_, d) => set('toolNames', d.value)} placeholder="lakehouse_read, lakehouse_write" />
                </Field>
              </div>
              <div className={s.formGrid}>
                <Field label="Category" hint="Grouping label shown on the card.">
                  <Dropdown
                    value={form.category}
                    selectedOptions={[form.category]}
                    onOptionSelect={(_, d) => set('category', (d.optionValue as string) || 'Custom')}
                  >
                    <Option value="Custom">Custom</Option>
                    <Option value="Data engineering">Data engineering</Option>
                    <Option value="Governance">Governance</Option>
                    <Option value="AI &amp; ML">AI &amp; ML</Option>
                    <Option value="Ops">Ops</Option>
                  </Dropdown>
                </Field>
                <Field label="Opt-in MCP prefix (optional)" hint="mcp_<slug>_ prefix of an opt-in MCP whose tools augment this skill once connected.">
                  <Input value={form.mcpToolPrefix} onChange={(_, d) => set('mcpToolPrefix', d.value)} placeholder="mcp_azurearm_" />
                </Field>
              </div>
              {error && (
                <MessageBar intent="error">
                  <MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{error}</MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button
              appearance="primary"
              onClick={() => void save()}
              disabled={saving || !form.name.trim() || !form.guidance.trim() || !form.panes.trim()}
            >
              {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create skill'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export function SkillsStudio() {
  const s = useStyles();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  // Builder dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formInitial, setFormInitial] = useState<SkillFormState>(EMPTY_FORM);
  // Sandbox
  const [sandboxPane, setSandboxPane] = useState('');
  const [sandboxActive, setSandboxActive] = useState<string[] | null>(null);
  const [sandboxLoading, setSandboxLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const r = await clientFetch('/api/copilot/skills');
      const j = await r.json();
      if (!j.ok) { setLoadError(j.error || `HTTP ${r.status}`); setSkills([]); return; }
      setSkills(Array.isArray(j.skills) ? j.skills : []);
    } catch (e: any) {
      setLoadError(e?.message || String(e)); setSkills([]);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = useCallback(async (skill: Skill, enabled: boolean) => {
    setBusyId(skill.id); setRowError(null);
    // Optimistic update.
    setSkills((prev) => prev.map((x) => x.id === skill.id ? { ...x, effectiveEnabled: enabled, userOverride: enabled } : x));
    try {
      const r = await clientFetch(`/api/copilot/skills/${encodeURIComponent(skill.id)}/state`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const j = await r.json();
      if (!j.ok) { setRowError(j.error || `HTTP ${r.status}`); await load(); }
    } catch (e: any) {
      setRowError(e?.message || String(e)); await load();
    } finally { setBusyId(null); }
  }, [load]);

  const duplicate = useCallback(async (skill: Skill) => {
    setBusyId(skill.id); setRowError(null);
    try {
      const r = await clientFetch(`/api/copilot/skills/${encodeURIComponent(skill.id)}/duplicate`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) { setRowError(j.error || `HTTP ${r.status}`); return; }
      await load();
    } catch (e: any) {
      setRowError(e?.message || String(e));
    } finally { setBusyId(null); }
  }, [load]);

  const remove = useCallback(async (skill: Skill) => {
    setBusyId(skill.id); setRowError(null);
    try {
      const r = await clientFetch(`/api/copilot/skills/${encodeURIComponent(skill.id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setRowError(j.error || `HTTP ${r.status}`); return; }
      await load();
    } catch (e: any) {
      setRowError(e?.message || String(e));
    } finally { setBusyId(null); }
  }, [load]);

  const openNew = () => { setEditingId(null); setFormInitial(EMPTY_FORM); setDialogOpen(true); };
  const openEdit = (skill: Skill) => {
    setEditingId(skill.id);
    setFormInitial({
      name: skill.name,
      whenToUse: skill.whenToUse,
      guidance: skill.guidance,
      panes: (skill.panes || []).join(', '),
      toolNames: (skill.toolNames || []).join(', '),
      mcpToolPrefix: skill.mcpToolPrefix || '',
      category: skill.category || 'Custom',
    });
    setDialogOpen(true);
  };

  const runSandbox = useCallback(async () => {
    const pane = sandboxPane.trim();
    if (!pane) { setSandboxActive(null); return; }
    setSandboxLoading(true);
    try {
      const r = await clientFetch(`/api/copilot/skills?pane=${encodeURIComponent(pane)}`);
      const j = await r.json();
      setSandboxActive(j.ok && Array.isArray(j.active) ? j.active : []);
    } catch {
      setSandboxActive([]);
    } finally { setSandboxLoading(false); }
  }, [sandboxPane]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((x) =>
      x.name.toLowerCase().includes(q) ||
      (x.whenToUse || '').toLowerCase().includes(q) ||
      (x.panes || []).some((p) => p.toLowerCase().includes(q)) ||
      (x.category || '').toLowerCase().includes(q),
    );
  }, [skills, filter]);

  return (
    <div className={s.root}>
      {/* Header */}
      <div className={s.header}>
        <span className={s.headerIcon} aria-hidden><Sparkle24Regular /></span>
        <div className={s.headerText}>
          <Title3>Skills library</Title3>
          <Body1 className={s.hint}>
            Every skill the Loom Copilot can load — Microsoft &amp; Power BI built-ins plus your own.
            Toggle any skill on or off for yourself; author custom skills that ground real tools. Skills
            are Azure-native by default.
          </Body1>
        </div>
        <div className={s.headerActions}>
          <Button appearance="primary" icon={<Add20Regular />} onClick={openNew}>New skill</Button>
        </div>
      </div>

      {/* Sandbox */}
      <div className={s.sandbox}>
        <Subtitle2>Sandbox — which skills are active for me on a pane?</Subtitle2>
        <div className={s.sandboxRow}>
          <Field label="Pane slug" className={s.sandboxField} hint="e.g. lakehouse, notebook, cost, rbac, default">
            <Input
              value={sandboxPane}
              onChange={(_, d) => setSandboxPane(d.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void runSandbox(); }}
              placeholder="lakehouse"
              contentBefore={<Search20Regular />}
            />
          </Field>
          <Button icon={<Search20Regular />} onClick={() => void runSandbox()} disabled={!sandboxPane.trim() || sandboxLoading}>
            {sandboxLoading ? 'Resolving…' : 'Resolve'}
          </Button>
        </div>
        {sandboxActive !== null && (
          sandboxActive.length === 0 ? (
            <Caption1 className={s.hint}>No skills are active for you on “{sandboxPane.trim()}”.</Caption1>
          ) : (
            <div className={s.chipWrap}>
              {sandboxActive.map((id) => {
                const sk = skills.find((x) => x.id === id);
                return <Badge key={id} appearance="tint" color="brand">{sk?.name || id}</Badge>;
              })}
            </div>
          )
        )}
      </div>

      {/* Toolbar */}
      <div className={s.toolbar}>
        <Field className={s.filter}>
          <Input
            value={filter}
            onChange={(_, d) => setFilter(d.value)}
            placeholder="Filter skills by name, pane, or category…"
            contentBefore={<Search20Regular />}
          />
        </Field>
        {!loading && <Caption1 className={s.count}>{filtered.length} of {skills.length} skill{skills.length === 1 ? '' : 's'}</Caption1>}
      </div>

      {rowError && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Action failed</MessageBarTitle>{rowError}</MessageBarBody>
        </MessageBar>
      )}
      {loadError && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Couldn’t load skills</MessageBarTitle>{loadError}</MessageBarBody>
        </MessageBar>
      )}

      {/* Grid / states */}
      {loading ? (
        <div className={s.loadingRow}><Spinner size="tiny" /> <Caption1>Loading skills…</Caption1></div>
      ) : skills.length === 0 ? (
        <EmptyState
          icon={<BrainCircuit24Regular />}
          title="No skills yet"
          body="Author your first Copilot skill — ground it in real tools and it loads automatically on the panes you choose."
          primaryAction={{ label: 'New skill', onClick: openNew }}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Search20Regular />}
          title="No matches"
          body={`No skills match “${filter}”.`}
          primaryAction={{ label: 'Clear filter', onClick: () => setFilter(''), appearance: 'secondary' }}
        />
      ) : (
        <div className={s.grid}>
          {filtered.map((skill) => (
            <div key={skill.id} className={s.card}>
              <div className={s.cardHead}>
                <span className={s.cardIcon}>{iconForSkill(skill)}</span>
                <div className={s.cardTitleCol}>
                  <div className={s.cardTitleRow}>
                    <Text weight="semibold" className={s.cardName}>{skill.name}</Text>
                    <Badge appearance={skill.isBuiltin ? 'outline' : 'tint'} color={skill.isBuiltin ? 'informative' : 'brand'} size="small">
                      {skill.isBuiltin ? 'Built-in' : 'Custom'}
                    </Badge>
                  </div>
                  {skill.category && <Caption1 className={s.hint}>{skill.category}</Caption1>}
                </div>
                <Switch
                  checked={skill.effectiveEnabled}
                  disabled={busyId === skill.id}
                  onChange={(_, d) => void toggle(skill, d.checked)}
                  aria-label={`${skill.effectiveEnabled ? 'Disable' : 'Enable'} ${skill.name}`}
                />
              </div>

              <Body1 className={s.cardWhen}>{skill.whenToUse}</Body1>

              <div className={s.badgeRow}>
                {(skill.panes || []).map((p) => (
                  <Badge key={p} appearance="outline" color="subtle" size="small">{p}</Badge>
                ))}
              </div>
              {skill.mcpToolPrefix && (
                <Caption1 className={s.hint}>Opt-in MCP: <code>{skill.mcpToolPrefix}</code></Caption1>
              )}
              {skill.toolNames && skill.toolNames.length > 0 && (
                <Caption1 className={s.hint}>
                  <Wrench20Regular fontSize={14} /> {skill.toolNames.length} tool{skill.toolNames.length === 1 ? '' : 's'}
                </Caption1>
              )}

              <div className={s.cardFoot}>
                {skill.userOverride !== null && (
                  <Badge appearance="tint" color={skill.userOverride ? 'success' : 'warning'} size="small">
                    {skill.userOverride ? 'On (your override)' : 'Off (your override)'}
                  </Badge>
                )}
                <div className={s.footSpacer} />
                <Button size="small" icon={<Copy20Regular />} onClick={() => void duplicate(skill)} disabled={busyId === skill.id}>
                  Duplicate
                </Button>
                {!skill.isBuiltin && (
                  <>
                    <Button size="small" icon={<Edit20Regular />} onClick={() => openEdit(skill)} disabled={busyId === skill.id}>
                      Edit
                    </Button>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<Delete20Regular />}
                      onClick={() => void remove(skill)}
                      disabled={busyId === skill.id}
                    >
                      Delete
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <SkillFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initial={formInitial}
        editingId={editingId}
        onSaved={load}
      />
    </div>
  );
}
