/**
 * M3 — translation orchestrator. Consumes the translatable-source rows M1's
 * ReadinessReport identifies (sql-view / stored-routine / DAX measure / report)
 * and dispatches each to the right HONEST transpiler, returning a per-construct
 * review diff plus a DRAFT Loom-item payload for the accepted artifacts.
 *
 * Pure — composes the pure `sql-transpile` (Snowflake/T-SQL → Loom SQL) and
 * `artifact-transpile` (DAX → N9 measure via the A1 parser; report → N16
 * code-report via the N16 parser) modules. No Azure/Cosmos/React here, so it
 * runs in the client review-diff and the server route with zero drift.
 *
 * DIE-HARD HONESTY: an artifact whose translation is not confident is returned
 * `status:'needs-review'` with the exact reason and `generated: null` (or, for a
 * DAX measure that parses but does not fold, a FAITHFUL verbatim carry-over —
 * never a rewritten guess). Nothing is fabricated.
 *
 * Generated artifacts are returned as DRAFT item payloads (never auto-published)
 * — the route/UI creates them through the normal audited item-create path, so
 * draft/publish semantics are the platform's existing ones.
 */
import { transpileSql, type SqlSourceDialect, type SqlConstructFlag } from './sql-transpile';
import {
  translateDaxMeasure, translateReport,
  type SemanticContractMetricDraft, type ReportDescriptor,
} from './artifact-transpile';
import type { MigrationSourceType } from './assessment';

export type { SqlConstructFlag } from './sql-transpile';

/** The translatable-source kinds M3 handles (a subset of M1's SourceObjectKind
 * — the rows that carry re-expressible source: view SQL, routine SQL, a DAX
 * measure, or a report definition). */
export type TranslateKind = 'sql-view' | 'stored-routine' | 'dax-measure' | 'report';

/** One artifact to translate (the caller supplies the actual source text /
 * descriptor — M1's report only flags WHICH objects carry translatable source). */
export interface TranslateInput {
  kind: TranslateKind;
  name: string;
  sourceType?: MigrationSourceType;
  /** SQL kinds: which source dialect the SQL is written in. */
  dialect?: SqlSourceDialect;
  /** SQL kinds: the view / routine body. */
  sql?: string;
  /** DAX kind: the measure expression + its home table. */
  dax?: string;
  table?: string;
  /** Report kind: the enumerated report descriptor (queries + visuals). */
  report?: ReportDescriptor;
}

/** A draft Loom item ready to be created through the normal item-create path. */
export interface DraftItemPayload {
  itemType: string;
  displayName: string;
  description?: string;
  /** Initial item state — carries the generated body + a `migration` provenance
   * block with `draft:true` and the per-construct needs-review flags. */
  state: Record<string, unknown>;
}

/** The generated artifact's language (drives the diff pane's syntax label). */
export type ArtifactLanguage = 'sql' | 'dax' | 'code-report';

/** One artifact's translation — the review-diff row. */
export interface ArtifactTranslation {
  kind: TranslateKind;
  name: string;
  status: 'supported' | 'needs-review';
  language: ArtifactLanguage;
  /** The source, verbatim (diff left pane). */
  source: string;
  /** The generated Loom artifact (diff right pane) — `null` when not confidently
   * generated (needs-review); NEVER a fabricated translation. */
  generated: string | null;
  /** Per-construct supported / needs-review rows (reason each). */
  constructs: SqlConstructFlag[];
  /** A one-line summary reason (needs-review artifacts especially). */
  reason: string;
  /** The draft item to create on accept (absent when nothing is safely creatable). */
  draftItem?: DraftItemPayload;
  /** A DAX measure's governed-metric draft for N9 (route maps it to registerMetric). */
  metricDraft?: SemanticContractMetricDraft;
}

export interface TranslationResult {
  artifacts: ArtifactTranslation[];
  totals: { total: number; supported: number; needsReview: number };
}

function migrationProvenance(input: TranslateInput, flags: SqlConstructFlag[]): Record<string, unknown> {
  return {
    draft: true,
    generatedFrom: input.kind,
    sourceType: input.sourceType,
    sourceName: input.name,
    needsReview: flags.filter((f) => !f.supported).map((f) => ({ construct: f.construct, reason: f.reason })),
    translatedAt: new Date().toISOString(),
  };
}

