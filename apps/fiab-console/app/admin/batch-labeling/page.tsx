'use client';

/**
 * Batch labeling — bulk-apply a sensitivity label to many catalog items.
 *
 * Multi-select items → pick a label → Apply. The Cosmos label-assignment is
 * always written; Purview asset classification and Power BI Admin setLabels
 * are opt-in (and only when the backing service is configured). The results
 * grid shows the real per-item outcome of every backend write — success in
 * green, failure in red, with the verbatim status/error text.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Button, Checkbox, Dropdown, Option, Divider,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Tag24Regular, Info20Regular, CheckmarkCircle20Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

interface CatalogItem {
  id: string;
  workspaceId: string;
  workspaceName: string;
  itemType: string;
  displayName: string;
  sensitivity: string | null;
  pbiArtifactId: string | null;
  pbiArtifactType: string | null;
}

interface LabelOption {
  key: string;            // "loom:<id>" | "mip:<id>"
  name: string;
  color?: string;
  source: 'loom' | 'mip';
  id: string;             // the underlying label id
  isMipGuid: boolean;
}

interface ResultRow {
  id: string;
  displayName: string;
  itemType: string;
  cosmosStatus: string;
  purviewStatus?: string;
  pbiArtifactId?: string;
  pbiStatus?: string;
}

interface LoadData {
  items: CatalogItem[];
  loomLabels: { id: string; name: string; color?: string }[];
  mipLabels: { id: string; name: string; color?: string; isMipGuid: boolean }[] | null;
  mipConfigured: boolean;
  purviewConfigured: boolean;
  pbiAdminConfigured: boolean;
}

const useStyles = makeStyles({
  explainer: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-start' },
  swatch: { width: '14px', height: '14px', borderRadius: '3px', display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 },
  pickerRow: { display: 'flex', gap: tokens.spacingHorizontalL, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: tokens.spacingVerticalM },
  field: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '260px' },
  optRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  opts: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: tokens.spacingVerticalS },
});

function statusBadge(value: string | undefined): React.ReactNode {
  if (!value) return <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>—</Caption1>;
  if (value === 'Succeeded') return <Badge color="success" appearance="tint">Succeeded</Badge>;
  if (value === 'Skipped') return <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Skipped</Caption1>;
  // Everything else (Failed/NotFound/InsufficientUsageRights/error text) = red.
  return <Badge color="danger" appearance="tint">{value}</Badge>;
}

export default function BatchLabelingPage() {
  const s = useStyles();
  const [data, setData] = useState<LoadData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [labelKey, setLabelKey] = useState<string>('');
  const [applyToPurview, setApplyToPurview] = useState(false);
  const [applyToPowerBi, setApplyToPowerBi] = useState(false);

  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<ResultRow[] | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/admin/batch-labeling');
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setData(j);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const labelOptions: LabelOption[] = useMemo(() => {
    if (!data) return [];
    const loom: LabelOption[] = (data.loomLabels || []).map((l) => ({
      key: `loom:${l.id}`, name: l.name, color: l.color, source: 'loom', id: l.id, isMipGuid: false,
    }));
    const mip: LabelOption[] = (data.mipLabels || []).map((l) => ({
      key: `mip:${l.id}`, name: l.name, color: l.color, source: 'mip', id: l.id, isMipGuid: !!l.isMipGuid,
    }));
    return [...loom, ...mip];
  }, [data]);

  const pickedLabel = useMemo(() => labelOptions.find((l) => l.key === labelKey) || null, [labelOptions, labelKey]);

  const items = data?.items || [];
  const filtered = useMemo(() => {
    const f = q.toLowerCase().trim();
    if (!f) return items;
    return items.filter((i) =>
      i.displayName.toLowerCase().includes(f) ||
      i.itemType.toLowerCase().includes(f) ||
      i.workspaceName.toLowerCase().includes(f),
    );
  }, [items, q]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => setSelected(new Set(filtered.map((i) => i.id))), [filtered]);
  const clearSel = useCallback(() => setSelected(new Set()), []);

  async function apply() {
    if (selected.size === 0 || !pickedLabel) return;
    setApplying(true);
    setActionErr(null);
    setResults(null);
    try {
      const chosen = items.filter((i) => selected.has(i.id)).map((i) => ({ id: i.id, workspaceId: i.workspaceId }));
      const r = await fetch('/api/admin/batch-labeling', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: chosen,
          labelName: pickedLabel.name,
          labelId: pickedLabel.isMipGuid ? pickedLabel.id : undefined,
          applyToPurview: data?.purviewConfigured ? applyToPurview : false,
          applyToPowerBi: pickedLabel.isMipGuid && data?.pbiAdminConfigured ? applyToPowerBi : false,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      setResults(j.results || []);
    } catch (e: any) { setActionErr(e?.message || String(e)); }
    finally { setApplying(false); }
  }

  function reset() {
    setResults(null);
    setSelected(new Set());
  }

  const allSelected = filtered.length > 0 && filtered.every((i) => selected.has(i.id));

  const pickerColumns: LoomColumn<CatalogItem>[] = useMemo(() => [
    {
      key: 'select', label: '', width: 48, sortable: false, filterable: false,
      render: (row) => (
        <Checkbox
          checked={selected.has(row.id)}
          onChange={() => toggle(row.id)}
          aria-label={`Select ${row.displayName}`}
        />
      ),
    },
    { key: 'displayName', label: 'Name', width: 240, render: (row) => <strong>{row.displayName}</strong> },
    { key: 'itemType', label: 'Type', width: 160, filterType: 'select', render: (row) => <Badge appearance="outline">{row.itemType}</Badge> },
    { key: 'workspaceName', label: 'Workspace', width: 180 },
    {
      key: 'sensitivity', label: 'Current label', width: 150,
      render: (row) => row.sensitivity
        ? <Badge appearance="tint" color="brand">{row.sensitivity}</Badge>
        : <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>—</Caption1>,
    },
    {
      key: 'pbi', label: 'PBI linked', width: 100, sortable: false,
      getValue: (row) => (row.pbiArtifactId ? 'Yes' : 'No'),
      render: (row) => row.pbiArtifactId
        ? <Badge appearance="tint" color="informative">Yes</Badge>
        : <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>—</Caption1>,
    },
  ], [selected, toggle]);

  const resultColumns: LoomColumn<ResultRow>[] = useMemo(() => [
    { key: 'displayName', label: 'Item', width: 240, render: (r) => <strong>{r.displayName}</strong> },
    { key: 'itemType', label: 'Type', width: 150, filterType: 'select', render: (r) => r.itemType ? <Badge appearance="outline">{r.itemType}</Badge> : <Caption1>—</Caption1> },
    { key: 'cosmosStatus', label: 'Cosmos write', width: 180, getValue: (r) => r.cosmosStatus, render: (r) => statusBadge(r.cosmosStatus) },
    { key: 'purviewStatus', label: 'Purview asset', width: 180, getValue: (r) => r.purviewStatus || '', render: (r) => statusBadge(r.purviewStatus) },
    { key: 'pbiStatus', label: 'Power BI write', width: 200, getValue: (r) => r.pbiStatus || '', render: (r) => statusBadge(r.pbiStatus) },
  ], []);

  return (
    <AdminShell sectionTitle="Batch labeling">
      <Section title="About batch labeling">
        <div className={s.explainer}>
          <Info20Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0, marginTop: '2px' }} />
          <Body1 style={{ color: tokens.colorNeutralForeground2, lineHeight: 1.5 }}>
            Select multiple catalog items, pick a sensitivity label, and apply it in one action. The Cosmos
            label-assignment is <strong>always written immediately</strong> to each item. When a Microsoft Purview
            account is configured, the label is also stamped as an asset classification on the matching catalog
            asset. When you pick a <strong>Microsoft Information Protection (MIP)</strong> label and
            <code> LOOM_POWERBI_ADMIN_LABELS=true</code>, items with a linked Power BI artifact can additionally be
            labeled via the Power BI Admin <em>InformationProtection.setLabels</em> API (requires the Console UAMI to
            be a Fabric Administrator). The results grid below shows the real per-item outcome of every write.
          </Body1>
        </div>
      </Section>

      {error && <MessageBar intent="error" style={{ marginBottom: '16px' }}><MessageBarBody><MessageBarTitle>Could not load</MessageBarTitle>{error}</MessageBarBody></MessageBar>}
      {actionErr && <MessageBar intent="error" style={{ marginBottom: '16px' }}><MessageBarBody>{actionErr}</MessageBarBody></MessageBar>}

      {data && !data.mipConfigured && (
        <MessageBar intent="warning" style={{ marginBottom: '16px' }}>
          <MessageBarBody>
            <MessageBarTitle>MIP labels not configured</MessageBarTitle>
            Only Loom-native labels are available. To use real Microsoft Information Protection label GUIDs (required
            for Power BI propagation), set <code>LOOM_MIP_ENABLED=true</code> on the loom-console Container App and
            grant the Console UAMI the <code>InformationProtectionPolicy.Read.All</code> Graph AppRole.
          </MessageBarBody>
        </MessageBar>
      )}
      {data && !data.purviewConfigured && (
        <MessageBar intent="warning" style={{ marginBottom: '16px' }}>
          <MessageBarBody>
            <MessageBarTitle>Purview not configured</MessageBarTitle>
            Asset classification in Microsoft Purview is unavailable. Set <code>LOOM_PURVIEW_ACCOUNT</code> on the
            loom-console Container App and grant the Console UAMI the Data Map roles to enable it. Cosmos label
            assignments still work.
          </MessageBarBody>
        </MessageBar>
      )}

      {loading ? (
        <Spinner label="Loading catalog items and labels..." />
      ) : results ? (
        <Section
          title={`Results — ${results.length} item${results.length === 1 ? '' : 's'}`}
          actions={<Button appearance="primary" icon={<Tag24Regular />} onClick={reset}>Label more items</Button>}
        >
          <MessageBar intent="success" style={{ marginBottom: '12px' }}>
            <MessageBarBody>
              <span className={s.optRow}><CheckmarkCircle20Regular /> Applied label. Each column shows the real outcome of that backend write.</span>
            </MessageBarBody>
          </MessageBar>
          <LoomDataTable
            columns={resultColumns}
            rows={results}
            getRowId={(r) => r.id}
            ariaLabel="Batch labeling results"
            empty="No results."
          />
        </Section>
      ) : (
        <Section
          title="Select items"
          actions={
            <>
              <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
              <Button onClick={selectAll} disabled={filtered.length === 0}>Select all</Button>
              <Button onClick={clearSel} disabled={selected.size === 0}>Clear</Button>
            </>
          }
        >
          <div className={s.pickerRow}>
            <div className={s.field}>
              <Caption1>Label to apply</Caption1>
              <Dropdown
                placeholder="Choose a sensitivity label..."
                value={pickedLabel ? `${pickedLabel.name}${pickedLabel.source === 'mip' ? ' (MIP)' : ''}` : ''}
                selectedOptions={labelKey ? [labelKey] : []}
                onOptionSelect={(_, d) => setLabelKey(d.optionValue || '')}
                style={{ minWidth: '260px' }}
              >
                {labelOptions.filter((l) => l.source === 'loom').length > 0 && (
                  <>
                    {labelOptions.filter((l) => l.source === 'loom').map((l) => (
                      <Option key={l.key} value={l.key} text={l.name}>
                        <span className={s.optRow}>
                          {l.color && <span className={s.swatch} style={{ backgroundColor: l.color }} />}
                          {l.name} <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Loom</Caption1>
                        </span>
                      </Option>
                    ))}
                  </>
                )}
                {labelOptions.filter((l) => l.source === 'mip').map((l) => (
                  <Option key={l.key} value={l.key} text={l.name}>
                    <span className={s.optRow}>
                      {l.color && <span className={s.swatch} style={{ backgroundColor: l.color }} />}
                      {l.name} <Caption1 style={{ color: tokens.colorBrandForeground1 }}>MIP</Caption1>
                    </span>
                  </Option>
                ))}
              </Dropdown>
            </div>
            <Button
              appearance="primary"
              icon={<Tag24Regular />}
              disabled={selected.size === 0 || !pickedLabel || applying}
              onClick={apply}
            >
              {applying ? 'Applying...' : `Apply to ${selected.size} item${selected.size === 1 ? '' : 's'}`}
            </Button>
          </div>

          {pickedLabel && (
            <div className={s.opts}>
              {data?.purviewConfigured && (
                <Checkbox
                  checked={applyToPurview}
                  onChange={(_, d) => setApplyToPurview(!!d.checked)}
                  label="Also stamp the label as a Microsoft Purview asset classification (matched by item name)"
                />
              )}
              {data?.pbiAdminConfigured && pickedLabel.isMipGuid && (
                <Checkbox
                  checked={applyToPowerBi}
                  onChange={(_, d) => setApplyToPowerBi(!!d.checked)}
                  label="Also write the label to Power BI (Admin InformationProtection.setLabels — requires Console UAMI = Fabric Administrator)"
                />
              )}
              {pickedLabel.source === 'loom' && data?.pbiAdminConfigured && (
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Power BI propagation requires a MIP label (real GUID). Loom-native labels write to Cosmos{data?.purviewConfigured ? ' and Purview' : ''} only.
                </Caption1>
              )}
            </div>
          )}

          <Divider style={{ margin: `${tokens.spacingVerticalM} 0` }} />

          <Toolbar search={q} onSearch={setQ} searchPlaceholder="Search items by name, type, workspace..." />
          <Caption1 style={{ display: 'block', marginBottom: '8px', color: tokens.colorNeutralForeground2 }}>
            {selected.size} of {items.length} selected{allSelected && filtered.length ? ' (all shown)' : ''}
          </Caption1>
          <LoomDataTable
            columns={pickerColumns}
            rows={filtered}
            getRowId={(i) => i.id}
            ariaLabel="Catalog items"
            empty={q ? `No items match "${q}".` : 'No catalog items found in your workspaces.'}
          />
        </Section>
      )}
    </AdminShell>
  );
}
