'use client';

/**
 * AiSearchServiceTree — the Azure AI Search service navigator.
 *
 * The AI Search equivalent of the ADF Factory Resources / Synapse Workspace
 * Resources / Databricks Workspace navigators. Once the search service is known
 * (env-pinned LOOM_AI_SEARCH_SERVICE), the editor's left pane becomes this typed
 * navigator: one group per AI Search top-level object type with a live count and
 * a ＋ New affordance, a "Filter by name" box, and a top "Add new" menu —
 * collapsing the portal's left sidebar (Indexes / Indexers / Data sources /
 * Skillsets / Synonym maps / Aliases) into one tree.
 *
 * Every count comes from a real AI Search data-plane list call; every create/
 * delete/lifecycle hits the real REST through the service-level BFF routes:
 *   - Indexes       → /api/ai-search/indexes      (list / create starter / delete; click opens the index editor)
 *   - Indexers      → /api/ai-search/indexers      (list / create / delete / run / reset / status)
 *   - Data sources  → /api/ai-search/datasources   (list / create / delete)
 *   - Skillsets     → /api/ai-search/skillsets     (list / create from JSON / delete)
 *   - Synonym maps  → /api/ai-search/synonymmaps   (list / create / delete)
 *   - Aliases       → /api/ai-search/aliases       (list / create / delete)
 *
 * Debug sessions (ARM management-plane) are wired here too: list / create /
 * delete + a portal deep-link to the visual skill-graph trace (portal-only
 * rendering). The semantic-configuration + vector-profile designers live in the
 * index Schema tab (foundry-sub-editors). The one remaining portal flow not yet
 * authored — the coordinated Import-data wizard — renders as an honest ⚠️
 * "coming" row naming what's missing. No mocks.
 *
 * The service is the env-pinned default. When unconfigured the routes 503 and
 * the whole tree shows a single honest infra-gate MessageBar.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Tree, TreeItem, TreeItemLayout,
  Button, Input, Field, Caption1, Badge, Spinner, Dropdown, Option, OptionGroup, Textarea,
  Checkbox, Divider, Combobox,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Tooltip, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens, Label, Body1Strong, Body1,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync16Regular, Delete16Regular, Open16Regular,
  Search20Regular, Warning20Regular, Play16Regular, ArrowCounterclockwise16Regular,
  DocumentBulletList20Regular, DataUsage20Regular, Database20Regular,
  BrainCircuit20Regular, TextBulletListSquare20Regular, BranchFork20Regular,
  Bug20Regular, ChevronDown16Regular, ChevronRight16Regular,
  BrainCircuit20Regular as BrainCircuit16Regular, Dismiss16Regular, Add16Regular,
  Settings16Regular, ArrowUp16Regular, ArrowDown16Regular, Edit16Regular,
  Storage16Regular,
} from '@fluentui/react-icons';
import {
  type BuiltSkill, type SkillType, type KnowledgeStoreModel,
  SKILL_CATALOG, skillsByCategory,
  ENTITY_CATEGORIES, PII_CATEGORIES, IMAGE_VISUAL_FEATURES, IMAGE_DETAILS, LANGUAGE_CODES,
  defaultSkill, assembleSkillsetDef,
  reorderSkill, availableSourcePaths, contextOptions,
  buildKnowledgeStore, emptyKnowledgeStore, knowledgeStoreIsEmpty, parseSkillset,
} from '@/lib/azure/skillset-chain';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS, padding: tokens.spacingHorizontalS, height: '100%', minWidth: '240px' },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, justifyContent: 'space-between' },
  title: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  groupLayout: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge, width: '100%' },
  groupActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  leafRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, width: '100%' },
  leafActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
});

const R = {
  indexes: '/api/ai-search/indexes',
  indexers: '/api/ai-search/indexers',
  datasources: '/api/ai-search/datasources',
  skillsets: '/api/ai-search/skillsets',
  synonymmaps: '/api/ai-search/synonymmaps',
  aliases: '/api/ai-search/aliases',
  debugSessions: '/api/ai-search/debug-sessions',
};

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

interface IndexRow { name: string; fieldCount: number; vectorEnabled?: boolean }
interface IndexerRow { name: string; targetIndexName?: string; dataSourceName?: string; skillsetName?: string }
interface DataSourceRow { name: string; type?: string; container?: string }
interface SkillsetRow { name: string; skillCount: number }
interface SynonymMapRow { name: string; ruleCount: number; format?: string }
interface AliasRow { name: string; indexes: string[] }
interface DebugSessionRow { name: string; indexerName?: string; status?: string; provisioningState?: string }

type CreateGroup = 'index' | 'indexer' | 'datasource' | 'skillset' | 'synonymmap' | 'alias' | 'debugsession';

function statusColor(status?: string) {
  if (status === 'success') return 'success' as const;
  if (status === 'inProgress') return 'warning' as const;
  if (status === 'transientFailure' || status === 'error') return 'danger' as const;
  return 'informative' as const;
}

// ---------------------------------------------------------------
// Skillset builder — the cognitive skill-chain model + logic is owned by the
// server-free `lib/azure/skillset-chain` module (imported above). The pieces
// below are the CLIENT-only surface: a path picker, a multi-select chip group,
// and the per-skill card.
// ---------------------------------------------------------------

/**
 * A no-freeform path picker: a Combobox seeded with the enrichment-tree paths
 * available at this point in the chain, but still accepting an exact path the
 * user types (freeform). This is the context-path / source-field builder — no
 * hand-authored JSON.
 */
function PathCombobox({ value, onChange, options, placeholder, disabled }: {
  value: string; onChange: (v: string) => void; options: string[]; placeholder?: string; disabled?: boolean;
}) {
  return (
    <Combobox
      size="small"
      freeform
      disabled={disabled}
      value={value}
      selectedOptions={value ? [value] : []}
      placeholder={placeholder || '/document/…'}
      onOptionSelect={(_, d) => onChange(d.optionValue ?? '')}
      onChange={(e) => onChange((e.target as HTMLInputElement).value)}
      style={{ minWidth: 0 }}
    >
      {options.map((o) => <Option key={o} value={o} text={o}>{o}</Option>)}
    </Combobox>
  );
}

/** A wrap of checkboxes for selecting a set of string values (categories, features). */
function MultiCheck({ all, selected, onToggle }: { all: string[]; selected: string[]; onToggle: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, marginBottom: tokens.spacingVerticalS }}>
      {all.map((v) => (
        <Checkbox key={v} size="medium" label={v} checked={selected.includes(v)} onChange={() => onToggle(v)} />
      ))}
    </div>
  );
}

