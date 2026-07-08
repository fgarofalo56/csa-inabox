'use client';

/**
 * AI Search index-designer sections (AIF-16) — visual, non-JSON authoring of
 * scoring profiles, custom analyzers, CORS options, and the customer-managed
 * encryption key. Each writes into the SAME PUT /indexes/{name} the field grid
 * uses (via applyDesignerSections, which preserves fields/vector/semantic), so
 * these replace the raw-JSON-only path for these sections.
 *
 * Real backend: every Save issues `fetch(indexBase, { method:'PUT', body:{definition} })`
 * → the AI Search data-plane. No mocks.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Button, Caption1, Input, Dropdown, Option, Checkbox, Field, Badge,
  Subtitle2, MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add16Regular, Dismiss16Regular } from '@fluentui/react-icons';
import {
  type ScoringProfileRow, type ScoringFunctionType, type CustomAnalyzerRow,
  type CorsOptionsRow, type EncryptionKeyRow,
  SCORING_FUNCTION_TYPES, INTERPOLATIONS, FUNCTION_AGGREGATIONS,
  BUILTIN_TOKENIZERS, BUILTIN_TOKEN_FILTERS, BUILTIN_CHAR_FILTERS, BUILTIN_ANALYZERS,
  emptyScoringProfile, defaultScoringFunction, buildScoringProfiles, parseScoringProfiles,
  emptyCustomAnalyzer, buildCustomAnalyzers, parseCustomAnalyzers,
  buildCorsOptions, parseCorsOptions, buildEncryptionKey, parseEncryptionKey,
  applyDesignerSections,
} from '@/lib/azure/search-index-designers';

const useStyles = makeStyles({
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalM,
    marginTop: tokens.spacingVerticalM,
    background: tokens.colorNeutralBackground1,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
  },
  sub: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalM,
    background: tokens.colorNeutralBackground2,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
  },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  spacer: { flex: 1 },
  row: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  cell: { minWidth: '140px', flex: 1 },
  narrow: { minWidth: '110px' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalXS },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', marginTop: tokens.spacingVerticalS },
  grid2: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: tokens.spacingHorizontalM, alignItems: 'center' },
});

async function putIndex(indexBase: string, definition: any): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(indexBase, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ definition }) });
  const ct = r.headers.get('content-type') || '';
  const j = ct.includes('json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
  return { ok: !!j.ok, error: j.error };
}

interface DesignerProps { idx: any; indexBase: string; onSaved: () => void; }

function weightableFieldNames(idx: any): string[] {
  return Array.isArray(idx?.fields)
    ? idx.fields.filter((f: any) => f?.searchable && /Edm\.String/.test(f?.type || '')).map((f: any) => f.name)
    : [];
}
function numericOrDateFieldNames(idx: any): string[] {
  return Array.isArray(idx?.fields)
    ? idx.fields.filter((f: any) => /Edm\.(Int32|Int64|Double|DateTimeOffset|GeographyPoint)/.test(f?.type || '')).map((f: any) => f.name)
    : [];
}

// ===========================================================================
// Scoring profiles
// ===========================================================================
export function ScoringProfilesDesigner({ idx, indexBase, onSaved }: DesignerProps) {
  const s = useStyles();
  const [rows, setRows] = useState<ScoringProfileRow[]>([]);
  const [defaultProfile, setDefaultProfile] = useState<string>('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    setRows(parseScoringProfiles(idx));
    setDefaultProfile(idx?.defaultScoringProfile || '');
    setDirty(false); setMsg(null);
  }, [idx]);

  const weightFields = useMemo(() => weightableFieldNames(idx), [idx]);
  const functionFields = useMemo(() => numericOrDateFieldNames(idx), [idx]);

  const patch = (i: number, p: Partial<ScoringProfileRow>) => { setRows((r) => r.map((x, n) => (n === i ? { ...x, ...p } : x))); setDirty(true); };
  const addProfile = () => { setRows((r) => [...r, emptyScoringProfile()]); setDirty(true); };
  const removeProfile = (i: number) => { setRows((r) => r.filter((_, n) => n !== i)); setDirty(true); };

  const save = async () => {
    setSaving(true); setMsg(null);
    const built = buildScoringProfiles(rows);
    const names = built.map((p) => p.name);
    const definition = applyDesignerSections(idx, {
      scoringProfiles: built,
      defaultScoringProfile: defaultProfile && names.includes(defaultProfile) ? defaultProfile : null,
    });
    const { ok, error } = await putIndex(indexBase, definition);
    setSaving(false);
    if (!ok) { setMsg({ intent: 'error', text: error || 'Save failed' }); return; }
    setMsg({ intent: 'success', text: 'Scoring profiles saved (PUT /indexes).' }); setDirty(false); onSaved();
  };

  return (
    <div className={s.card}>
      <div className={s.head}>
        <Subtitle2>Scoring profiles ({rows.length})</Subtitle2>
        <div className={s.spacer} />
        <Button size="small" icon={<Add16Regular />} onClick={addProfile}>Add profile</Button>
      </div>
      <Caption1>Boost relevance with per-field text weights and magnitude / freshness / distance / tag functions. Saved into <code>scoringProfiles[]</code> and applied at query time via the Search tab&apos;s scoring-profile picker.</Caption1>
      {rows.length === 0 && <Caption1>No scoring profiles — documents rank by the default BM25 score.</Caption1>}
      {rows.map((p, i) => (
        <div key={i} className={s.sub}>
          <div className={s.row}>
            <Field label="Profile name" className={s.cell}>
              <Input size="small" value={p.name} placeholder="boost-recent" aria-label={`sp-${i}-name`} onChange={(_, d) => patch(i, { name: d.value })} />
            </Field>
            <Field label="Function aggregation" className={s.narrow}>
              <Dropdown size="small" value={p.functionAggregation} selectedOptions={[p.functionAggregation]} aria-label={`sp-${i}-agg`}
                onOptionSelect={(_, d) => d.optionValue && patch(i, { functionAggregation: d.optionValue as ScoringProfileRow['functionAggregation'] })}>
                {FUNCTION_AGGREGATIONS.map((a) => (<Option key={a} value={a}>{a}</Option>))}
              </Dropdown>
            </Field>
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`sp-${i}-remove`} onClick={() => removeProfile(i)} />
          </div>

          {/* Weights */}
          <div className={s.head}><Caption1><strong>Text weights</strong></Caption1><div className={s.spacer} />
            <Button size="small" appearance="subtle" icon={<Add16Regular />} onClick={() => patch(i, { weights: [...p.weights, { fieldName: weightFields[0] || '', weight: 1 }] })}>Add weight</Button>
          </div>
          {p.weights.map((w, wi) => (
            <div key={wi} className={s.row}>
              <Field label="Field" className={s.cell}>
                <Dropdown size="small" value={w.fieldName} selectedOptions={w.fieldName ? [w.fieldName] : []} placeholder="searchable string field" aria-label={`sp-${i}-w-${wi}-field`}
                  onOptionSelect={(_, d) => d.optionValue && patch(i, { weights: p.weights.map((x, n) => (n === wi ? { ...x, fieldName: d.optionValue! } : x)) })}>
                  {weightFields.map((f) => (<Option key={f} value={f}>{f}</Option>))}
                </Dropdown>
              </Field>
              <Field label="Weight" className={s.narrow}>
                <Input size="small" type="number" value={String(w.weight)} aria-label={`sp-${i}-w-${wi}-weight`}
                  onChange={(_, d) => patch(i, { weights: p.weights.map((x, n) => (n === wi ? { ...x, weight: Number(d.value) || 1 } : x)) })} />
              </Field>
              <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`sp-${i}-w-${wi}-remove`} onClick={() => patch(i, { weights: p.weights.filter((_, n) => n !== wi) })} />
            </div>
          ))}

          {/* Functions */}
          <div className={s.head}><Caption1><strong>Functions</strong></Caption1><div className={s.spacer} />
            <Dropdown size="small" placeholder="Add function…" selectedOptions={[]} aria-label={`sp-${i}-add-fn`}
              onOptionSelect={(_, d) => d.optionValue && patch(i, { functions: [...p.functions, defaultScoringFunction(d.optionValue as ScoringFunctionType)] })}>
              {SCORING_FUNCTION_TYPES.map((t) => (<Option key={t} value={t}>{t}</Option>))}
            </Dropdown>
          </div>
          {p.functions.map((fn, fi) => {
            const setFn = (pp: Partial<typeof fn>) => patch(i, { functions: p.functions.map((x, n) => (n === fi ? { ...x, ...pp } : x)) });
            return (
              <div key={fi} className={s.row}>
                <Badge appearance="tint" color="brand">{fn.type}</Badge>
                <Field label="Field" className={s.cell}>
                  <Dropdown size="small" value={fn.fieldName} selectedOptions={fn.fieldName ? [fn.fieldName] : []} placeholder="numeric / date / geo field" aria-label={`sp-${i}-fn-${fi}-field`}
                    onOptionSelect={(_, d) => d.optionValue && setFn({ fieldName: d.optionValue })}>
                    {functionFields.map((f) => (<Option key={f} value={f}>{f}</Option>))}
                  </Dropdown>
                </Field>
                <Field label="Boost" className={s.narrow}>
                  <Input size="small" type="number" value={String(fn.boost)} aria-label={`sp-${i}-fn-${fi}-boost`} onChange={(_, d) => setFn({ boost: Number(d.value) || 1 })} />
                </Field>
                <Field label="Interpolation" className={s.narrow}>
                  <Dropdown size="small" value={fn.interpolation} selectedOptions={[fn.interpolation]} aria-label={`sp-${i}-fn-${fi}-interp`}
                    onOptionSelect={(_, d) => d.optionValue && setFn({ interpolation: d.optionValue as typeof fn.interpolation })}>
                    {INTERPOLATIONS.map((x) => (<Option key={x} value={x}>{x}</Option>))}
                  </Dropdown>
                </Field>
                {fn.type === 'magnitude' && (
                  <>
                    <Field label="Range start" className={s.narrow}><Input size="small" type="number" value={String(fn.boostingRangeStart ?? 0)} aria-label={`sp-${i}-fn-${fi}-start`} onChange={(_, d) => setFn({ boostingRangeStart: Number(d.value) || 0 })} /></Field>
                    <Field label="Range end" className={s.narrow}><Input size="small" type="number" value={String(fn.boostingRangeEnd ?? 100)} aria-label={`sp-${i}-fn-${fi}-end`} onChange={(_, d) => setFn({ boostingRangeEnd: Number(d.value) || 0 })} /></Field>
                  </>
                )}
                {fn.type === 'freshness' && (
                  <Field label="Boosting duration (ISO)" className={s.cell}><Input size="small" value={fn.boostingDuration || 'P365D'} placeholder="P365D" aria-label={`sp-${i}-fn-${fi}-dur`} onChange={(_, d) => setFn({ boostingDuration: d.value })} /></Field>
                )}
                {fn.type === 'distance' && (
                  <>
                    <Field label="Ref-point param" className={s.narrow}><Input size="small" value={fn.referencePointParameter || 'mylocation'} aria-label={`sp-${i}-fn-${fi}-ref`} onChange={(_, d) => setFn({ referencePointParameter: d.value })} /></Field>
                    <Field label="Boosting distance (km)" className={s.narrow}><Input size="small" type="number" value={String(fn.boostingDistance ?? 100)} aria-label={`sp-${i}-fn-${fi}-dist`} onChange={(_, d) => setFn({ boostingDistance: Number(d.value) || 0 })} /></Field>
                  </>
                )}
                {fn.type === 'tag' && (
                  <Field label="Tags param" className={s.narrow}><Input size="small" value={fn.tagsParameter || 'tags'} aria-label={`sp-${i}-fn-${fi}-tag`} onChange={(_, d) => setFn({ tagsParameter: d.value })} /></Field>
                )}
                <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`sp-${i}-fn-${fi}-remove`} onClick={() => patch(i, { functions: p.functions.filter((_, n) => n !== fi) })} />
              </div>
            );
          })}
        </div>
      ))}
      {rows.length > 0 && (
        <Field label="Default scoring profile (applied when a query names none)">
          <Dropdown value={defaultProfile || '(none)'} selectedOptions={defaultProfile ? [defaultProfile] : ['(none)']} aria-label="default-scoring-profile"
            onOptionSelect={(_, d) => { setDefaultProfile(d.optionValue === '(none)' ? '' : (d.optionValue || '')); setDirty(true); }}>
            <Option value="(none)">(none — BM25 default)</Option>
            {rows.filter((r) => r.name.trim()).map((r) => (<Option key={r.name} value={r.name}>{r.name}</Option>))}
          </Dropdown>
        </Field>
      )}
      <div className={s.actions}>
        <Button appearance="primary" disabled={saving || !dirty} onClick={save}>{saving ? 'Saving…' : 'Save scoring profiles'}</Button>
        {dirty && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>Unsaved changes</Caption1>}
      </div>
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
    </div>
  );
}

