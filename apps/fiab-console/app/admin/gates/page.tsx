'use client';

/**
 * /admin/gates — the COMPLETE gate registry (G2).
 *
 * Every configuration gate in the product — one row per registry entry
 * (lib/gates/registry.ts, derived from self-audit ENV_CHECKS) — with LIVE
 * status (configured / blocked, evaluated from the real env-presence checks
 * the per-client *ConfigGate() helpers gate on), the required settings, the
 * owning surfaces, the bicep module + RBAC role, and a one-click **Fix it**
 * wizard that loads real ARM options and applies through the shared
 * env-config write path. Filter by status / category / free text.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Caption1, Dropdown, Option, Input, MessageBar, MessageBarBody,
  MessageBarTitle, Spinner, Subtitle2, Table, TableBody, TableCell, TableHeader,
  TableHeaderCell, TableRow, Tooltip, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Wrench16Regular, ArrowSync16Regular, ShieldCheckmark20Regular, Warning20Regular,
} from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { clientFetch } from '@/lib/client-fetch';
import { GateFixitDialog } from '@/lib/components/shared/honest-gate';
import { getGate, type GateDef } from '@/lib/gates/registry';

const useStyles = makeStyles({
  toolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalL,
  },
  counts: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalM,
  },
  tableWrap: { overflowX: 'auto' },
  envList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalXS,
  },
  surfaces: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  loading: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalXXL,
  },
});

interface GateRow extends GateDef {
  status: 'configured' | 'blocked' | 'cloud-unavailable';
  missing: string[];
  detail?: string;
  /** X2 — the backing service's availability in the ACTIVE cloud. */
  cloudAvailability?: 'ga' | 'limited' | 'unavailable';
  /** X2 — the Azure-native / OSS / Loom-native fallback for this cloud. */
  fallbackNote?: string;
}