/** A language-code picker backed by the curated list, freeform for the long tail. */
function LangPicker({ label, value, onChange, required }: { label: string; value?: string; onChange: (v: string) => void; required?: boolean }) {
  return (
    <Field label={label} required={required} style={{ marginBottom: tokens.spacingVerticalS }}>
      <Combobox size="small" freeform value={value || ''} selectedOptions={value ? [value] : []} placeholder="en"
        onOptionSelect={(_, d) => onChange(d.optionValue ?? '')} onChange={(e) => onChange((e.target as HTMLInputElement).value)}>
        {LANGUAGE_CODES.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
      </Combobox>
    </Field>
  );
}

// ---- SkillCard sub-component ----
function SkillCard({ skill, index, total, onChange, onRemove, onMove, sourceOptions, contexts }: {
  skill: BuiltSkill;
  index: number;
  total: number;
  onChange: (s: BuiltSkill) => void;
  onRemove: () => void;
  onMove: (dir: 'up' | 'down') => void;
  sourceOptions: string[];
  contexts: string[];
}) {
  const [open, setOpen] = useState(true);
  const meta = SKILL_CATALOG[skill.type];

  const upd = (patch: Partial<BuiltSkill>) => onChange({ ...skill, ...patch });

  const setInput = (idx: number, field: 'name' | 'source', val: string) => {
    const inputs = skill.inputs.map((r, i) => i === idx ? { ...r, [field]: val } : r);
    upd({ inputs });
  };
  const addInput = () => upd({ inputs: [...skill.inputs, { name: '', source: '' }] });
  const removeInput = (idx: number) => upd({ inputs: skill.inputs.filter((_, i) => i !== idx) });

  const setOutput = (idx: number, field: 'name' | 'targetName', val: string) => {
    const outputs = skill.outputs.map((r, i) => i === idx ? { ...r, [field]: val } : r);
    upd({ outputs });
  };
  const addOutput = () => upd({ outputs: [...skill.outputs, { name: '', source: '', targetName: '' }] });
  const removeOutput = (idx: number) => upd({ outputs: skill.outputs.filter((_, i) => i !== idx) });

  const toggleIn = (key: 'categories' | 'piiCategories' | 'visualFeatures' | 'details', v: string) => {
    const cur = (skill[key] as string[] | undefined) || [];
    upd({ [key]: cur.includes(v) ? cur.filter((c) => c !== v) : [...cur, v] } as Partial<BuiltSkill>);
  };

  const cardStyle: React.CSSProperties = {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    marginTop: tokens.spacingVerticalS,
    background: tokens.colorNeutralBackground2,
  };
  const headerStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    userSelect: 'none',
  };
  const rowStyle: React.CSSProperties = { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', marginTop: tokens.spacingVerticalXS };

  return (
    <div style={cardStyle} data-skill-type={skill.type}>
      <div style={headerStyle}>
        {/* Chain-order badge + move controls */}
        <Badge size="small" appearance="filled" color="brand" aria-label={`Step ${index + 1}`}>{index + 1}</Badge>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <Tooltip content="Move up" relationship="label">
            <Button size="small" appearance="subtle" icon={<ArrowUp16Regular />} disabled={index === 0}
              onClick={() => onMove('up')} aria-label={`Move ${meta.label} earlier`} />
          </Tooltip>
          <Tooltip content="Move down" relationship="label">
            <Button size="small" appearance="subtle" icon={<ArrowDown16Regular />} disabled={index === total - 1}
              onClick={() => onMove('down')} aria-label={`Move ${meta.label} later`} />
          </Tooltip>
        </div>
        <div
          style={{ flex: 1, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}
          role="button" tabIndex={0} onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o); } }}
        >
          <BrainCircuit16Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <Body1Strong style={{ display: 'block' }}>{meta.label}</Body1Strong>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{meta.short}</Caption1>
          </div>
          {open ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
        </div>
        <Button size="small" appearance="subtle" icon={<Dismiss16Regular />}
          onClick={onRemove} aria-label={`Remove ${meta.label} skill`} />
      </div>

      {open && (
        <div style={{ marginTop: tokens.spacingVerticalS }}>
          <Field label="Context path" hint="The enrichment-tree node this skill iterates over" style={{ marginBottom: tokens.spacingVerticalS }}>
            <PathCombobox value={skill.context} onChange={(v) => upd({ context: v })} options={contexts} placeholder="/document" />
          </Field>

          {/* SplitSkill */}
          {skill.type === '#Microsoft.Skills.Text.SplitSkill' && (
            <>
              <Field label="Split mode" style={{ marginBottom: tokens.spacingVerticalS }}>
                <Dropdown size="small" value={skill.textSplitMode || 'pages'} selectedOptions={[skill.textSplitMode || 'pages']}
                  onOptionSelect={(_, d) => upd({ textSplitMode: (d.optionValue as any) || 'pages' })}>
                  <Option value="pages">pages</Option>
                  <Option value="sentences">sentences</Option>
                </Dropdown>
              </Field>
              <Field label="Max page length (chars)" style={{ marginBottom: tokens.spacingVerticalS }}>
                <Input size="small" type="number" value={String(skill.maximumPageLength ?? 5000)}
                  onChange={(_, d) => upd({ maximumPageLength: parseInt(d.value) || 5000 })} />
              </Field>
            </>
          )}

          {/* EntityRecognitionSkill */}
          {skill.type === '#Microsoft.Skills.Text.V3.EntityRecognitionSkill' && (
            <>
              <Label size="small" style={{ display: 'block', marginBottom: tokens.spacingVerticalXS }}>Categories</Label>
              <MultiCheck all={ENTITY_CATEGORIES} selected={skill.categories || []} onToggle={(v) => toggleIn('categories', v)} />
              <Field label="Min precision (0–1)" style={{ marginBottom: tokens.spacingVerticalS }}>
                <Input size="small" type="number" value={String(skill.minimumPrecision ?? 0.5)}
                  onChange={(_, d) => upd({ minimumPrecision: parseFloat(d.value) || 0 })} />
              </Field>
              <LangPicker label="Default language code" value={skill.defaultLanguageCode} onChange={(v) => upd({ defaultLanguageCode: v })} />
            </>
          )}

          {/* KeyPhraseExtractionSkill */}
          {skill.type === '#Microsoft.Skills.Text.KeyPhraseExtractionSkill' && (
            <LangPicker label="Default language code" value={skill.defaultLanguageCode} onChange={(v) => upd({ defaultLanguageCode: v })} />
          )}

          {/* LanguageDetectionSkill — no parameters */}

          {/* SentimentSkill (V3) */}
          {skill.type === '#Microsoft.Skills.Text.V3.SentimentSkill' && (
            <>
              <LangPicker label="Default language code" value={skill.defaultLanguageCode} onChange={(v) => upd({ defaultLanguageCode: v })} />
              <div style={{ marginBottom: tokens.spacingVerticalS }}>
                <Checkbox label="Include opinion mining (aspect-based sentiment)" checked={!!skill.includeOpinionMining}
                  onChange={(_, d) => upd({ includeOpinionMining: !!d.checked })} />
              </div>
            </>
          )}

          {/* PIIDetectionSkill */}
          {skill.type === '#Microsoft.Skills.Text.PIIDetectionSkill' && (
            <>
              <LangPicker label="Default language code" value={skill.defaultLanguageCode} onChange={(v) => upd({ defaultLanguageCode: v })} />
              <Field label="Min precision (0–1)" style={{ marginBottom: tokens.spacingVerticalS }}>
                <Input size="small" type="number" value={String(skill.minimumPrecision ?? 0.5)}
                  onChange={(_, d) => upd({ minimumPrecision: parseFloat(d.value) || 0 })} />
              </Field>
              <Field label="Masking mode" style={{ marginBottom: tokens.spacingVerticalS }}>
                <Dropdown size="small" value={skill.maskingMode || 'none'} selectedOptions={[skill.maskingMode || 'none']}
                  onOptionSelect={(_, d) => upd({ maskingMode: (d.optionValue as any) || 'none' })}>
                  <Option value="none">none</Option>
                  <Option value="replace">replace</Option>
                </Dropdown>
              </Field>
              {skill.maskingMode === 'replace' && (
                <Field label="Masking character" style={{ marginBottom: tokens.spacingVerticalS }}>
                  <Input size="small" maxLength={1} value={skill.maskingCharacter || '*'}
                    onChange={(_, d) => upd({ maskingCharacter: d.value.slice(0, 1) || '*' })} />
                </Field>
              )}
              <Label size="small" style={{ display: 'block', marginBottom: tokens.spacingVerticalXS }}>
                PII categories <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>(none selected ⇒ all)</Caption1>
              </Label>
              <MultiCheck all={PII_CATEGORIES} selected={skill.piiCategories || []} onToggle={(v) => toggleIn('piiCategories', v)} />
            </>
          )}

          {/* TranslationSkill */}
          {skill.type === '#Microsoft.Skills.Text.TranslationSkill' && (
            <>
              <LangPicker label="Translate to (default)" required value={skill.defaultToLanguageCode} onChange={(v) => upd({ defaultToLanguageCode: v })} />
              <LangPicker label="Translate from (optional — auto-detect if empty)" value={skill.defaultFromLanguageCode} onChange={(v) => upd({ defaultFromLanguageCode: v })} />
            </>
          )}

          {/* OcrSkill */}
          {skill.type === '#Microsoft.Skills.Vision.OcrSkill' && (
            <>
              <div style={{ marginBottom: tokens.spacingVerticalS }}>
                <Checkbox label="Detect orientation" checked={!!skill.detectOrientation}
                  onChange={(_, d) => upd({ detectOrientation: !!d.checked })} />
              </div>
              <LangPicker label="Default language code" value={skill.defaultLanguageCode} onChange={(v) => upd({ defaultLanguageCode: v })} />
              <Field label="Line ending" style={{ marginBottom: tokens.spacingVerticalS }}>
                <Dropdown size="small" value={skill.lineEnding || 'Space'} selectedOptions={[skill.lineEnding || 'Space']}
                  onOptionSelect={(_, d) => upd({ lineEnding: (d.optionValue as any) || 'Space' })}>
                  <Option value="Space">Space</Option>
                  <Option value="CarriageReturn">CarriageReturn</Option>
                  <Option value="LineFeed">LineFeed</Option>
                </Dropdown>
              </Field>
            </>
          )}

          {/* ImageAnalysisSkill */}
          {skill.type === '#Microsoft.Skills.Vision.ImageAnalysisSkill' && (
            <>
              <Label size="small" style={{ display: 'block', marginBottom: tokens.spacingVerticalXS }}>Visual features</Label>
              <MultiCheck all={IMAGE_VISUAL_FEATURES} selected={skill.visualFeatures || []} onToggle={(v) => toggleIn('visualFeatures', v)} />
              <Label size="small" style={{ display: 'block', marginBottom: tokens.spacingVerticalXS }}>Details</Label>
              <MultiCheck all={IMAGE_DETAILS} selected={skill.details || []} onToggle={(v) => toggleIn('details', v)} />
              <LangPicker label="Default language code" value={skill.defaultLanguageCode} onChange={(v) => upd({ defaultLanguageCode: v })} />
            </>
          )}

          {/* AzureOpenAIEmbeddingSkill */}
          {skill.type === '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill' && (
            <>
              <Field label="Resource URI" style={{ marginBottom: tokens.spacingVerticalS }}>
                <Input size="small" value={skill.resourceUri || ''}
                  onChange={(_, d) => upd({ resourceUri: d.value })} placeholder="https://my-aoai.openai.azure.com" />
              </Field>
              <Field label="Deployment ID" style={{ marginBottom: tokens.spacingVerticalS }}>
                <Input size="small" value={skill.deploymentId || ''}
                  onChange={(_, d) => upd({ deploymentId: d.value })} placeholder="text-embedding-3-large" />
              </Field>
              <Field label="Model name" style={{ marginBottom: tokens.spacingVerticalS }}>
                <Input size="small" value={skill.modelName || ''}
                  onChange={(_, d) => upd({ modelName: d.value })} placeholder="text-embedding-3-large" />
              </Field>
            </>
          )}

          {/* Custom WebApiSkill */}
          {skill.type === '#Microsoft.Skills.Custom.WebApiSkill' && (
            <>
              <Field label="Name" style={{ marginBottom: tokens.spacingVerticalS }}>
                <Input size="small" value={skill.name || ''} onChange={(_, d) => upd({ name: d.value })} placeholder="myCustomSkill" />
              </Field>
              <Field label="URI (https only)" required style={{ marginBottom: tokens.spacingVerticalS }}>
                <Input size="small" value={skill.uri || ''} onChange={(_, d) => upd({ uri: d.value })} placeholder="https://my-func.azurewebsites.net/api/enrich" />
              </Field>
              <Field label="HTTP method" style={{ marginBottom: tokens.spacingVerticalS }}>
                <Dropdown size="small" value={skill.httpMethod || 'POST'} selectedOptions={[skill.httpMethod || 'POST']}
                  onOptionSelect={(_, d) => upd({ httpMethod: (d.optionValue as any) || 'POST' })}>
                  <Option value="POST">POST</Option>
                  <Option value="PUT">PUT</Option>
                </Dropdown>
              </Field>
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
                <Field label="Batch size" style={{ flex: 1, marginBottom: tokens.spacingVerticalS }}>
                  <Input size="small" type="number" value={String(skill.batchSize ?? 1000)}
                    onChange={(_, d) => upd({ batchSize: parseInt(d.value) || 1000 })} />
                </Field>
                <Field label="Timeout (ISO 8601)" style={{ flex: 1, marginBottom: tokens.spacingVerticalS }}>
                  <Input size="small" value={skill.timeout || 'PT30S'} onChange={(_, d) => upd({ timeout: d.value })} placeholder="PT30S" />
                </Field>
              </div>
            </>
          )}

          {/* Inputs — source uses the enrichment-tree path picker */}
          <Body1Strong style={{ display: 'block', marginBottom: tokens.spacingVerticalXS }}>Inputs</Body1Strong>
          {skill.inputs.map((inp, idx) => (
            <div key={idx} style={rowStyle}>
              <Input size="small" style={{ flex: 1, minWidth: 0 }} placeholder="name" value={inp.name}
                onChange={(_, d) => setInput(idx, 'name', d.value)} aria-label="input name" />
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>←</Caption1>
              <div style={{ flex: 2, minWidth: 0 }}>
                <PathCombobox value={inp.source} onChange={(v) => setInput(idx, 'source', v)} options={sourceOptions} placeholder="/document/content" />
              </div>
              <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove input"
                onClick={() => removeInput(idx)} />
            </div>
          ))}
          <Button size="small" appearance="subtle" icon={<Add16Regular />} style={{ marginTop: tokens.spacingVerticalXS }}
            onClick={addInput}>Add input</Button>

          {/* Outputs */}
          <Body1Strong style={{ display: 'block', marginTop: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalXS }}>Outputs</Body1Strong>
          {skill.outputs.map((out, idx) => (
            <div key={idx} style={rowStyle}>
              <Input size="small" style={{ flex: 1, minWidth: 0 }} placeholder="name" value={out.name}
                onChange={(_, d) => setOutput(idx, 'name', d.value)} aria-label="output name" />
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>→</Caption1>
              <Input size="small" style={{ flex: 2, minWidth: 0 }} placeholder="targetName" value={out.targetName || ''}
                onChange={(_, d) => setOutput(idx, 'targetName', d.value)} aria-label="output target name" />
              <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove output"
                onClick={() => removeOutput(idx)} />
            </div>
          ))}
          <Button size="small" appearance="subtle" icon={<Add16Regular />} style={{ marginTop: tokens.spacingVerticalXS }}
            onClick={addOutput}>Add output</Button>
        </div>
      )}
    </div>
  );
}