// ===========================================================================
// Analyzers (built-in picker reference + custom analyzer builder)
// ===========================================================================
export function AnalyzersDesigner({ idx, indexBase, onSaved }: DesignerProps) {
  const s = useStyles();
  const [rows, setRows] = useState<CustomAnalyzerRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => { setRows(parseCustomAnalyzers(idx)); setDirty(false); setMsg(null); }, [idx]);

  const patch = (i: number, p: Partial<CustomAnalyzerRow>) => { setRows((r) => r.map((x, n) => (n === i ? { ...x, ...p } : x))); setDirty(true); };
  const add = () => { setRows((r) => [...r, emptyCustomAnalyzer()]); setDirty(true); };
  const remove = (i: number) => { setRows((r) => r.filter((_, n) => n !== i)); setDirty(true); };
  const toggleFilter = (i: number, kind: 'tokenFilters' | 'charFilters', val: string) => {
    const cur = rows[i][kind];
    patch(i, { [kind]: cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val] } as Partial<CustomAnalyzerRow>);
  };

  const save = async () => {
    setSaving(true); setMsg(null);
    const definition = applyDesignerSections(idx, { analyzers: buildCustomAnalyzers(rows) });
    const { ok, error } = await putIndex(indexBase, definition);
    setSaving(false);
    if (!ok) { setMsg({ intent: 'error', text: error || 'Save failed' }); return; }
    setMsg({ intent: 'success', text: 'Custom analyzers saved (PUT /indexes).' }); setDirty(false); onSaved();
  };

  return (
    <div className={s.card}>
      <div className={s.head}>
        <Subtitle2>Analyzers ({rows.length} custom)</Subtitle2>
        <div className={s.spacer} />
        <Button size="small" icon={<Add16Regular />} onClick={add}>Add custom analyzer</Button>
      </div>
      <Caption1>
        Built-in analyzers you can pick per field (Schema grid): {BUILTIN_ANALYZERS.map((a) => <Badge key={a} appearance="tint" style={{ marginRight: tokens.spacingHorizontalXS }}>{a}</Badge>)}
      </Caption1>
      <Caption1>Build a custom analyzer from a tokenizer + char/token filters, then reference its name from a field&apos;s analyzer dropdown. Saved into <code>analyzers[]</code>.</Caption1>
      {rows.length === 0 && <Caption1>No custom analyzers.</Caption1>}
      {rows.map((a, i) => (
        <div key={i} className={s.sub}>
          <div className={s.row}>
            <Field label="Analyzer name" className={s.cell}>
              <Input size="small" value={a.name} placeholder="my-text-analyzer" aria-label={`an-${i}-name`} onChange={(_, d) => patch(i, { name: d.value })} />
            </Field>
            <Field label="Tokenizer" className={s.cell}>
              <Dropdown size="small" value={a.tokenizer} selectedOptions={[a.tokenizer]} aria-label={`an-${i}-tokenizer`}
                onOptionSelect={(_, d) => d.optionValue && patch(i, { tokenizer: d.optionValue })}>
                {BUILTIN_TOKENIZERS.map((t) => (<Option key={t} value={t}>{t}</Option>))}
              </Dropdown>
            </Field>
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`an-${i}-remove`} onClick={() => remove(i)} />
          </div>
          <Caption1><strong>Token filters</strong></Caption1>
          <div className={s.chips}>
            {BUILTIN_TOKEN_FILTERS.map((tf) => (
              <Checkbox key={tf} label={tf} checked={a.tokenFilters.includes(tf)} aria-label={`an-${i}-tf-${tf}`} onChange={() => toggleFilter(i, 'tokenFilters', tf)} />
            ))}
          </div>
          <Caption1><strong>Char filters</strong></Caption1>
          <div className={s.chips}>
            {BUILTIN_CHAR_FILTERS.map((cf) => (
              <Checkbox key={cf} label={cf} checked={a.charFilters.includes(cf)} aria-label={`an-${i}-cf-${cf}`} onChange={() => toggleFilter(i, 'charFilters', cf)} />
            ))}
          </div>
        </div>
      ))}
      <div className={s.actions}>
        <Button appearance="primary" disabled={saving || !dirty} onClick={save}>{saving ? 'Saving…' : 'Save analyzers'}</Button>
        {dirty && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>Unsaved changes</Caption1>}
      </div>
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
    </div>
  );
}

