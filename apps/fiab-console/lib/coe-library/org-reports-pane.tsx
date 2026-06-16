'use client';

/**
 * Organization reports — consumer gallery.
 *
 * Surfaces every CoE report a colleague has published to the organization
 * (GET /api/org-reports). Any authenticated member can browse the gallery and
 * Open a report (read-only) rendered by <ReportCanvas> from the bundled PBIP
 * (real PBIR + TMDL SAMPLE data). Azure-native: no Power BI / Fabric workspace.
 *
 * This is the missing "consumer" half of the CoE library: admins clone +
 * publish in Admin → Organizational visuals; everyone else views here.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Button, Text,
  MessageBar, MessageBarBody, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Open20Regular, ArrowSync24Regular, DataPie24Regular, DocumentTable24Regular,
} from '@fluentui/react-icons';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { ReportViewerDialog } from '@/lib/coe-library/report-render/report-viewer-dialog';

interface OrgReport {
  id: string;
  templateId: string;
  displayName: string;
  title: string;
  category: string;
  publishedBy?: string;
  publishedAt?: string;
}

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
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: tokens.spacingHorizontalL },
  card: {
    display: 'flex', flexDirection: 'column', borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    overflow: 'hidden', boxShadow: tokens.shadow4,
    transition: 'box-shadow .15s ease, transform .15s ease',
    ':hover': { boxShadow: tokens.shadow16, transform: 'translateY(-2px)' },
  },
  thumb: { height: '88px', display: 'flex', alignItems: 'flex-end', padding: tokens.spacingHorizontalM, color: '#fff' },
  thumbTitle: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase400, textShadow: '0 1px 4px #0008' },
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingHorizontalM, flexGrow: 1 },
  meta: { color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, padding: tokens.spacingHorizontalM, paddingTop: 0 },
  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalXXL, textAlign: 'center', color: tokens.colorNeutralForeground3,
  },
  emptyIcon: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '56px', height: '56px',
    borderRadius: tokens.borderRadiusCircular, backgroundColor: tokens.colorNeutralBackground3, marginBottom: tokens.spacingVerticalXS,
  },
});

function fmt(iso?: string) { if (!iso) return '—'; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(); }

function match(r: OrgReport, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  return r.displayName.toLowerCase().includes(n) || r.title.toLowerCase().includes(n) || r.category.toLowerCase().includes(n);
}

export function OrgReportsPane(): React.ReactElement {
  const s = useStyles();
  const [reports, setReports] = useState<OrgReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/org-reports');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed to load'); return; }
      setReports(j.reports || []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => reports.filter((r) => match(r, query)), [reports, query]);
  const openReport = useMemo(() => reports.find((r) => r.id === openId) || null, [reports, openId]);

  return (
    <>
      <Section
        title="Organization reports"
        actions={<Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>}
      >
        <Body1 style={{ color: tokens.colorNeutralForeground2, lineHeight: 1.5, marginBottom: tokens.spacingVerticalM }}>
          Reports your colleagues have published from the Cloud Center of Excellence (CoE) template library.
          Open any one to view it (read-only) with clearly-labelled sample data — connect it to your live
          Azure estate by cloning the source template in Admin → Organizational visuals. No Microsoft Fabric
          or Power BI workspace is required.
        </Body1>

        {error && <MessageBar intent="error" style={{ marginBottom: 12 }}><MessageBarBody>{error}</MessageBarBody></MessageBar>}

        {!loading && reports.length > 0 && (
          <Toolbar search={query} onSearch={setQuery} searchPlaceholder="Search published reports…" />
        )}

        {loading ? (
          <Spinner label="Loading organization reports…" />
        ) : reports.length === 0 ? (
          <div className={s.empty}>
            <span className={s.emptyIcon} aria-hidden><DataPie24Regular /></span>
            <Text size={400} weight="semibold">No reports published yet</Text>
            <Text size={300}>
              An admin can publish a CoE report from <strong>Admin portal → Organizational visuals → your cloned templates → Publish to organization</strong>.
              Published reports appear here for everyone.
            </Text>
          </div>
        ) : (
          <div className={s.grid}>
            {filtered.map((r) => (
              <div key={r.id} className={s.card}>
                <div className={s.thumb} style={{ background: GRAD[r.category] || 'linear-gradient(135deg,#444,#1B1A29)' }}>
                  <span className={s.thumbTitle}>{r.displayName}</span>
                </div>
                <div className={s.body}>
                  <div><Badge appearance="tint" color="brand" size="small">{r.category}</Badge></div>
                  <Caption1 className={s.meta}>From template “{r.title}”</Caption1>
                  <Caption1 className={s.meta}>
                    Published {fmt(r.publishedAt)}{r.publishedBy ? ` by ${r.publishedBy}` : ''}
                  </Caption1>
                </div>
                <div className={s.actions}>
                  <Button size="small" appearance="primary" icon={<Open20Regular />} onClick={() => setOpenId(r.id)}>Open report</Button>
                </div>
              </div>
            ))}
            {filtered.length === 0 && (
              <div className={s.empty}>
                <span className={s.emptyIcon} aria-hidden><DocumentTable24Regular /></span>
                <Text>No reports match “{query}”.</Text>
              </div>
            )}
          </div>
        )}
      </Section>

      <ReportViewerDialog
        open={!!openReport}
        onClose={() => setOpenId(null)}
        fetchUrl={openReport ? `/api/org-reports/render?id=${encodeURIComponent(openReport.id)}` : null}
        title={openReport?.displayName}
        publishedBadge
        defaultLive={false}
      />
    </>
  );
}

export default OrgReportsPane;