/** Translate one artifact → its review-diff row (+ a draft item when creatable). */
export function translateArtifact(input: TranslateInput, opts: { owner?: string } = {}): ArtifactTranslation {
  const name = String(input.name || '').trim() || 'artifact';

  if (input.kind === 'sql-view' || input.kind === 'stored-routine') {
    const dialect: SqlSourceDialect = input.dialect === 'tsql' ? 'tsql' : 'snowflake';
    const r = transpileSql(String(input.sql ?? ''), dialect);
    const constructs = r.statements.flatMap((s) => s.flags);
    const supported = r.supported && input.kind === 'sql-view';
    const reason = supported
      ? `Translated ${r.statements.length} statement(s) to Loom SQL.`
      : input.kind === 'stored-routine'
        ? 'A stored routine has no 1:1 Loom item — re-implement it as a Loom user-data-function or notebook (mirrors M1 stored-routine → needs-review).'
        : `${r.needsReviewCount} statement(s) need review — see the per-construct reasons.`;
    const draftItem: DraftItemPayload | undefined = supported
      ? {
          itemType: 'warehouse',
          displayName: name,
          description: `Migrated ${dialect === 'tsql' ? 'T-SQL' : 'Snowflake'} view → Loom SQL (draft).`,
          state: { migration: migrationProvenance(input, constructs), sql: r.loomSql, sqlKind: 'view' },
        }
      : undefined;
    return {
      kind: input.kind, name, status: supported ? 'supported' : 'needs-review', language: 'sql',
      source: String(input.sql ?? '').trim(), generated: r.loomSql, constructs, reason, draftItem,
    };
  }

  if (input.kind === 'dax-measure') {
    const t = translateDaxMeasure(name, String(input.table ?? ''), String(input.dax ?? ''), { owner: opts.owner });
    const constructs: SqlConstructFlag[] = [{ construct: 'DAX measure', supported: t.supported, reason: t.reason }];
    // A measure that PARSES is a faithful measure carry-over (draft semantic-model);
    // one that does not parse yields no draft (malformed = error, never silent).
    const draftItem: DraftItemPayload | undefined = t.metricDraft
      ? {
          itemType: 'semantic-model',
          displayName: name,
          description: `Migrated DAX measure${input.table ? ` from "${input.table}"` : ''} (draft).`,
          state: {
            migration: migrationProvenance(input, constructs),
            measures: [{ name, table: String(input.table ?? ''), expression: t.sourceDax }],
            loomNativeSql: t.loomNativeSql,
          },
        }
      : undefined;
    return {
      kind: input.kind, name, status: t.supported ? 'supported' : 'needs-review', language: 'dax',
      source: t.sourceDax, generated: t.loomNativeSql, constructs, reason: t.reason,
      draftItem, metricDraft: t.metricDraft,
    };
  }

  // report
  const desc = input.report ?? { name, queries: [], visuals: [] };
  const t = translateReport({ ...desc, name: desc.name || name });
  const constructs: SqlConstructFlag[] = [{ construct: 'code-report', supported: t.supported, reason: t.reason }];
  const draftItem: DraftItemPayload | undefined = t.supported
    ? {
        itemType: 'code-report',
        displayName: name,
        description: 'Migrated Power BI / Fabric report → Loom code-report (draft).',
        state: { migration: migrationProvenance(input, constructs), source: t.source },
      }
    : undefined;
  return {
    kind: 'report', name, status: t.supported ? 'supported' : 'needs-review', language: 'code-report',
    source: JSON.stringify(desc, null, 2), generated: t.source, constructs, reason: t.reason, draftItem,
  };
}

/** Translate a batch of artifacts → the full review result + roll-up totals. */
export function translateBatch(inputs: TranslateInput[], opts: { owner?: string } = {}): TranslationResult {
  const artifacts = inputs.map((i) => translateArtifact(i, opts));
  const supported = artifacts.filter((a) => a.status === 'supported').length;
  return {
    artifacts,
    totals: { total: artifacts.length, supported, needsReview: artifacts.length - supported },
  };
}