// ===========================================================================
// CORS + customer-managed encryption key
// ===========================================================================
export function CorsAndCmkDesigner({ idx, indexBase, onSaved }: DesignerProps) {
  const s = useStyles();
  const [cors, setCors] = useState<CorsOptionsRow>({ enabled: false, allowedOrigins: [] });
  const [originsText, setOriginsText] = useState('');
  const [cmk, setCmk] = useState<EncryptionKeyRow>({ enabled: false, keyVaultUri: '', keyVaultKeyName: '' });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    const c = parseCorsOptions(idx);
    setCors(c); setOriginsText(c.allowedOrigins.join(', '));
    setCmk(parseEncryptionKey(idx));
    setDirty(false); setMsg(null);
  }, [idx]);

  const patchCors = (p: Partial<CorsOptionsRow>) => { setCors((x) => ({ ...x, ...p })); setDirty(true); };
  const patchCmk = (p: Partial<EncryptionKeyRow>) => { setCmk((x) => ({ ...x, ...p })); setDirty(true); };

  const save = async () => {
    setSaving(true); setMsg(null);
    const corsRow: CorsOptionsRow = { ...cors, allowedOrigins: originsText.split(',').map((o) => o.trim()).filter(Boolean) };
    const definition = applyDesignerSections(idx, {
      corsOptions: buildCorsOptions(corsRow),
      encryptionKey: buildEncryptionKey(cmk),
    });
    const { ok, error } = await putIndex(indexBase, definition);
    setSaving(false);
    if (!ok) { setMsg({ intent: 'error', text: error || 'Save failed' }); return; }
    setMsg({ intent: 'success', text: 'CORS + encryption settings saved (PUT /indexes).' }); setDirty(false); onSaved();
  };

  return (
    <div className={s.card}>
      <Subtitle2>CORS &amp; encryption</Subtitle2>

      <div className={s.sub}>
        <Checkbox checked={cors.enabled} label="Enable CORS (allow cross-origin browser queries)" onChange={(_, d) => patchCors({ enabled: !!d.checked })} aria-label="cors-enabled" />
        {cors.enabled && (
          <>
            <Field label="Allowed origins (comma-separated, or * for all)">
              <Input value={originsText} placeholder="https://app.contoso.com, *" aria-label="cors-origins" onChange={(_, d) => { setOriginsText(d.value); setDirty(true); }} />
            </Field>
            <Field label="Max age (seconds, optional)">
              <Input type="number" value={cors.maxAgeInSeconds != null ? String(cors.maxAgeInSeconds) : ''} placeholder="300" aria-label="cors-maxage"
                onChange={(_, d) => patchCors({ maxAgeInSeconds: d.value ? Number(d.value) : undefined })} />
            </Field>
          </>
        )}
      </div>

      <div className={s.sub}>
        <Checkbox checked={cmk.enabled} label="Encrypt this index with a customer-managed key (CMK)" onChange={(_, d) => patchCmk({ enabled: !!d.checked })} aria-label="cmk-enabled" />
        {cmk.enabled && (
          <>
            <Field label="Key Vault URI">
              <Input value={cmk.keyVaultUri} placeholder="https://myvault.vault.azure.net" aria-label="cmk-uri" onChange={(_, d) => patchCmk({ keyVaultUri: d.value })} />
            </Field>
            <Field label="Key name">
              <Input value={cmk.keyVaultKeyName} placeholder="search-index-cmk" aria-label="cmk-key" onChange={(_, d) => patchCmk({ keyVaultKeyName: d.value })} />
            </Field>
            <Field label="Key version (optional — omit to track the latest)">
              <Input value={cmk.keyVaultKeyVersion || ''} placeholder="0123456789abcdef…" aria-label="cmk-version" onChange={(_, d) => patchCmk({ keyVaultKeyVersion: d.value })} />
            </Field>
            <Field label="User-assigned identity resource id (optional — keyless CMK access)">
              <Input value={cmk.userAssignedIdentity || ''} placeholder="/subscriptions/…/userAssignedIdentities/…" aria-label="cmk-uami" onChange={(_, d) => patchCmk({ userAssignedIdentity: d.value })} />
            </Field>
            <MessageBar intent="info"><MessageBarBody>
              The identity (service system MI, or the UAMI above) needs Key Vault <strong>Crypto Service Encryption User</strong> (wrap/unwrap) on the key. The service&apos;s <code>encryptionWithCmk.enforcement</code> must not be <code>Disabled</code> for CMK to take effect.
            </MessageBarBody></MessageBar>
          </>
        )}
      </div>

      <div className={s.actions}>
        <Button appearance="primary" disabled={saving || !dirty} onClick={save}>{saving ? 'Saving…' : 'Save CORS & encryption'}</Button>
        {dirty && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>Unsaved changes</Caption1>}
      </div>
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
    </div>
  );
}
