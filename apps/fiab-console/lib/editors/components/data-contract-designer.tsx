'use client';

/**
 * DataContractDesigner — the data product's formal contract, built with a
 * designer (schema grid + SLO panel + quality-expectation grid), never a JSON
 * textarea (.claude/rules/loom_no_freeform_config.md). Three exports:
 *
 *   • DataContractDesigner  — CONTROLLED editor ({ value, onChange }). Used by
 *     both the create wizard's "Data contract" step and the studio tab.
 *   • DataContractStudioTab — loads the contract from GET /api/data-products/[id]
 *     (product.contract), edits locally, and SAVES via
 *     PATCH /api/data-products/[id] { contract }. Real Cosmos backend
 *     (no-vaporware.md). Azure-native — no Fabric/Power BI dependency.
 *   • DataContractSummary   — read-only compact view for the details page.
 *
 * Web-3 look: Fluent v9 + Loom tokens, elevated cards, section icons, real
 * tables with padding. No raw px / hex — spacing/colour tokens only (web3-ui).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Badge, Body1, Button, Caption1, Card, CardHeader, Dropdown, Field, Input, Option,
  Spinner, Subtitle2, Switch,
  Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, DocumentBulletList20Regular, Save20Regular,
  ShieldCheckmark20Regular, Timer20Regular, Table20Regular,
} from '@fluentui/react-icons';
import {
  CONTRACT_COLUMN_TYPES, CONTRACT_CLASSIFICATIONS, QUALITY_RULES, QUALITY_SEVERITIES,
  SLO_FRESHNESS, SLO_AVAILABILITY, SLO_SUPPORT_RESPONSE, SLO_RETENTION,
  EMPTY_CONTRACT, contractStats,
  type DataContract, type ContractColumn, type QualityExpectation,
} from '@/lib/dataproducts/contract';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  card: {
    padding: tokens.spacingHorizontalL, minWidth: 0,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    transition: 'box-shadow 0.15s ease, transform 0.15s ease',
    ':hover': { boxShadow: tokens.shadow8 },
  },
  col: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  sloGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: tokens.spacingHorizontalL, rowGap: tokens.spacingVerticalM,
  },
  scroll: { overflowX: 'auto', maxWidth: '100%' },
  nameInput: { minWidth: '140px' },
  typeCell: { minWidth: '150px' },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  version: { maxWidth: '160px' },
  hint: { color: tokens.colorNeutralForeground3 },
});

// ---------------------------------------------------------------------------
// Controlled designer
// ---------------------------------------------------------------------------

export function DataContractDesigner({
  value, onChange,
}: {
  value: DataContract;
  onChange: (next: DataContract) => void;
}) {
  const s = useStyles();
  const schema = value.schema ?? [];
  const quality = value.quality ?? [];
  const slo = value.slo ?? {};

  const setSchema = (next: ContractColumn[]) => onChange({ ...value, schema: next });
  const setQuality = (next: QualityExpectation[]) => onChange({ ...value, quality: next });
  const setSlo = (patch: Partial<NonNullable<DataContract['slo']>>) => onChange({ ...value, slo: { ...slo, ...patch } });

  const addColumn = () => setSchema([...schema, { name: '', type: 'string' }]);
  const patchColumn = (idx: number, patch: Partial<ContractColumn>) =>
    setSchema(schema.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  const removeColumn = (idx: number) => setSchema(schema.filter((_, i) => i !== idx));

  const addExpectation = () =>
    setQuality([...quality, { id: crypto.randomUUID(), rule: 'not_null', severity: 'error' }]);
  const patchExpectation = (idx: number, patch: Partial<QualityExpectation>) =>
    setQuality(quality.map((q, i) => (i === idx ? { ...q, ...patch } : q)));
  const removeExpectation = (idx: number) => setQuality(quality.filter((_, i) => i !== idx));

  const columnNames = useMemo(() => schema.map((c) => c.name).filter(Boolean), [schema]);

  return (
    <div className={s.root}>
      {/* Contract version */}
      <div className={s.toolbar}>
        <DocumentBulletList20Regular />
        <Subtitle2>Data contract</Subtitle2>
        <div className={s.spacer} />
        <Field label="Version" orientation="horizontal">
          <Input
            className={s.version}
            value={value.version ?? ''}
            onChange={(_, d) => onChange({ ...value, version: d.value })}
            placeholder="1.0.0"
          />
        </Field>
      </div>
      <Caption1 className={s.hint}>
        The commitment this data product makes to its consumers — the output-port schema, its
        service-level objectives, and the data-quality expectations it enforces. Everything is picked
        from typed controls; nothing is free-typed JSON.
      </Caption1>

      {/* ── Schema ─────────────────────────────────────────────────────── */}
      <Card className={s.card}>
        <CardHeader
          image={<Table20Regular />}
          header={<Subtitle2>Output schema</Subtitle2>}
          description={<Caption1 className={s.hint}>Columns the product guarantees — name, type, semantics, sensitivity.</Caption1>}
          action={<Button size="small" appearance="primary" icon={<Add20Regular />} onClick={addColumn}>Add column</Button>}
        />
        {schema.length === 0 ? (
          <Caption1 className={s.hint}>No columns defined yet. Click <strong>Add column</strong> to describe the product&apos;s output.</Caption1>
        ) : (
          <div className={s.scroll}>
            <Table size="small" aria-label="Contract schema">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Column</TableHeaderCell>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>Description</TableHeaderCell>
                  <TableHeaderCell>Classification</TableHeaderCell>
                  <TableHeaderCell>Nullable</TableHeaderCell>
                  <TableHeaderCell>Key</TableHeaderCell>
                  <TableHeaderCell />
                </TableRow>
              </TableHeader>
              <TableBody>
                {schema.map((c, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Input className={s.nameInput} value={c.name} placeholder="column_name"
                        onChange={(_, d) => patchColumn(i, { name: d.value })} aria-label="Column name" />
                    </TableCell>
                    <TableCell className={s.typeCell}>
                      <Dropdown
                        value={c.type} selectedOptions={[c.type]}
                        onOptionSelect={(_, d) => d.optionValue && patchColumn(i, { type: d.optionValue as ContractColumn['type'] })}
                        aria-label="Column type"
                      >
                        {CONTRACT_COLUMN_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
                      </Dropdown>
                    </TableCell>
                    <TableCell>
                      <Input value={c.description ?? ''} placeholder="What this column represents"
                        onChange={(_, d) => patchColumn(i, { description: d.value })} aria-label="Column description" />
                    </TableCell>
                    <TableCell className={s.typeCell}>
                      <Dropdown
                        placeholder="None"
                        value={c.classification ?? 'None'}
                        selectedOptions={[c.classification ?? 'None']}
                        onOptionSelect={(_, d) => patchColumn(i, { classification: (d.optionValue === 'None' ? undefined : d.optionValue) as ContractColumn['classification'] })}
                        aria-label="Column classification"
                      >
                        {CONTRACT_CLASSIFICATIONS.map((cl) => <Option key={cl} value={cl}>{cl}</Option>)}
                      </Dropdown>
                    </TableCell>
                    <TableCell>
                      <Switch checked={!!c.nullable} onChange={(_, d) => patchColumn(i, { nullable: d.checked })} aria-label="Nullable" />
                    </TableCell>
                    <TableCell>
                      <Switch checked={!!c.primaryKey} onChange={(_, d) => patchColumn(i, { primaryKey: d.checked })} aria-label="Primary key" />
                    </TableCell>
                    <TableCell>
                      <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Remove column ${c.name || i + 1}`} onClick={() => removeColumn(i)} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {/* ── SLOs ───────────────────────────────────────────────────────── */}
      <Card className={s.card}>
        <CardHeader
          image={<Timer20Regular />}
          header={<Subtitle2>Service-level objectives</Subtitle2>}
          description={<Caption1 className={s.hint}>The quantified freshness, availability, and support the product commits to.</Caption1>}
        />
        <div className={s.sloGrid}>
          <Field label="Freshness">
            <Dropdown placeholder="Select cadence" value={slo.freshness ?? ''} selectedOptions={slo.freshness ? [slo.freshness] : []}
              onOptionSelect={(_, d) => setSlo({ freshness: d.optionValue })}>
              {SLO_FRESHNESS.map((f) => <Option key={f} value={f}>{f}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Availability">
            <Dropdown placeholder="Select target" value={slo.availability ?? ''} selectedOptions={slo.availability ? [slo.availability] : []}
              onOptionSelect={(_, d) => setSlo({ availability: d.optionValue })}>
              {SLO_AVAILABILITY.map((a) => <Option key={a} value={a}>{a}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Latency (P95)" hint="e.g. 200 ms">
            <Input value={slo.latencyP95 ?? ''} placeholder="200 ms" onChange={(_, d) => setSlo({ latencyP95: d.value })} />
          </Field>
          <Field label="Completeness" hint="Min % of expected rows">
            <Input value={slo.completeness ?? ''} placeholder="99.5%" onChange={(_, d) => setSlo({ completeness: d.value })} />
          </Field>
          <Field label="Retention">
            <Dropdown placeholder="Select window" value={slo.retention ?? ''} selectedOptions={slo.retention ? [slo.retention] : []}
              onOptionSelect={(_, d) => setSlo({ retention: d.optionValue })}>
              {SLO_RETENTION.map((r) => <Option key={r} value={r}>{r}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Support response">
            <Dropdown placeholder="Select SLA" value={slo.supportResponse ?? ''} selectedOptions={slo.supportResponse ? [slo.supportResponse] : []}
              onOptionSelect={(_, d) => setSlo({ supportResponse: d.optionValue })}>
              {SLO_SUPPORT_RESPONSE.map((r) => <Option key={r} value={r}>{r}</Option>)}
            </Dropdown>
          </Field>
        </div>
      </Card>

      {/* ── Quality expectations ───────────────────────────────────────── */}
      <Card className={s.card}>
        <CardHeader
          image={<ShieldCheckmark20Regular />}
          header={<Subtitle2>Data-quality expectations</Subtitle2>}
          description={<Caption1 className={s.hint}>Checks the product commits to enforce — bound to a column or the whole table.</Caption1>}
          action={<Button size="small" appearance="primary" icon={<Add20Regular />} onClick={addExpectation}>Add expectation</Button>}
        />
        {quality.length === 0 ? (
          <Caption1 className={s.hint}>No expectations defined yet. Add one to state a data-quality guarantee (e.g. a not-null key).</Caption1>
        ) : (
          <div className={s.scroll}>
            <Table size="small" aria-label="Quality expectations">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Column</TableHeaderCell>
                  <TableHeaderCell>Rule</TableHeaderCell>
                  <TableHeaderCell>Value</TableHeaderCell>
                  <TableHeaderCell>Severity</TableHeaderCell>
                  <TableHeaderCell />
                </TableRow>
              </TableHeader>
              <TableBody>
                {quality.map((q, i) => {
                  const ruleDef = QUALITY_RULES.find((r) => r.value === q.rule);
                  return (
                    <TableRow key={q.id}>
                      <TableCell className={s.typeCell}>
                        <Dropdown
                          placeholder="Table-level"
                          value={q.column || '(whole table)'}
                          selectedOptions={[q.column || '']}
                          onOptionSelect={(_, d) => patchExpectation(i, { column: d.optionValue || undefined })}
                          aria-label="Expectation column"
                        >
                          <Option value="" text="(whole table)">(whole table)</Option>
                          {columnNames.map((n) => <Option key={n} value={n}>{n}</Option>)}
                        </Dropdown>
                      </TableCell>
                      <TableCell className={s.typeCell}>
                        <Dropdown
                          value={ruleDef?.label ?? q.rule}
                          selectedOptions={[q.rule]}
                          onOptionSelect={(_, d) => d.optionValue && patchExpectation(i, { rule: d.optionValue })}
                          aria-label="Expectation rule"
                        >
                          {QUALITY_RULES.map((r) => <Option key={r.value} value={r.value} text={r.label}>{r.label}</Option>)}
                        </Dropdown>
                      </TableCell>
                      <TableCell>
                        {ruleDef?.needsValue ? (
                          <Input value={q.value ?? ''} placeholder="value" onChange={(_, d) => patchExpectation(i, { value: d.value })} aria-label="Expectation value" />
                        ) : (
                          <Caption1 className={s.hint}>—</Caption1>
                        )}
                      </TableCell>
                      <TableCell className={s.typeCell}>
                        <Dropdown
                          value={q.severity}
                          selectedOptions={[q.severity]}
                          onOptionSelect={(_, d) => d.optionValue && patchExpectation(i, { severity: d.optionValue as QualityExpectation['severity'] })}
                          aria-label="Expectation severity"
                        >
                          {QUALITY_SEVERITIES.map((sev) => <Option key={sev} value={sev}>{sev}</Option>)}
                        </Dropdown>
                      </TableCell>
                      <TableCell>
                        <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Remove expectation ${i + 1}`} onClick={() => removeExpectation(i)} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Studio tab — load + save the contract for a persisted product
// ---------------------------------------------------------------------------

export function DataContractStudioTab({ id }: { id: string }) {
  const s = useStyles();
  const [contract, setContract] = useState<DataContract>(EMPTY_CONTRACT);
  const [loading, setLoading] = useState(id !== 'new');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (id === 'new') { setLoading(false); return; }
    setLoading(true); setLoadErr(null);
    try {
      const r = await clientFetch(`/api/data-products/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!j.ok) { setLoadErr(j.error || `HTTP ${r.status}`); return; }
      const c = (j.product?.contract ?? null) as DataContract | null;
      setContract(c && typeof c === 'object' ? { ...EMPTY_CONTRACT, ...c } : EMPTY_CONTRACT);
      setDirty(false);
    } catch (e: any) {
      setLoadErr(e?.message || String(e));
    } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const onChange = useCallback((next: DataContract) => { setContract(next); setDirty(true); setMsg(null); }, []);

  const save = useCallback(async () => {
    setSaving(true); setMsg(null);
    try {
      const r = await clientFetch(`/api/data-products/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contract }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { setMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      const saved = (j.product?.contract ?? contract) as DataContract;
      setContract({ ...EMPTY_CONTRACT, ...saved });
      setDirty(false);
      setMsg({ intent: 'success', text: 'Data contract saved.' });
    } catch (e: any) {
      setMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setSaving(false); }
  }, [id, contract]);

  if (id === 'new') {
    return (
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Save the data product first</MessageBarTitle>
          The data contract attaches to a persisted data product. Create it (Save on the Overview tab), then define its contract here — or fill it in during the create wizard&apos;s Data contract step.
        </MessageBarBody>
      </MessageBar>
    );
  }
  if (loading) return <Spinner label="Loading data contract…" />;

  const stats = contractStats(contract);
  return (
    <div className={s.col}>
      {loadErr && <MessageBar intent="error"><MessageBarBody>{loadErr}</MessageBarBody></MessageBar>}
      <div className={s.toolbar}>
        <Badge appearance="tint" color="brand">{stats.columns} column{stats.columns === 1 ? '' : 's'}</Badge>
        <Badge appearance="tint" color="informative">{stats.slos} SLO{stats.slos === 1 ? '' : 's'}</Badge>
        <Badge appearance="tint" color="success">{stats.expectations} expectation{stats.expectations === 1 ? '' : 's'}</Badge>
        {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
        <div className={s.spacer} />
        <Button appearance="primary" icon={saving ? <Spinner size="tiny" /> : <Save20Regular />} disabled={saving || !dirty} onClick={save}>
          {saving ? 'Saving…' : 'Save contract'}
        </Button>
      </div>
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
      <DataContractDesigner value={contract} onChange={onChange} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read-only summary — details page
// ---------------------------------------------------------------------------

export function DataContractSummary({ contract }: { contract?: DataContract | null }) {
  const s = useStyles();
  const stats = contractStats(contract);
  if (!stats.defined) {
    return <Caption1 className={s.hint}>No data contract defined. The owner can add a schema, SLOs, and quality expectations in the studio.</Caption1>;
  }
  const schema = contract?.schema ?? [];
  const slo = contract?.slo ?? {};
  const quality = contract?.quality ?? [];
  const sloRows: Array<[string, string | undefined]> = [
    ['Freshness', slo.freshness], ['Availability', slo.availability], ['Latency (P95)', slo.latencyP95],
    ['Completeness', slo.completeness], ['Retention', slo.retention], ['Support response', slo.supportResponse],
  ];
  return (
    <div className={s.col}>
      <div className={s.sectionHead}>
        {contract?.version && <Badge appearance="outline">v{contract.version}</Badge>}
        <Badge appearance="tint" color="brand">{stats.columns} column{stats.columns === 1 ? '' : 's'}</Badge>
        <Badge appearance="tint" color="informative">{stats.slos} SLO{stats.slos === 1 ? '' : 's'}</Badge>
        <Badge appearance="tint" color="success">{stats.expectations} expectation{stats.expectations === 1 ? '' : 's'}</Badge>
      </div>

      {schema.length > 0 && (
        <>
          <Subtitle2>Schema</Subtitle2>
          <div className={s.scroll}>
            <Table size="small" aria-label="Contract schema">
              <TableHeader><TableRow>
                <TableHeaderCell>Column</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Description</TableHeaderCell><TableHeaderCell>Classification</TableHeaderCell>
                <TableHeaderCell>Constraints</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {schema.map((c, i) => (
                  <TableRow key={i}>
                    <TableCell><strong>{c.name}</strong></TableCell>
                    <TableCell><code>{c.type}</code></TableCell>
                    <TableCell>{c.description || <span className={s.hint}>—</span>}</TableCell>
                    <TableCell>{c.classification ? <Badge appearance="outline" color="warning">{c.classification}</Badge> : <span className={s.hint}>—</span>}</TableCell>
                    <TableCell>
                      {c.primaryKey && <Badge appearance="tint" color="brand">key</Badge>}{' '}
                      {c.nullable ? <Caption1 className={s.hint}>nullable</Caption1> : <Caption1 className={s.hint}>not null</Caption1>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {stats.slos > 0 && (
        <>
          <Subtitle2>Service-level objectives</Subtitle2>
          <div className={s.sloGrid}>
            {sloRows.filter(([, v]) => !!v).map(([k, v]) => (
              <div key={k}><Caption1 className={s.hint}>{k}</Caption1><Body1>{v}</Body1></div>
            ))}
          </div>
        </>
      )}

      {quality.length > 0 && (
        <>
          <Subtitle2>Quality expectations</Subtitle2>
          <div className={s.scroll}>
            <Table size="small" aria-label="Quality expectations">
              <TableHeader><TableRow>
                <TableHeaderCell>Target</TableHeaderCell><TableHeaderCell>Rule</TableHeaderCell>
                <TableHeaderCell>Value</TableHeaderCell><TableHeaderCell>Severity</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {quality.map((q) => {
                  const ruleDef = QUALITY_RULES.find((r) => r.value === q.rule);
                  return (
                    <TableRow key={q.id}>
                      <TableCell>{q.column || <Caption1 className={s.hint}>whole table</Caption1>}</TableCell>
                      <TableCell>{ruleDef?.label ?? q.rule}</TableCell>
                      <TableCell>{q.value || <span className={s.hint}>—</span>}</TableCell>
                      <TableCell><Badge appearance="filled" color={q.severity === 'error' ? 'danger' : 'warning'}>{q.severity}</Badge></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
