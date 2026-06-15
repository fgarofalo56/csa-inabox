'use client';

/**
 * CoE report-template library pane.
 *
 * Surfaces the default Cloud Center of Excellence (CoE) Power BI report
 * templates as a browsable library inside Organizational visuals. Users preview
 * a template (pages, data sources, parameters, required roles) and click "Use
 * this template" to clone it into their tenant library for editing / publishing.
 *
 * Real backend: GET/POST/DELETE /api/admin/coe-library. The catalog is bundled
 * (always available — no Microsoft Fabric / Power BI workspace dependency). When
 * the org-visuals Blob backing is unset, a clone still saves (metadata) and an
 * honest Fluent gate names LOOM_ORG_VISUALS_URL.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Button, Input, Field,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  Eye20Regular, Copy20Regular, Delete20Regular, ArrowSync24Regular,
  DataArea20Regular, CheckmarkCircle20Filled,
} from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';

interface CoeTemplate {
  id: string; title: string; description: string; category: string;
  thumbnail: string; pbipPath: string; pages: string[]; measures: number;
  dataSources: string[]; requiredRoles: string[]; parameters: string[]; sampleData: boolean;
}
interface CoeClone {
  id: string; templateId: string; title: string; displayName: string;
  fileCount: number; blobCopied: boolean; clonedAt: string; clonedBy: string;
}
interface Catalog { version: string; description: string; templates: CoeTemplate[] }

// Deterministic gradient per category so tiles read as a set without external assets.
const GRAD: Record<string, string> = {
  'Adoption & Maturity': 'linear-gradient(135deg,#6E56CF,#1B1A29)',
  'FinOps': 'linear-gradient(135deg,#0F6CBD,#1B1A29)',
  'Security & Compliance': 'linear-gradient(135deg,#C50F1F,#1B1A29)',
  'Inventory & Optimization': 'linear-gradient(135deg,#107C10,#1B1A29)',
  'Identity & Access': 'linear-gradient(135deg,#8764B8,#1B1A29)',
  'Data Governance': 'linear-gradient(135deg,#038387,#1B1A29)',
  'Operations': 'linear-gradient(135deg,#CA5010,#1B1A29)',
  'Platform & Governance': 'linear-gradient(135deg,#5C2E91,#1B1A29)',
};

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  card: {
    display: 'flex', flexDirection: 'column',
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    overflow: 'hidden',
    boxShadow: tokens.shadow4,
    transition: 'box-shadow .15s ease, transform .15s ease',
    ':hover': { boxShadow: tokens.shadow16, transform: 'translateY(-2px)' },
  },
  thumb: {
    height: '96px', display: 'flex', alignItems: 'flex-end', padding: tokens.spacingHorizontalM,
    color: '#fff',
  },
  thumbTitle: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase400, textShadow: '0 1px 4px #0008' },
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingHorizontalM, flexGrow: 1 },
  desc: { color: tokens.colorNeutralForeground2, lineHeight: 1.4, flexGrow: 1 },
  metaRow: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, padding: tokens.spacingHorizontalM, paddingTop: 0 },
  dlgList: { margin: 0, paddingLeft: tokens.spacingHorizontalL, color: tokens.colorNeutralForeground2 },
  dlgGrid: { display: 'grid', gridTemplateColumns: '1fr', gap: tokens.spacingVerticalM },
  clonesRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, padding: tokens.spacingVerticalS, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
});

function fmt(iso?: string) { if (!iso) return '—'; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(); }

export function CoeLibraryPane() {
  const s = useStyles();
  const [cat, setCat] = useState<Catalog | null>(null);
  const [clones, setClones] = useState<CoeClone[]>([]);
  const [orgVisualsConfigured, setOrgVisualsConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [blobGate, setBlobGate] = useState<any | null>(null);
  const [preview, setPreview] = useState<CoeTemplate | null>(null);
  const [cloneName, setCloneName] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/admin/coe-library');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed to load library'); return; }
      setCat(j.catalog); setClones(j.clones || []); setOrgVisualsConfigured(!!j.orgVisualsConfigured);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function useTemplate(t: CoeTemplate, displayName?: string) {
    setBusyId(t.id); setError(null); setOkMsg(null); setBlobGate(null);
    try {
      const r = await fetch('/api/admin/coe-library', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ templateId: t.id, ...(displayName ? { displayName } : {}) }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setOkMsg(`Added “${j.clone.displayName}” to your library${j.clone.blobCopied ? ` (${j.clone.fileCount} PBIP files copied to Blob)` : ''}. Publish it with scripts/csa-loom/publish-coe-reports.sh.`);
      if (j.blobGate) setBlobGate(j.blobGate);
      setPreview(null); setCloneName('');
      await load();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusyId(null); }
  }

  async function removeClone(c: CoeClone) {
    if (!confirm(`Remove “${c.displayName}” from your library?`)) return;
    setBusyId(c.id); setError(null);
    try {
      const r = await fetch(`/api/admin/coe-library?id=${encodeURIComponent(c.id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      await load();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusyId(null); }
  }

  const clonedIds = useMemo(() => new Set(clones.map((c) => c.templateId)), [clones]);

  return (
    <>
      <Section title="Default report templates — Cloud Center of Excellence (CoE)">
        <Body1 style={{ color: tokens.colorNeutralForeground2, lineHeight: 1.5, marginBottom: tokens.spacingVerticalM }}>
          A ready-to-use library of Power BI report templates for enterprise & environment management — adoption,
          FinOps, security posture, inventory, identity, data governance, operations and landing-zone conformance.
          Each is a version-controlled PBIP (PBIR + TMDL) that queries your own Azure estate (Cost Management, Azure
          Resource Graph, Log Analytics, Defender, Purview, Microsoft Graph). Preview one, then <strong>Use this template</strong> to
          clone it into your library and rebrand it. Templates ship with clearly-labelled <strong>sample data</strong> until you
          connect them — no Microsoft Fabric or Power BI workspace is required to browse or clone.
        </Body1>

        {error && <MessageBar intent="error" style={{ marginBottom: 12 }}><MessageBarBody>{error}</MessageBarBody></MessageBar>}
        {okMsg && <MessageBar intent="success" style={{ marginBottom: 12 }}><MessageBarBody>{okMsg}</MessageBarBody></MessageBar>}
        {blobGate && (
          <MessageBar intent="warning" style={{ marginBottom: 12 }}>
            <MessageBarBody>
              <MessageBarTitle>Clone saved (metadata only)</MessageBarTitle>
              The editable PBIP files were not copied to Blob storage because <code>{blobGate.missingEnvVar}</code> is not set.
              Deploy the org-visuals storage container (<code>{blobGate.bicepModule}</code>) and set <code>{blobGate.missingEnvVar}</code> to enable file copy.
            </MessageBarBody>
          </MessageBar>
        )}

        {loading && !cat ? (
          <Spinner label="Loading CoE template library…" />
        ) : (
          <div className={s.grid}>
            {(cat?.templates || []).map((t) => (
              <div key={t.id} className={s.card}>
                <div className={s.thumb} style={{ background: GRAD[t.category] || 'linear-gradient(135deg,#444,#1B1A29)' }}>
                  <span className={s.thumbTitle}>{t.title}</span>
                </div>
                <div className={s.body}>
                  <div className={s.metaRow}>
                    <Badge appearance="tint" color="brand" size="small">{t.category}</Badge>
                    {clonedIds.has(t.id) && (
                      <Badge appearance="tint" color="success" size="small" icon={<CheckmarkCircle20Filled />}>In your library</Badge>
                    )}
                  </div>
                  <Caption1 className={s.desc}>{t.description}</Caption1>
                  <div className={s.metaRow}>
                    <Badge appearance="outline" size="small">{t.pages.length} page{t.pages.length === 1 ? '' : 's'}</Badge>
                    <Badge appearance="outline" size="small">{t.measures} measures</Badge>
                    <Badge appearance="outline" size="small" icon={<DataArea20Regular />}>{t.dataSources.length} sources</Badge>
                  </div>
                </div>
                <div className={s.actions}>
                  <Button size="small" appearance="secondary" icon={<Eye20Regular />} onClick={() => { setPreview(t); setCloneName(t.title); }}>Preview</Button>
                  <Button size="small" appearance="primary" icon={busyId === t.id ? <Spinner size="tiny" /> : <Copy20Regular />}
                    disabled={busyId === t.id} onClick={() => useTemplate(t)}>Use this template</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {clones.length > 0 && (
        <Section title="Your cloned templates" actions={<Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>}>
          {clones.map((c) => (
            <div key={c.id} className={s.clonesRow}>
              <Copy20Regular style={{ color: tokens.colorBrandForeground1 }} />
              <div style={{ flexGrow: 1 }}>
                <Body1><strong>{c.displayName}</strong></Body1>{' '}
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  from {c.title} • {c.blobCopied ? `${c.fileCount} files in Blob` : 'metadata only'} • cloned {fmt(c.clonedAt)} by {c.clonedBy}
                </Caption1>
              </div>
              <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={busyId === c.id} onClick={() => removeClone(c)}>Remove</Button>
            </div>
          ))}
        </Section>
      )}

      <Dialog open={!!preview} onOpenChange={(_, d) => { if (!d.open) setPreview(null); }}>
        <DialogSurface>
          {preview && (
            <DialogBody>
              <DialogTitle>{preview.title}</DialogTitle>
              <DialogContent>
                <div className={s.dlgGrid}>
                  <Body1 style={{ color: tokens.colorNeutralForeground2 }}>{preview.description}</Body1>
                  {preview.sampleData && (
                    <MessageBar intent="info"><MessageBarBody>
                      Ships with <strong>sample data</strong>. After cloning, connect it by setting the Power Query
                      parameters and uncommenting the live source in each table.
                    </MessageBarBody></MessageBar>
                  )}
                  <div>
                    <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>Pages</Caption1>
                    <ul className={s.dlgList}>{preview.pages.map((p) => <li key={p}>{p}</li>)}</ul>
                  </div>
                  <div>
                    <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>Azure data sources</Caption1>
                    <ul className={s.dlgList}>{preview.dataSources.map((d) => <li key={d}>{d}</li>)}</ul>
                  </div>
                  <div>
                    <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>Required roles (for live refresh)</Caption1>
                    <ul className={s.dlgList}>{preview.requiredRoles.map((r) => <li key={r}>{r}</li>)}</ul>
                  </div>
                  <div>
                    <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>Parameters</Caption1>
                    <div className={s.metaRow}>{preview.parameters.map((p) => <Badge key={p} appearance="outline" size="small">{p}</Badge>)}</div>
                  </div>
                  <Field label="Name for your clone">
                    <Input value={cloneName} onChange={(_, d) => setCloneName(d.value)} placeholder={preview.title} />
                  </Field>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    PBIP path: <code>{preview.pbipPath}</code>
                  </Caption1>
                </div>
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setPreview(null)}>Close</Button>
                <Button appearance="primary" icon={busyId === preview.id ? <Spinner size="tiny" /> : <Copy20Regular />}
                  disabled={busyId === preview.id}
                  onClick={() => useTemplate(preview, cloneName.trim() || preview.title)}>Use this template</Button>
              </DialogActions>
            </DialogBody>
          )}
        </DialogSurface>
      </Dialog>
    </>
  );
}