export interface AiSearchServiceTreeProps {
  /** Currently selected index (highlighted in the tree). */
  selectedIndex?: string | null;
  /** Open / bind an index in the host editor (selecting opens the index editor / search explorer). */
  onOpenIndex?: (name: string) => void;
  /** Start a brand-new index in the host editor. Falls back to the inline starter-index dialog when absent. */
  onNewIndex?: () => void;
  /** Open the service-administration panel (keys / networking / monitoring / stats) in the host editor. */
  onOpenService?: () => void;
  /** Increment to force a refresh from the parent (e.g. after a save/create). */
  refreshKey?: number;
  /** Open the Knowledge Bases (agentic retrieval) surface in the host editor. */
  onOpenKnowledge?: () => void;
  /** True when the Knowledge Bases surface is the active pane (highlight the group). */
  knowledgeActive?: boolean;
}

/** A typed, AI-Search-faithful service navigator. */
export function AiSearchServiceTree({
  selectedIndex = null, onOpenIndex, onNewIndex, onOpenService, refreshKey = 0,
  onOpenKnowledge, knowledgeActive = false,
}: AiSearchServiceTreeProps) {
  const s = useStyles();

  const [filter, setFilter] = useState('');
  const [gate, setGate] = useState<{ missing: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [indexes, setIndexes] = useState<IndexRow[]>([]);
  const [indexers, setIndexers] = useState<IndexerRow[]>([]);
  const [dataSources, setDataSources] = useState<DataSourceRow[]>([]);
  const [skillsets, setSkillsets] = useState<SkillsetRow[]>([]);
  const [synonymMaps, setSynonymMaps] = useState<SynonymMapRow[]>([]);
  const [aliases, setAliases] = useState<AliasRow[]>([]);

  // Debug sessions (ARM management-plane). Gated separately: they need the ARM
  // env (LOOM_AI_SEARCH_SUB/RG/SERVICE), distinct from the data-plane gate.
  const [debugSessions, setDebugSessions] = useState<DebugSessionRow[]>([]);
  const [debugGate, setDebugGate] = useState<{ missing: string[]; storageConfigured?: boolean } | null>(null);
  const [debugPortalUrl, setDebugPortalUrl] = useState<string | null>(null);
  const [debugStorageConn, setDebugStorageConn] = useState('');

  // Per-indexer last status (lazy, on demand).
  const [indexerStatus, setIndexerStatus] = useState<Record<string, string>>({});

  // ---- create dialog ----
  const [createGroup, setCreateGroup] = useState<CreateGroup | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  // shared name
  const [cName, setCName] = useState('');
  // indexer
  const [cDataSource, setCDataSource] = useState('');
  const [cTargetIndex, setCTargetIndex] = useState('');
  const [cSkillset, setCSkillset] = useState('');
  // datasource
  const [cDsType, setCDsType] = useState('azureblob');
  const [cDsConn, setCDsConn] = useState('');
  const [cDsContainer, setCDsContainer] = useState('');
  const [cDsQuery, setCDsQuery] = useState('');
  // skillset builder
  const [cSkillsetSkills, setCSkillsetSkills] = useState<BuiltSkill[]>([]);
  const [cSkillsetAdvancedOpen, setCSkillsetAdvancedOpen] = useState(false);
  const [cSkillsetAdvancedJson, setCSkillsetAdvancedJson] = useState('');
  const [cSkillsetAdvancedDirty, setCSkillsetAdvancedDirty] = useState(false);
  const [cSkillsetEditing, setCSkillsetEditing] = useState<string | null>(null);
  // knowledge store (projections)
  const [cKsOpen, setCKsOpen] = useState(false);
  const [cKsConn, setCKsConn] = useState('');
  const [cKs, setCKs] = useState<KnowledgeStoreModel>(emptyKnowledgeStore());
  // synonym map
  const [cSynonyms, setCSynonyms] = useState('');
  // alias
  const [cAliasIndex, setCAliasIndex] = useState('');
  // debug session
  const [cDebugIndexer, setCDebugIndexer] = useState('');

  function applyGate(body: any): boolean {
    if (body?.code === 'not_configured' && body?.missing) { setGate({ missing: body.missing }); return true; }
    return false;
  }

  const loadAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [ix, idr, ds, sk, sm, al] = await Promise.all([
        fetch(R.indexes).then(readJson),
        fetch(R.indexers).then(readJson),
        fetch(R.datasources).then(readJson),
        fetch(R.skillsets).then(readJson),
        fetch(R.synonymmaps).then(readJson),
        fetch(R.aliases).then(readJson),
      ]);
      for (const b of [ix, idr, ds, sk, sm, al]) { if (applyGate(b)) { setLoading(false); return; } }
      setGate(null);
      if (ix.ok) setIndexes(ix.indexes || []); else setError(ix.error || 'failed to list indexes');
      if (idr.ok) setIndexers(idr.indexers || []);
      if (ds.ok) setDataSources(ds.dataSources || []);
      if (sk.ok) setSkillsets(sk.skillsets || []);
      if (sm.ok) setSynonymMaps(sm.synonymMaps || []);
      if (al.ok) setAliases(al.aliases || []);
      // Debug sessions live on the ARM plane — load separately so their own
      // (ARM) gate doesn't block the data-plane tree.
      await loadDebugSessions();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDebugSessions = useCallback(async () => {
    try {
      const res = await fetch(R.debugSessions);
      const body = await readJson(res);
      if (body?.code === 'not_configured') {
        setDebugGate({ missing: body.missing || [] });
        setDebugSessions([]); setDebugPortalUrl(null);
        return;
      }
      setDebugGate(null);
      setDebugSessions(body.ok ? (body.sessions || []) : []);
      setDebugPortalUrl(body.portalUrl || null);
      setDebugGate(body.ok ? { missing: [], storageConfigured: !!body.storageConfigured } : null);
    } catch {
      // Surface as an empty list with no gate; the main error bar covers hard failures.
      setDebugSessions([]);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll, refreshKey]);

  // ---------------------------------------------------------------
  // Create / delete / lifecycle (real REST)
  // ---------------------------------------------------------------
  const openCreate = useCallback((g: CreateGroup) => {
    setCreateGroup(g); setCreateError(null);
    setCName(''); setCDataSource(''); setCTargetIndex(''); setCSkillset('');
    setCDsType('azureblob'); setCDsConn(''); setCDsContainer(''); setCDsQuery('');
    setCSkillsetSkills([]); setCSkillsetAdvancedOpen(false); setCSkillsetAdvancedJson(''); setCSkillsetAdvancedDirty(false);
    setCSkillsetEditing(null); setCKsOpen(false); setCKsConn(''); setCKs(emptyKnowledgeStore());
    setCSynonyms(''); setCAliasIndex(''); setCDebugIndexer('');
  }, []);

  /** Load an existing skillset's full definition into the guided builder for editing. */
  const openEditSkillset = useCallback(async (name: string) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${R.skillsets}?name=${encodeURIComponent(name)}`);
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok || !body.definition) { setError(body.error || `Could not load skillset ${name}`); setBusy(false); return; }
      const parsed = parseSkillset(body.definition);
      setCreateGroup('skillset'); setCreateError(null);
      setCName(parsed.name || name);
      setCSkillsetSkills(parsed.skills);
      setCSkillsetAdvancedOpen(false); setCSkillsetAdvancedJson(''); setCSkillsetAdvancedDirty(false);
      setCSkillsetEditing(name);
      setCKs(parsed.knowledgeStore); setCKsConn(parsed.storageConnectionString);
      setCKsOpen(!knowledgeStoreIsEmpty(parsed.knowledgeStore));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setBusy(false); }
  }, []);

  const submitCreate = useCallback(async () => {
    if (!createGroup) return;
    setBusy(true); setCreateError(null);
    try {
      let route = R.indexes; let payload: any = {};
      if (createGroup === 'index') {
        if (!cName.trim()) { setCreateError('Name is required.'); setBusy(false); return; }
        route = R.indexes; payload = { name: cName.trim() };
      } else if (createGroup === 'indexer') {
        if (!cName.trim() || !cDataSource || !cTargetIndex) { setCreateError('Name, data source and target index are required.'); setBusy(false); return; }
        route = R.indexers; payload = { name: cName.trim(), dataSourceName: cDataSource, targetIndexName: cTargetIndex, ...(cSkillset ? { skillsetName: cSkillset } : {}) };
      } else if (createGroup === 'datasource') {
        if (!cName.trim() || !cDsConn.trim() || !cDsContainer.trim()) { setCreateError('Name, connection string and container are required.'); setBusy(false); return; }
        route = R.datasources; payload = { name: cName.trim(), type: cDsType, connectionString: cDsConn.trim(), container: cDsContainer.trim(), ...(cDsQuery.trim() ? { query: cDsQuery.trim() } : {}) };
      } else if (createGroup === 'skillset') {
        if (!cName.trim()) { setCreateError('Skillset name is required.'); setBusy(false); return; }
        let def: any;
        if (cSkillsetAdvancedDirty && cSkillsetAdvancedJson.trim()) {
          // Power user edited the advanced JSON — use that verbatim (with name patch).
          try { def = JSON.parse(cSkillsetAdvancedJson); } catch (e: any) { setCreateError(`Advanced JSON is invalid: ${e?.message}`); setBusy(false); return; }
          if (!def.name) def.name = cName.trim();
        } else {
          // Guided builder — assemble the ordered chain + optional knowledge store.
          if (cSkillsetSkills.length === 0) { setCreateError('Add at least one skill.'); setBusy(false); return; }
          const missingUri = cSkillsetSkills.find((sk) => sk.type === '#Microsoft.Skills.Custom.WebApiSkill' && !(sk.uri || '').trim());
          if (missingUri) { setCreateError('Custom Web API skill requires an https URI.'); setBusy(false); return; }
          const knowledgeStore = buildKnowledgeStore(cKsConn, cKs);
          def = assembleSkillsetDef(cName.trim(), cSkillsetSkills, { knowledgeStore });
        }
        route = R.skillsets; payload = { definition: def };
      } else if (createGroup === 'synonymmap') {
        if (!cName.trim() || !cSynonyms.trim()) { setCreateError('Name and rules are required.'); setBusy(false); return; }
        route = R.synonymmaps; payload = { name: cName.trim(), synonyms: cSynonyms };
      } else if (createGroup === 'alias') {
        if (!cName.trim() || !cAliasIndex) { setCreateError('Name and target index are required.'); setBusy(false); return; }
        route = R.aliases; payload = { name: cName.trim(), index: cAliasIndex };
      } else if (createGroup === 'debugsession') {
        if (!cName.trim() || !cDebugIndexer) { setCreateError('Session name and indexer are required.'); setBusy(false); return; }
        route = R.debugSessions;
        payload = { name: cName.trim(), indexerName: cDebugIndexer, ...(debugStorageConn.trim() ? { storageConnStr: debugStorageConn.trim() } : {}) };
      }
      const res = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await readJson(res);
      // Debug sessions gate on ARM env, not the data-plane gate — surface as inline error.
      if (createGroup !== 'debugsession' && applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setCreateError(body.error || 'create failed'); setBusy(false); return; }
      setCreateGroup(null);
      if (createGroup === 'debugsession') { await loadDebugSessions(); } else { await loadAll(); }
    } catch (e: any) {
      setCreateError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [createGroup, cName, cDataSource, cTargetIndex, cSkillset, cDsType, cDsConn, cDsContainer, cDsQuery, cSkillsetSkills, cSkillsetAdvancedDirty, cSkillsetAdvancedJson, cKsConn, cKs, cSynonyms, cAliasIndex, cDebugIndexer, debugStorageConn, loadAll, loadDebugSessions]);

  const delDebugSession = useCallback(async (name: string) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${R.debugSessions}?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const body = await readJson(res);
      if (!body.ok) { setError(body.error || 'delete failed'); setBusy(false); return; }
      await loadDebugSessions();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [loadDebugSessions]);

  const del = useCallback(async (route: string, name: string) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${route}?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setError(body.error || 'delete failed'); setBusy(false); return; }
      await loadAll();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [loadAll]);

  const indexerAction = useCallback(async (action: 'run' | 'reset' | 'status', indexer: string) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(R.indexers, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, indexer }) });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setError(body.error || `${action} failed`); setBusy(false); return; }
      if (action === 'status') {
        const st = body.status?.lastResult?.status || body.status?.status || 'unknown';
        setIndexerStatus((m) => ({ ...m, [indexer]: st }));
      }
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, []);

  // ---------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------
  const f = filter.trim().toLowerCase();
  const match = (n: string) => !f || n.toLowerCase().includes(f);
  const fIndexes = useMemo(() => indexes.filter((x) => match(x.name)), [indexes, f]);
  const fIndexers = useMemo(() => indexers.filter((x) => match(x.name)), [indexers, f]);
  const fDataSources = useMemo(() => dataSources.filter((x) => match(x.name)), [dataSources, f]);
  const fSkillsets = useMemo(() => skillsets.filter((x) => match(x.name)), [skillsets, f]);
  const fSynonymMaps = useMemo(() => synonymMaps.filter((x) => match(x.name)), [synonymMaps, f]);
  const fAliases = useMemo(() => aliases.filter((x) => match(x.name)), [aliases, f]);

  const indexNames = useMemo(() => indexes.map((i) => i.name), [indexes]);
  const dataSourceNames = useMemo(() => dataSources.map((d) => d.name), [dataSources]);
  const skillsetNames = useMemo(() => skillsets.map((sk) => sk.name), [skillsets]);
  const indexerNames = useMemo(() => indexers.map((ix) => ix.name), [indexers]);
  const fDebugSessions = useMemo(() => debugSessions.filter((x) => match(x.name)), [debugSessions, f]);

  // ---------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------
  const groupHeader = (label: string, icon: React.ReactElement, count: number, onAdd?: () => void, addTitle?: string) => (
    <TreeItemLayout iconBefore={icon}>
      <span className={s.groupLayout}>
        <span>{label} ({count})</span>
        <span className={s.groupActions} onClick={(e) => e.stopPropagation()}>
          {onAdd && (
            <Tooltip content={addTitle || `New ${label.toLowerCase()}`} relationship="label">
              <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={onAdd} disabled={busy} aria-label={addTitle || `New ${label}`} />
            </Tooltip>
          )}
        </span>
      </span>
    </TreeItemLayout>
  );

  if (gate) {
    return (
      <div className={s.root}>
        <div className={s.header}><span className={s.title}>Search service</span></div>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Azure AI Search not configured</MessageBarTitle>
            Set <code>{gate.missing}</code> on the Console Container App to a deployed{' '}
            <code>Microsoft.Search/searchServices</code> name (or its{' '}
            <code>&lt;service&gt;.search.windows.net</code> host). The navigator stays here; objects
            appear once the service is reachable. The Loom UAMI must hold{' '}
            <strong>Search Service Contributor</strong> + <strong>Search Index Data Contributor</strong>{' '}
            on the service. Provisioned by{' '}
            <code>platform/fiab/bicep/modules/admin-plane/ai-search.bicep</code>.
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.header}>
        <span className={s.title}>Search service</span>
        <span style={{ display: 'flex', gap: tokens.spacingHorizontalXXS }}>
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Tooltip content="Add new" relationship="label">
                <Button size="small" appearance="primary" icon={<Add20Regular />} aria-label="Add new" />
              </Tooltip>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<DocumentBulletList20Regular />} onClick={() => (onNewIndex ? onNewIndex() : openCreate('index'))}>Index</MenuItem>
                <MenuItem icon={<DataUsage20Regular />} onClick={() => openCreate('indexer')}>Indexer</MenuItem>
                <MenuItem icon={<Database20Regular />} onClick={() => openCreate('datasource')}>Data source</MenuItem>
                <MenuItem icon={<BrainCircuit20Regular />} onClick={() => openCreate('skillset')}>Skillset</MenuItem>
                <MenuItem icon={<TextBulletListSquare20Regular />} onClick={() => openCreate('synonymmap')}>Synonym map</MenuItem>
                <MenuItem icon={<BranchFork20Regular />} onClick={() => openCreate('alias')}>Alias</MenuItem>
                <MenuItem icon={<Bug20Regular />} onClick={() => openCreate('debugsession')} disabled={!!debugGate?.missing?.length}>Debug session</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
          {onOpenService && (
            <Tooltip content="Service administration (keys, networking, monitoring, statistics)" relationship="label">
              <Button size="small" appearance="subtle" icon={<Settings16Regular />} onClick={onOpenService} aria-label="Service administration" />
            </Tooltip>
          )}
          <Tooltip content="Refresh" relationship="label">
            <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={loadAll} disabled={loading} aria-label="Refresh search service" />
          </Tooltip>
        </span>
      </div>

      <Field>
        <Input size="small" contentBefore={<Search20Regular />} placeholder="Filter by name" value={filter} onChange={(_, d) => setFilter(d.value)} />
      </Field>

      {loading && <div style={{ padding: tokens.spacingVerticalS }}><Spinner size="tiny" label="Loading search service…" /></div>}
      {error && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Service error</MessageBarTitle>{error}</MessageBarBody></MessageBar>
      )}

      <div style={{ overflow: 'auto', flex: 1 }}>
        <Tree aria-label="Azure AI Search service" defaultOpenItems={['g-indexes']}>
          {/* Indexes */}
          <TreeItem itemType="branch" value="g-indexes">
            {groupHeader('Indexes', <DocumentBulletList20Regular />, indexes.length, () => (onNewIndex ? onNewIndex() : openCreate('index')), 'New index')}
            <Tree>
              {fIndexes.length === 0 && <TreeItem itemType="leaf" value="ix-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No indexes'}</Caption1></TreeItemLayout></TreeItem>}
              {fIndexes.map((i) => (
                <TreeItem key={i.name} itemType="leaf" value={`ix-${i.name}`}>
                  <TreeItemLayout iconBefore={<DocumentBulletList20Regular />}>
                    <span className={s.leafRow}>
                      <span
                        role="button" tabIndex={0}
                        style={{ cursor: onOpenIndex ? 'pointer' : undefined, fontWeight: selectedIndex === i.name ? tokens.fontWeightSemibold : undefined }}
                        onClick={() => onOpenIndex?.(i.name)}
                        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && onOpenIndex) { e.preventDefault(); onOpenIndex(i.name); } }}
                      >
                        {i.name}
                      </span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        <Caption1>{i.fieldCount} fields</Caption1>
                        {i.vectorEnabled && <Badge size="small" appearance="tint" color="brand">vector</Badge>}
                        {onOpenIndex && <Tooltip content="Open" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => onOpenIndex(i.name)} aria-label={`Open ${i.name}`} /></Tooltip>}
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(R.indexes, i.name)} aria-label={`Delete ${i.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Indexers */}
          <TreeItem itemType="branch" value="g-indexers">
            {groupHeader('Indexers', <DataUsage20Regular />, indexers.length, () => openCreate('indexer'), 'New indexer')}
            <Tree>
              {fIndexers.length === 0 && <TreeItem itemType="leaf" value="idr-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No indexers'}</Caption1></TreeItemLayout></TreeItem>}
              {fIndexers.map((ix) => (
                <TreeItem key={ix.name} itemType="leaf" value={`idr-${ix.name}`}>
                  <TreeItemLayout iconBefore={<DataUsage20Regular />}>
                    <span className={s.leafRow}>
                      <span>{ix.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {ix.targetIndexName && <Caption1>→ {ix.targetIndexName}</Caption1>}
                        {indexerStatus[ix.name] && <Badge size="small" appearance="filled" color={statusColor(indexerStatus[ix.name])}>{indexerStatus[ix.name]}</Badge>}
                        <Tooltip content="Run now" relationship="label"><Button size="small" appearance="subtle" icon={<Play16Regular />} disabled={busy} onClick={() => indexerAction('run', ix.name)} aria-label={`Run ${ix.name}`} /></Tooltip>
                        <Tooltip content="Reset (full reindex next run)" relationship="label"><Button size="small" appearance="subtle" icon={<ArrowCounterclockwise16Regular />} disabled={busy} onClick={() => indexerAction('reset', ix.name)} aria-label={`Reset ${ix.name}`} /></Tooltip>
                        <Tooltip content="Check status" relationship="label"><Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} disabled={busy} onClick={() => indexerAction('status', ix.name)} aria-label={`Status of ${ix.name}`} /></Tooltip>
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(R.indexers, ix.name)} aria-label={`Delete ${ix.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Data sources */}
          <TreeItem itemType="branch" value="g-datasources">
            {groupHeader('Data sources', <Database20Regular />, dataSources.length, () => openCreate('datasource'), 'New data source')}
            <Tree>
              {fDataSources.length === 0 && <TreeItem itemType="leaf" value="ds-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No data sources'}</Caption1></TreeItemLayout></TreeItem>}
              {fDataSources.map((d) => (
                <TreeItem key={d.name} itemType="leaf" value={`ds-${d.name}`}>
                  <TreeItemLayout iconBefore={<Database20Regular />}>
                    <span className={s.leafRow}>
                      <span>{d.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {d.type && <Badge size="small" appearance="tint">{d.type}</Badge>}
                        {d.container && <Caption1>{d.container}</Caption1>}
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(R.datasources, d.name)} aria-label={`Delete ${d.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Skillsets */}
          <TreeItem itemType="branch" value="g-skillsets">
            {groupHeader('Skillsets', <BrainCircuit20Regular />, skillsets.length, () => openCreate('skillset'), 'New skillset')}
            <Tree>
              {fSkillsets.length === 0 && <TreeItem itemType="leaf" value="sk-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No skillsets'}</Caption1></TreeItemLayout></TreeItem>}
              {fSkillsets.map((sk) => (
                <TreeItem key={sk.name} itemType="leaf" value={`sk-${sk.name}`}>
                  <TreeItemLayout iconBefore={<BrainCircuit20Regular />}>
                    <span className={s.leafRow}>
                      <span>{sk.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        <Caption1>{sk.skillCount} skills</Caption1>
                        <Tooltip content="Edit chain" relationship="label"><Button size="small" appearance="subtle" icon={<Edit16Regular />} disabled={busy} onClick={() => openEditSkillset(sk.name)} aria-label={`Edit ${sk.name}`} /></Tooltip>
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(R.skillsets, sk.name)} aria-label={`Delete ${sk.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Synonym maps */}
          <TreeItem itemType="branch" value="g-synonymmaps">
            {groupHeader('Synonym maps', <TextBulletListSquare20Regular />, synonymMaps.length, () => openCreate('synonymmap'), 'New synonym map')}
            <Tree>
              {fSynonymMaps.length === 0 && <TreeItem itemType="leaf" value="sm-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No synonym maps'}</Caption1></TreeItemLayout></TreeItem>}
              {fSynonymMaps.map((sm) => (
                <TreeItem key={sm.name} itemType="leaf" value={`sm-${sm.name}`}>
                  <TreeItemLayout iconBefore={<TextBulletListSquare20Regular />}>
                    <span className={s.leafRow}>
                      <span>{sm.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        <Caption1>{sm.ruleCount} rules</Caption1>
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(R.synonymmaps, sm.name)} aria-label={`Delete ${sm.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Aliases */}
          <TreeItem itemType="branch" value="g-aliases">
            {groupHeader('Aliases', <BranchFork20Regular />, aliases.length, () => openCreate('alias'), 'New alias')}
            <Tree>
              {fAliases.length === 0 && <TreeItem itemType="leaf" value="al-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No aliases'}</Caption1></TreeItemLayout></TreeItem>}
              {fAliases.map((a) => (
                <TreeItem key={a.name} itemType="leaf" value={`al-${a.name}`}>
                  <TreeItemLayout iconBefore={<BranchFork20Regular />}>
                    <span className={s.leafRow}>
                      <span>{a.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {a.indexes?.[0] && <Caption1>→ {a.indexes[0]}</Caption1>}
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(R.aliases, a.name)} aria-label={`Delete ${a.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Knowledge bases (agentic retrieval / Foundry IQ). Opens the full
              Knowledge Bases surface (sources + bases + retrieve-test) in the
              host editor — a pane, not tree leaves. */}
          {onOpenKnowledge && (
            <TreeItem itemType="leaf" value="g-knowledge">
              <TreeItemLayout
                iconBefore={<BrainCircuit20Regular />}
                style={{ cursor: 'pointer', fontWeight: knowledgeActive ? tokens.fontWeightSemibold : undefined }}
                onClick={() => onOpenKnowledge()}
              >
                <span className={s.leafRow}><span>Knowledge bases</span></span>
              </TreeItemLayout>
            </TreeItem>
          )}

          {/* Debug sessions (ARM management-plane). Create/list/delete + portal
              deep-link to the visual skill-graph trace (portal-only rendering). */}
          <TreeItem itemType="branch" value="g-debug-sessions">
            {groupHeader('Debug sessions', <Bug20Regular />, debugSessions.length, (!debugGate?.missing?.length ? () => openCreate('debugsession') : undefined), 'New debug session')}
            <Tree>
              {debugGate?.missing?.length ? (
                <TreeItem itemType="leaf" value="dbg-gate">
                  <Tooltip content={`Set ${debugGate.missing.join(', ')} on the Console Container App to enable debug sessions (ARM management plane). Bicep: platform/fiab/bicep/modules/admin-plane/ai-search.bicep`} relationship="description">
                    <TreeItemLayout iconBefore={<Warning20Regular />}>
                      <span style={{ color: tokens.colorNeutralForeground3 }}>ARM not configured — set {debugGate.missing.join(', ')}</span>{' '}
                      <Badge size="small" appearance="tint" color="warning">config</Badge>
                    </TreeItemLayout>
                  </Tooltip>
                </TreeItem>
              ) : (
                <>
                  {fDebugSessions.length === 0 && <TreeItem itemType="leaf" value="dbg-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No debug sessions'}</Caption1></TreeItemLayout></TreeItem>}
                  {fDebugSessions.map((dbg) => (
                    <TreeItem key={dbg.name} itemType="leaf" value={`dbg-${dbg.name}`}>
                      <TreeItemLayout iconBefore={<Bug20Regular />}>
                        <span className={s.leafRow}>
                          <span>{dbg.name}</span>
                          <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                            {dbg.indexerName && <Caption1>↳ {dbg.indexerName}</Caption1>}
                            {(dbg.status || dbg.provisioningState) && <Badge size="small" appearance="filled" color={statusColor(dbg.status)}>{dbg.status || dbg.provisioningState}</Badge>}
                            {debugPortalUrl && <Tooltip content="Open session trace in portal (visual skill graph is portal-only)" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => window.open(`${debugPortalUrl}/${encodeURIComponent(dbg.name)}`, '_blank', 'noopener')} aria-label={`Open ${dbg.name} in portal`} /></Tooltip>}
                            <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => delDebugSession(dbg.name)} aria-label={`Delete ${dbg.name}`} /></Tooltip>
                          </span>
                        </span>
                      </TreeItemLayout>
                    </TreeItem>
                  ))}
                  {debugPortalUrl && (
                    <TreeItem itemType="leaf" value="dbg-portal">
                      <TreeItemLayout iconBefore={<Open16Regular />}>
                        <span role="button" tabIndex={0} style={{ cursor: 'pointer', color: tokens.colorBrandForeground1 }}
                          onClick={() => window.open(debugPortalUrl, '_blank', 'noopener')}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); window.open(debugPortalUrl, '_blank', 'noopener'); } }}>
                          Open debug-sessions blade in portal
                        </span>
                      </TreeItemLayout>
                    </TreeItem>
                  )}
                </>
              )}
            </Tree>
          </TreeItem>

          {/* Honest gate row — the one remaining portal flow not yet authored in Loom. */}
          <TreeItem itemType="branch" value="g-not-wired">
            <TreeItemLayout iconBefore={<Warning20Regular />}>Not yet wired</TreeItemLayout>
            <Tree>
              {[
                ['Import data wizard', 'Portal "Import data" / "Import and vectorize data" wizard that creates datasource+skillset+index+indexer in one coordinated flow. Create the pieces individually using ＋ New for each object type above; the coordinated wizard is not yet built.'],
              ].map(([label, why]) => (
                <TreeItem key={label} itemType="leaf" value={`nw-${label}`}>
                  <Tooltip content={why} relationship="description">
                    <TreeItemLayout iconBefore={<Warning20Regular />}>
                      <span style={{ color: tokens.colorNeutralForeground3 }}>{label}</span>{' '}
                      <Badge size="small" appearance="tint" color="warning">coming</Badge>
                    </TreeItemLayout>
                  </Tooltip>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>
        </Tree>
      </div>

      {/* Create dialog */}
      <Dialog open={createGroup !== null} onOpenChange={(_, d) => { if (!d.open) setCreateGroup(null); }}>
        <DialogSurface style={{ maxWidth: createGroup === 'skillset' ? 680 : 560 }}>
          <DialogBody>
            <DialogTitle>
              New {createGroup === 'index' ? 'index'
                : createGroup === 'indexer' ? 'indexer'
                : createGroup === 'datasource' ? 'data source'
                : createGroup === 'skillset' ? 'skillset'
                : createGroup === 'synonymmap' ? 'synonym map'
                : createGroup === 'debugsession' ? 'debug session'
                : 'alias'}
            </DialogTitle>
            <DialogContent>
              {createGroup !== 'skillset' && (
                <Field label="Name" required>
                  <Input value={cName} onChange={(_, d) => setCName(d.value)} placeholder="lowercase-with-dashes" />
                </Field>
              )}

              {createGroup === 'index' && (
                <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
                  Creates a minimal starter index (a key <code>id</code> field + a searchable <code>content</code> field)
                  via <code>POST /indexes</code>. Add fields, analyzers, vector profiles and semantic configuration in the
                  index Schema (JSON) editor after it opens.
                </Caption1>
              )}

              {createGroup === 'indexer' && (
                <>
                  <Field label="Data source" required style={{ marginTop: tokens.spacingVerticalS }}>
                    <Dropdown value={cDataSource} selectedOptions={cDataSource ? [cDataSource] : []} placeholder={dataSourceNames.length ? 'Select a data source' : 'No data sources — create one first'} onOptionSelect={(_, d) => setCDataSource(d.optionValue || '')}>
                      {dataSourceNames.map((n) => <Option key={n} value={n} text={n}>{n}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Target index" required style={{ marginTop: tokens.spacingVerticalS }}>
                    <Dropdown value={cTargetIndex} selectedOptions={cTargetIndex ? [cTargetIndex] : []} placeholder={indexNames.length ? 'Select an index' : 'No indexes — create one first'} onOptionSelect={(_, d) => setCTargetIndex(d.optionValue || '')}>
                      {indexNames.map((n) => <Option key={n} value={n} text={n}>{n}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Skillset (optional, for AI enrichment)" style={{ marginTop: tokens.spacingVerticalS }}>
                    <Dropdown value={cSkillset} selectedOptions={cSkillset ? [cSkillset] : []} placeholder="None" onOptionSelect={(_, d) => setCSkillset(d.optionValue || '')}>
                      <Option value="" text="None">None</Option>
                      {skillsetNames.map((n) => <Option key={n} value={n} text={n}>{n}</Option>)}
                    </Dropdown>
                  </Field>
                  <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3 }}>
                    Creates the indexer via <code>PUT /indexers/{'{name}'}</code>. Per Azure, creating an indexer also
                    runs it once. Configure field mappings + schedule in the index editor / Schema JSON.
                  </Caption1>
                </>
              )}

              {createGroup === 'datasource' && (
                <>
                  <Field label="Type" style={{ marginTop: tokens.spacingVerticalS }}>
                    <Dropdown value={cDsType} selectedOptions={[cDsType]} onOptionSelect={(_, d) => setCDsType(d.optionValue || 'azureblob')}>
                      {['azureblob', 'adlsgen2', 'azuretable', 'azuresql', 'cosmosdb', 'mysql', 'onelake'].map((t) => <Option key={t} value={t} text={t}>{t}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Connection string" required style={{ marginTop: tokens.spacingVerticalS }}>
                    <Input value={cDsConn} onChange={(_, d) => setCDsConn(d.value)} placeholder="DefaultEndpointsProtocol=… OR ResourceId=… (managed identity)" />
                  </Field>
                  <Field label="Container / table / collection" required style={{ marginTop: tokens.spacingVerticalS }}>
                    <Input value={cDsContainer} onChange={(_, d) => setCDsContainer(d.value)} placeholder="my-container" />
                  </Field>
                  <Field label="Query (optional)" style={{ marginTop: tokens.spacingVerticalS }}>
                    <Input value={cDsQuery} onChange={(_, d) => setCDsQuery(d.value)} placeholder="blob path prefix / SQL query / Cosmos query" />
                  </Field>
                  <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3 }}>
                    Creates the connection via <code>PUT /datasources/{'{name}'}</code>. For managed-identity auth use a
                    <code>ResourceId=…</code> connection string and grant the search service identity access to the source.
                  </Caption1>
                </>
              )}

              {createGroup === 'skillset' && (
                <>
                  {/* Name field is shared above for all groups except skillset — render it inline here */}
                  <Field label="Name" required style={{ marginBottom: tokens.spacingVerticalS }}>
                    <Input value={cName} onChange={(_, d) => setCName(d.value)} placeholder="lowercase-with-dashes" />
                  </Field>

                  {/* Ordered skill chain */}
                  <Body1Strong style={{ display: 'block', marginBottom: tokens.spacingVerticalXS }}>
                    Skill chain ({cSkillsetSkills.length}) — runs top to bottom
                  </Body1Strong>

                  {cSkillsetSkills.length === 0 && (
                    <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalS }}>
                      No skills yet — add one below to start building the enrichment chain. Each skill can bind inputs to the
                      outputs of any skill above it.
                    </Caption1>
                  )}

                  <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                    {cSkillsetSkills.map((sk, idx) => (
                      <SkillCard
                        key={sk.id}
                        skill={sk}
                        index={idx}
                        total={cSkillsetSkills.length}
                        sourceOptions={availableSourcePaths(cSkillsetSkills, idx)}
                        contexts={contextOptions(cSkillsetSkills, idx)}
                        onMove={(dir) => {
                          setCSkillsetSkills((prev) => reorderSkill(prev, idx, dir));
                          setCSkillsetAdvancedDirty(false);
                        }}
                        onChange={(updated) => {
                          setCSkillsetSkills((prev) => prev.map((s, i) => i === idx ? updated : s));
                          setCSkillsetAdvancedDirty(false);
                        }}
                        onRemove={() => {
                          setCSkillsetSkills((prev) => prev.filter((_, i) => i !== idx));
                          setCSkillsetAdvancedDirty(false);
                        }}
                      />
                    ))}
                  </div>

                  {/* Add skill picker — grouped by category */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalS }}>
                    <Dropdown
                      size="small"
                      placeholder="Add a skill…"
                      style={{ flex: 1 }}
                      selectedOptions={[]}
                      value=""
                      onOptionSelect={(_, d) => {
                        if (!d.optionValue) return;
                        setCSkillsetSkills((prev) => [...prev, defaultSkill(d.optionValue as SkillType)]);
                        setCSkillsetAdvancedDirty(false);
                      }}
                    >
                      {skillsByCategory().map((grp) => (
                        <OptionGroup key={grp.category} label={grp.category}>
                          {grp.types.map((t) => (
                            <Option key={t} value={t} text={SKILL_CATALOG[t].label}>{SKILL_CATALOG[t].label}</Option>
                          ))}
                        </OptionGroup>
                      ))}
                    </Dropdown>
                  </div>

                  <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3 }}>
                    Assembled chain is sent via <code>PUT /skillsets/{'{name}'}</code>{cSkillsetEditing ? ' (updates the existing skillset)' : ''}.
                  </Caption1>

                  {/* Knowledge store (projections) — optional, collapsed by default */}
                  <Divider style={{ margin: `${tokens.spacingVerticalM} 0 ${tokens.spacingVerticalXS}` }} />
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, cursor: 'pointer', userSelect: 'none' }}
                    role="button" tabIndex={0}
                    onClick={() => setCKsOpen((o) => !o)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCKsOpen((o) => !o); } }}
                  >
                    {cKsOpen ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
                    <Storage16Regular style={{ color: tokens.colorBrandForeground1 }} />
                    <Body1 style={{ color: tokens.colorNeutralForeground2, flex: 1 }}>Knowledge store — project enrichments to Azure Storage</Body1>
                    {!knowledgeStoreIsEmpty(cKs) && <Badge size="small" appearance="tint" color="brand">{cKs.tables.length + cKs.objects.length + cKs.files.length} projection(s)</Badge>}
                  </div>

                  {cKsOpen && (
                    <div style={{ marginTop: tokens.spacingVerticalS }}>
                      <Field label="Storage connection string" hint="StorageV2 account that will hold the projected tables/objects/files" style={{ marginBottom: tokens.spacingVerticalS }}>
                        <Input size="small" value={cKsConn} onChange={(_, d) => setCKsConn(d.value)} placeholder="DefaultEndpointsProtocol=https;AccountName=…;AccountKey=…;" />
                      </Field>

                      {/* Table projections */}
                      <Body1Strong style={{ display: 'block', marginBottom: tokens.spacingVerticalXS }}>Table projections</Body1Strong>
                      {cKs.tables.map((t, i) => (
                        <div key={i} style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', marginTop: tokens.spacingVerticalXS }}>
                          <Input size="small" style={{ flex: 1, minWidth: 0 }} placeholder="table name" value={t.name}
                            onChange={(_, d) => setCKs((p) => ({ ...p, tables: p.tables.map((r, j) => j === i ? { ...r, name: d.value } : r) }))} aria-label="table name" />
                          <div style={{ flex: 2, minWidth: 0 }}>
                            <PathCombobox value={t.source} onChange={(v) => setCKs((p) => ({ ...p, tables: p.tables.map((r, j) => j === i ? { ...r, source: v } : r) }))}
                              options={availableSourcePaths(cSkillsetSkills, cSkillsetSkills.length)} placeholder="/document/tableprojection" />
                          </div>
                          <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove table projection"
                            onClick={() => setCKs((p) => ({ ...p, tables: p.tables.filter((_, j) => j !== i) }))} />
                        </div>
                      ))}
                      <Button size="small" appearance="subtle" icon={<Add16Regular />} style={{ marginTop: tokens.spacingVerticalXS }}
                        onClick={() => setCKs((p) => ({ ...p, tables: [...p.tables, { name: '', source: '' }] }))}>Add table</Button>

                      {/* Object projections */}
                      <Body1Strong style={{ display: 'block', marginTop: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalXS }}>Object projections (blobs)</Body1Strong>
                      {cKs.objects.map((o, i) => (
                        <div key={i} style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', marginTop: tokens.spacingVerticalXS }}>
                          <Input size="small" style={{ flex: 1, minWidth: 0 }} placeholder="container" value={o.storageContainer}
                            onChange={(_, d) => setCKs((p) => ({ ...p, objects: p.objects.map((r, j) => j === i ? { ...r, storageContainer: d.value } : r) }))} aria-label="object container" />
                          <div style={{ flex: 2, minWidth: 0 }}>
                            <PathCombobox value={o.source} onChange={(v) => setCKs((p) => ({ ...p, objects: p.objects.map((r, j) => j === i ? { ...r, source: v } : r) }))}
                              options={availableSourcePaths(cSkillsetSkills, cSkillsetSkills.length)} placeholder="/document/objectprojection" />
                          </div>
                          <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove object projection"
                            onClick={() => setCKs((p) => ({ ...p, objects: p.objects.filter((_, j) => j !== i) }))} />
                        </div>
                      ))}
                      <Button size="small" appearance="subtle" icon={<Add16Regular />} style={{ marginTop: tokens.spacingVerticalXS }}
                        onClick={() => setCKs((p) => ({ ...p, objects: [...p.objects, { storageContainer: '', source: '' }] }))}>Add object</Button>

                      {/* File projections */}
                      <Body1Strong style={{ display: 'block', marginTop: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalXS }}>File projections (images)</Body1Strong>
                      {cKs.files.map((f, i) => (
                        <div key={i} style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', marginTop: tokens.spacingVerticalXS }}>
                          <Input size="small" style={{ flex: 1, minWidth: 0 }} placeholder="container" value={f.storageContainer}
                            onChange={(_, d) => setCKs((p) => ({ ...p, files: p.files.map((r, j) => j === i ? { ...r, storageContainer: d.value } : r) }))} aria-label="file container" />
                          <div style={{ flex: 2, minWidth: 0 }}>
                            <PathCombobox value={f.source} onChange={(v) => setCKs((p) => ({ ...p, files: p.files.map((r, j) => j === i ? { ...r, source: v } : r) }))}
                              options={['/document/normalized_images/*']} placeholder="/document/normalized_images/*" />
                          </div>
                          <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove file projection"
                            onClick={() => setCKs((p) => ({ ...p, files: p.files.filter((_, j) => j !== i) }))} />
                        </div>
                      ))}
                      <Button size="small" appearance="subtle" icon={<Add16Regular />} style={{ marginTop: tokens.spacingVerticalXS }}
                        onClick={() => setCKs((p) => ({ ...p, files: [...p.files, { storageContainer: '', source: '/document/normalized_images/*' }] }))}>Add file</Button>
                    </div>
                  )}

                  {/* Advanced JSON collapsible — secondary, collapsed by default */}
                  <Divider style={{ margin: `${tokens.spacingVerticalM} 0 ${tokens.spacingVerticalXS}` }} />
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, cursor: 'pointer', userSelect: 'none' }}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (!cSkillsetAdvancedOpen) {
                        // Sync the assembled JSON into the textarea on first open (if not dirty).
                        if (!cSkillsetAdvancedDirty && cName.trim()) {
                          setCSkillsetAdvancedJson(JSON.stringify(assembleSkillsetDef(cName.trim(), cSkillsetSkills, { knowledgeStore: buildKnowledgeStore(cKsConn, cKs) }), null, 2));
                        }
                      }
                      setCSkillsetAdvancedOpen((o) => !o);
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCSkillsetAdvancedOpen((o) => !o); } }}
                  >
                    {cSkillsetAdvancedOpen ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
                    <Body1 style={{ color: tokens.colorNeutralForeground2 }}>Advanced — edit raw JSON</Body1>
                    {cSkillsetAdvancedDirty && (
                      <Badge size="small" appearance="tint" color="warning">custom JSON active</Badge>
                    )}
                  </div>

                  {cSkillsetAdvancedOpen && (
                    <>
                      <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3 }}>
                        Edit the assembled JSON directly. When saved, this overrides the guided builder above.
                        Clear this field to return to the guided builder.
                      </Caption1>
                      <Textarea
                        value={cSkillsetAdvancedJson}
                        onChange={(_, d) => {
                          setCSkillsetAdvancedJson(d.value);
                          setCSkillsetAdvancedDirty(!!d.value.trim());
                        }}
                        resize="vertical"
                        style={{ marginTop: tokens.spacingVerticalXS, minHeight: 180, fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, width: '100%' }}
                        placeholder={'{\n  "name": "my-skillset",\n  "skills": [...]\n}'}
                      />
                    </>
                  )}
                </>
              )}

              {createGroup === 'synonymmap' && (
                <>
                  <Field label="Rules (solr format, one per line)" required style={{ marginTop: tokens.spacingVerticalS }}>
                    <Textarea
                      value={cSynonyms}
                      onChange={(_, d) => setCSynonyms(d.value)}
                      resize="vertical"
                      style={{ minHeight: 120, fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200 }}
                      placeholder={'USA, United States, United States of America\nUK => United Kingdom'}
                    />
                  </Field>
                  <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3 }}>
                    Equivalency rules are comma-separated; explicit mappings use <code>=&gt;</code>. Sent via
                    <code> PUT /synonymmaps/{'{name}'}</code>. Attach the map to a field in the index Schema
                    (<code>synonymMaps</code>) to take effect.
                  </Caption1>
                </>
              )}

              {createGroup === 'alias' && (
                <>
                  <Field label="Target index" required style={{ marginTop: tokens.spacingVerticalS }}>
                    <Dropdown value={cAliasIndex} selectedOptions={cAliasIndex ? [cAliasIndex] : []} placeholder={indexNames.length ? 'Select an index' : 'No indexes — create one first'} onOptionSelect={(_, d) => setCAliasIndex(d.optionValue || '')}>
                      {indexNames.map((n) => <Option key={n} value={n} text={n}>{n}</Option>)}
                    </Dropdown>
                  </Field>
                  <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3 }}>
                    An alias maps a stable name to exactly one index (<code>PUT /aliases/{'{name}'}</code>), so you can
                    re-point queries to a rebuilt index with zero client changes.
                  </Caption1>
                </>
              )}

              {createGroup === 'debugsession' && (
                <>
                  <Field label="Indexer to trace" required style={{ marginTop: tokens.spacingVerticalS }}>
                    <Dropdown value={cDebugIndexer} selectedOptions={cDebugIndexer ? [cDebugIndexer] : []} placeholder={indexerNames.length ? 'Select an indexer' : 'No indexers — create one first'} onOptionSelect={(_, d) => setCDebugIndexer(d.optionValue || '')}>
                      {indexerNames.map((n) => <Option key={n} value={n} text={n}>{n}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Storage connection string (session state)" style={{ marginTop: tokens.spacingVerticalS }}>
                    <Input value={debugStorageConn} onChange={(_, d) => setDebugStorageConn(d.value)} placeholder="DefaultEndpointsProtocol=… (or leave blank to use LOOM_AI_SEARCH_DEBUG_STORAGE_CONN)" />
                  </Field>
                  <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3 }}>
                    A debug session captures a single-document enrichment trace for the chosen indexer + skillset, written to
                    the <code>ms-az-cognitive-search-debugsession</code> container on the storage account. The search service&apos;s
                    managed identity needs <strong>Storage Blob Data Contributor</strong> on that account
                    (bicep: <code>ai-search.bicep debugSessionStorageId</code>). In a private-endpoint-locked deployment the session
                    also requires a shared private link from the search service to storage and <code>executionEnvironment:&quot;private&quot;</code>
                    on the indexer. The visual skill-graph trace is rendered in the Azure portal — open the session there to inspect it.
                  </Caption1>
                  {debugGate && !debugGate.storageConfigured && !debugStorageConn.trim() && (
                    <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalS }}><MessageBarBody>
                      No <code>LOOM_AI_SEARCH_DEBUG_STORAGE_CONN</code> is set — supply a storage connection string above, or set the env var on the Console Container App.
                    </MessageBarBody></MessageBar>
                  )}
                </>
              )}

              {createError && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}><MessageBarBody><MessageBarTitle>Create failed</MessageBarTitle>{createError}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCreateGroup(null)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={submitCreate} disabled={busy}>{busy ? 'Creating…' : 'Create'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