export default function AdminGatesPage() {
  const s = useStyles();
  const [rows, setRows] = useState<GateRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'blocked' | 'configured' | 'cloud-unavailable'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [fixGateId, setFixGateId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await clientFetch('/api/admin/gates');
      const j = await r.json().catch(() => null);
      if (j?.ok) {
        setRows(j.gates as GateRow[]);
        setWriteError(j.writeConfigured ? null : (j.writeError || 'runtime env-write path not configured'));
      } else {
        setError(j?.error || j?.remediation || `load failed (${r.status})`);
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const categories = useMemo(
    () => Array.from(new Set((rows || []).map((r) => r.category))).sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    let out = rows || [];
    if (statusFilter !== 'all') out = out.filter((r) => r.status === statusFilter);
    if (categoryFilter !== 'all') out = out.filter((r) => r.category === categoryFilter);
    const q = query.trim().toLowerCase();
    if (q) {
      out = out.filter((r) =>
        r.id.includes(q) ||
        r.title.toLowerCase().includes(q) ||
        r.requiredSettings.some((rs) => rs.envVar.toLowerCase().includes(q)) ||
        r.surfaces.some((sf) => sf.label.toLowerCase().includes(q) || sf.path.toLowerCase().includes(q)));
    }
    // Blocked first (actionable), then cloud-unavailable, then configured;
    // within a band: severity, then id.
    const sevRank = { critical: 0, recommended: 1, optional: 2 } as Record<string, number>;
    const stRank = { blocked: 0, 'cloud-unavailable': 1, configured: 2 } as Record<string, number>;
    return [...out].sort((a, b) =>
      (stRank[a.status] - stRank[b.status]) ||
      (sevRank[a.severity] - sevRank[b.severity]) ||
      a.id.localeCompare(b.id));
  }, [rows, statusFilter, categoryFilter, query]);

  const configured = (rows || []).filter((r) => r.status === 'configured').length;
  const cloudUnavailable = (rows || []).filter((r) => r.status === 'cloud-unavailable').length;
  const fixGate = fixGateId ? getGate(fixGateId) : undefined;

  return (
    <AdminShell
      sectionTitle="Gate registry"
      learn={{
        title: 'Gate registry',
        content:
          'The complete registry of every configuration gate in CSA Loom — each required env var, role, and resource, with live configured/blocked status and a one-click Fix-it wizard that discovers real Azure resources and applies through the same audited env-config write path.',
        tips: [
          'Status is the real env-presence check the feature gates use',
          'Fix it lists live ARM resources — pick, apply, and a new revision rolls',
          'Copilot can list, explain, and resolve gates (loom_list_gates / loom_resolve_gate)',
        ],
      }}
    >
      {writeError && (
        <MessageBar intent="warning" layout="multiline" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>
            <MessageBarTitle>Fix-it apply path not available</MessageBarTitle>
            {writeError} — the registry still shows honest status; applying values needs the write path.
          </MessageBarBody>
        </MessageBar>
      )}
      {error && (
        <MessageBar intent="error" layout="multiline" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {rows && (
        <div className={s.counts}>
          <ShieldCheckmark20Regular style={{ color: tokens.colorPaletteGreenForeground1 }} />
          <Subtitle2>{configured} configured</Subtitle2>
          <Warning20Regular style={{ color: tokens.colorPaletteYellowForeground1 }} />
          <Subtitle2>{rows.length - configured - cloudUnavailable} blocked</Subtitle2>
          {cloudUnavailable > 0 && <Subtitle2>{cloudUnavailable} cloud-unavailable</Subtitle2>}
          <Caption1>of {rows.length} registered gates</Caption1>
          <Button size="small" appearance="transparent" icon={<ArrowSync16Regular />} onClick={reload}>
            Refresh
          </Button>
        </div>
      )}

      <div className={s.toolbar}>
        <Dropdown
          value={statusFilter === 'all' ? 'All statuses' : statusFilter}
          selectedOptions={[statusFilter]}
          onOptionSelect={(_, d) => setStatusFilter((d.optionValue as any) || 'all')}
        >
          <Option value="all">All statuses</Option>
          <Option value="blocked">blocked</Option>
          <Option value="configured">configured</Option>
          <Option value="cloud-unavailable">cloud-unavailable</Option>
        </Dropdown>
        <Dropdown
          value={categoryFilter === 'all' ? 'All categories' : categoryFilter}
          selectedOptions={[categoryFilter]}
          onOptionSelect={(_, d) => setCategoryFilter((d.optionValue as any) || 'all')}
        >
          <Option value="all">All categories</Option>
          {categories.map((c) => <Option key={c} value={c}>{c}</Option>)}
        </Dropdown>
        <Input
          placeholder="Filter by gate, env var, or surface…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ minWidth: '260px' }}
        />
      </div>

      {loading && !rows ? (
        <div className={s.loading}><Spinner size="small" /><Caption1>Evaluating every registered gate…</Caption1></div>
      ) : (
        <div className={s.tableWrap}>
          <Table size="small" aria-label="Gate registry">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Gate</TableHeaderCell>
                <TableHeaderCell>Required settings</TableHeaderCell>
                <TableHeaderCell>Surfaces</TableHeaderCell>
                <TableHeaderCell>Severity</TableHeaderCell>
                <TableHeaderCell>Fix</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((g) => (
                <TableRow key={g.id}>
                  <TableCell>
                    <Badge
                      appearance="tint"
                      color={g.status === 'configured' ? 'success' : g.status === 'cloud-unavailable' ? 'informative' : 'warning'}
                      size="small"
                    >
                      {g.status}
                    </Badge>
                    {g.cloudAvailability === 'limited' && g.fallbackNote && (
                      <Tooltip content={g.fallbackNote} relationship="description">
                        <Badge appearance="outline" color="informative" size="small" style={{ marginLeft: tokens.spacingHorizontalXS }}>
                          limited in this cloud
                        </Badge>
                      </Tooltip>
                    )}
                    {g.canAutoResolve && (
                      <Tooltip content={g.autoResolveNote || 'Auto-resolved by a push-button deploy — zero operator input.'} relationship="description">
                        <Badge appearance="outline" size="small" style={{ marginLeft: tokens.spacingHorizontalXS }}>
                          auto
                        </Badge>
                      </Tooltip>
                    )}
                  </TableCell>
                  <TableCell>
                    <Tooltip content={g.remediation} relationship="description">
                      <span>{g.title}</span>
                    </Tooltip>
                    <Caption1 style={{ display: 'block' }}><code>{g.id}</code> · {g.category}</Caption1>
                  </TableCell>
                  <TableCell>
                    <div className={s.envList}>
                      {g.requiredSettings.map((rs) => (
                        <Badge
                          key={rs.envVar}
                          appearance={g.missing.includes(rs.envVar) ? 'filled' : 'outline'}
                          color={g.missing.includes(rs.envVar) ? 'warning' : 'informative'}
                          size="small"
                        >
                          {rs.envVar}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className={s.surfaces}>
                      {g.surfaces.slice(0, 3).map((sf) => sf.label).join(' · ') || '—'}
                      {g.surfaces.length > 3 ? ` · +${g.surfaces.length - 3} more` : ''}
                    </span>
                  </TableCell>
                  <TableCell><Caption1>{g.severity}</Caption1></TableCell>
                  <TableCell>
                    {g.status === 'blocked' ? (
                      <Button
                        size="small"
                        appearance="primary"
                        icon={<Wrench16Regular />}
                        onClick={() => setFixGateId(g.id)}
                      >
                        Fix it
                      </Button>
                    ) : g.status === 'cloud-unavailable' ? (
                      // X2: no Fix-it — you cannot provision a service that does
                      // not exist in this cloud; the tooltip names the fallback.
                      <Tooltip
                        content={g.fallbackNote || g.availability?.fallbackNote || g.remediation}
                        relationship="description"
                      >
                        <Caption1>Use the Loom-native equivalent</Caption1>
                      </Tooltip>
                    ) : (
                      <Button size="small" appearance="secondary" onClick={() => setFixGateId(g.id)}>
                        Edit
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {fixGate && (
        <GateFixitDialog
          gate={fixGate}
          open={!!fixGateId}
          onClose={() => setFixGateId(null)}
          onResolved={reload}
        />
      )}
    </AdminShell>
  );
}
