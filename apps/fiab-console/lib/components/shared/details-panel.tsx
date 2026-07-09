'use client';

/**
 * DetailsPanel (SC-2) — right-docked item-details panel, one-for-one with the
 * Fabric Eventhouse/KQL "Database details" panel captured in
 * PRPs/active/next-waves/fabric-ux-observations.md §"Eventhouse / KQL Database":
 *
 *   RIGHT DETAILS PANEL: Database details — Compressed/Original size stats,
 *   OneLake availability toggle, Overview facts (created by/on, region,
 *   Query URI + MCP Server URI with Copy buttons, caching policy + retention
 *   policy with inline edit pencils), Related elements w/ find-by-name.
 *
 * Contract (die-hard, per the task spec): this component is PURELY
 * PRESENTATIONAL. It NEVER fetches. Callers pass:
 *   - typed `sections` (stat rows, copyable URI rows, inline-editable policy
 *     rows) and
 *   - per-policy `onSave` handlers that PATCH the item's REAL policy route.
 * That keeps the panel Azure-native by construction — the URIs and PATCH
 * targets come from the caller's live backend, never from this file, and there
 * is no Fabric dependency here (see .claude/rules/no-fabric-dependency.md).
 *
 * Fluent v9 + Loom tokens only; no raw px/hex. Theme-aware (light + dark).
 */

import { ReactNode, useCallback, useMemo, useState } from 'react';
import {
  makeStyles, tokens, mergeClasses,
  Subtitle2, Body1, Caption1, Button, Tooltip, Input, Select, Switch,
  Spinner, Divider, MessageBar, MessageBarBody, SearchBox,
} from '@fluentui/react-components';
import {
  Copy16Regular, Checkmark16Regular, Edit16Regular,
  Dismiss16Regular, Save16Regular, Open16Regular, Dismiss20Regular,
} from '@fluentui/react-icons';

/** A read-only labelled statistic (e.g. "Compressed size" → "1.2 GB"). */
export interface StatRow {
  key: string;
  label: string;
  value: ReactNode;
  /** Optional caption rendered beneath the value. */
  hint?: string;
}

/** A copyable URI / connection-string row with a Copy button + optional Open. */
export interface UriRow {
  key: string;
  label: string;
  /** The exact string copied to the clipboard. */
  value: string;
  /** When set, an Open-in-new-tab affordance is shown. */
  href?: string;
  /** Render the value monospaced (default true — these are URIs). */
  mono?: boolean;
}

export type PolicyValueType = 'number' | 'text' | 'boolean' | 'select';

/**
 * An inline-editable policy row. The pencil switches the row into an inline
 * field; Save calls `onSave(next)` — the caller's PATCH to the real backend.
 */
export interface PolicyRow {
  key: string;
  label: string;
  value: string | number | boolean;
  /** Pre-formatted display node; falls back to String(value) + unit. */
  display?: ReactNode;
  type?: PolicyValueType;
  /** Suffix shown in the display + editor, e.g. "days". */
  unit?: string;
  min?: number;
  max?: number;
  /** Options for `type: 'select'`. */
  options?: Array<{ value: string; label: string }>;
  /** Default true. When false the pencil is hidden (read-only policy). */
  editable?: boolean;
  hint?: string;
  /**
   * Caller-provided PATCH to the item's REAL policy route. Must resolve
   * `{ ok }` — the panel shows the returned error inline on failure and only
   * collapses the editor on success.
   */
  onSave: (next: string | number | boolean) => Promise<{ ok: boolean; error?: string }>;
}

export interface DetailsSection {
  key: string;
  title: string;
  stats?: StatRow[];
  uris?: UriRow[];
  policies?: PolicyRow[];
}

export interface RelatedElement {
  id: string;
  name: string;
  /** e.g. "Table", "Function", "Materialized view". */
  kind?: string;
  icon?: ReactNode;
  onClick?: () => void;
  href?: string;
}

export interface DetailsPanelProps {
  /** Panel header, e.g. "Database details". */
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  sections: DetailsSection[];
  related?: {
    title?: string;
    items: RelatedElement[];
    /** Shown when items is empty (or filtered to empty). */
    emptyText?: string;
  };
  /** Optional collapse/close affordance in the header. */
  onClose?: () => void;
  loading?: boolean;
  error?: string;
  /** Docked width; default 320. Accepts a token-ish string or px number. */
  width?: number | string;
  className?: string;
}

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    height: '100%',
    backgroundColor: tokens.colorNeutralBackground1,
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    borderTopLeftRadius: tokens.borderRadiusLarge,
    borderBottomLeftRadius: tokens.borderRadiusLarge,
    overflow: 'hidden',
    boxShadow: tokens.shadow4,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalM,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  headerText: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 0' },
  headerIcon: { color: tokens.colorBrandForeground1, display: 'inline-flex', flex: '0 0 auto' },
  body: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalXL,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
  },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  sectionTitle: {
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    letterSpacing: '0.4px',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  statRow: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
  },
  statLabel: { color: tokens.colorNeutralForeground3, flex: '0 0 auto' },
  statValue: { fontWeight: tokens.fontWeightSemibold, textAlign: 'right', minWidth: 0, wordBreak: 'break-word' },
  uriRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  uriHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS },
  uriActions: { display: 'inline-flex', gap: tokens.spacingHorizontalXXS, flex: '0 0 auto' },
  uriValue: {
    fontFamily: 'var(--loom-font-mono, monospace)',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    overflowWrap: 'anywhere',
    userSelect: 'all',
  },
  policyRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  policyHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS },
  policyLabel: { color: tokens.colorNeutralForeground3 },
  policyValue: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, fontWeight: tokens.fontWeightSemibold },
  editRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground4 },
  relatedList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  relatedItem: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    textDecoration: 'none',
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  relatedIcon: { color: tokens.colorBrandForeground1, flex: '0 0 auto', display: 'inline-flex' },
  relatedName: { flex: '1 1 0', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  relatedKind: { color: tokens.colorNeutralForeground4, flex: '0 0 auto' },
  center: { display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: tokens.spacingVerticalXXL, paddingBottom: tokens.spacingVerticalXXL },
});

/** Copyable URI row with Tooltip "Copied" feedback (Fabric parity). */
function UriRowView({ row }: { row: UriRow }) {
  const s = useStyles();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    try {
      void navigator.clipboard?.writeText(row.value).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        },
        () => { /* clipboard blocked — no-op */ },
      );
    } catch { /* clipboard unavailable */ }
  }, [row.value]);
  return (
    <div className={s.uriRow}>
      <div className={s.uriHead}>
        <Caption1 className={s.statLabel}>{row.label}</Caption1>
        <div className={s.uriActions}>
          <Tooltip content={copied ? 'Copied' : 'Copy to clipboard'} relationship="label" visible={copied ? true : undefined}>
            <Button
              size="small"
              appearance="subtle"
              icon={copied ? <Checkmark16Regular /> : <Copy16Regular />}
              onClick={copy}
              aria-label={`Copy ${row.label}`}
            />
          </Tooltip>
          {row.href && (
            <Tooltip content="Open in new tab" relationship="label">
              <Button
                as="a"
                size="small"
                appearance="subtle"
                icon={<Open16Regular />}
                {...{ href: row.href, target: '_blank', rel: 'noreferrer' }}
                aria-label={`Open ${row.label}`}
              />
            </Tooltip>
          )}
        </div>
      </div>
      <code className={s.uriValue} title={row.value}>{row.value}</code>
    </div>
  );
}

/** Inline-editable policy row: pencil → field → Save (PATCH via onSave). */
function PolicyRowView({ row }: { row: PolicyRow }) {
  const s = useStyles();
  const editable = row.editable !== false;
  const type: PolicyValueType = row.type ?? 'text';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | number | boolean>(row.value);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const begin = useCallback(() => {
    setDraft(row.value);
    setErr(null);
    setEditing(true);
  }, [row.value]);

  const cancel = useCallback(() => {
    setEditing(false);
    setErr(null);
  }, []);

  const save = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await row.onSave(draft);
      if (res.ok) {
        setEditing(false);
      } else {
        setErr(res.error || 'Update failed');
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [draft, row]);

  const displayNode: ReactNode = row.display ?? (
    type === 'boolean'
      ? (row.value ? 'On' : 'Off')
      : `${String(row.value)}${row.unit ? ` ${row.unit}` : ''}`
  );

  return (
    <div className={s.policyRow}>
      <div className={s.policyHead}>
        <Caption1 className={s.policyLabel}>{row.label}</Caption1>
        {!editing && editable && (
          <Tooltip content={`Edit ${row.label}`} relationship="label">
            <Button size="small" appearance="subtle" icon={<Edit16Regular />} onClick={begin} aria-label={`Edit ${row.label}`} />
          </Tooltip>
        )}
      </div>
      {!editing && <Body1 className={s.policyValue}>{displayNode}</Body1>}
      {editing && (
        <div className={s.editRow}>
          {type === 'boolean' && (
            <Switch
              checked={!!draft}
              onChange={(_, d) => setDraft(d.checked)}
              label={draft ? 'On' : 'Off'}
              aria-label={row.label}
            />
          )}
          {type === 'select' && (
            <Select
              value={String(draft)}
              onChange={(_, d) => setDraft(d.value)}
              aria-label={row.label}
              disabled={busy}
            >
              {(row.options ?? []).map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          )}
          {(type === 'number' || type === 'text') && (
            <Input
              type={type === 'number' ? 'number' : 'text'}
              value={String(draft)}
              min={row.min}
              max={row.max}
              disabled={busy}
              onChange={(_, d) => setDraft(type === 'number' ? Number(d.value) : d.value)}
              contentAfter={row.unit ? <Caption1>{row.unit}</Caption1> : undefined}
              aria-label={row.label}
              style={{ maxWidth: '160px' }}
            />
          )}
          <Button
            size="small"
            appearance="primary"
            icon={busy ? <Spinner size="tiny" /> : <Save16Regular />}
            onClick={save}
            disabled={busy}
            aria-label={`Save ${row.label}`}
          >
            Save
          </Button>
          <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={cancel} disabled={busy} aria-label="Cancel" />
        </div>
      )}
      {row.hint && !editing && <Caption1 className={s.hint}>{row.hint}</Caption1>}
      {err && (
        <MessageBar intent="error">
          <MessageBarBody>{err}</MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

/** Related-elements list with a find-by-name filter (Fabric parity). */
function RelatedList({ related }: { related: NonNullable<DetailsPanelProps['related']> }) {
  const s = useStyles();
  const [filter, setFilter] = useState('');
  const items = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return related.items;
    return related.items.filter((it) => it.name.toLowerCase().includes(q) || (it.kind ?? '').toLowerCase().includes(q));
  }, [filter, related.items]);
  return (
    <div className={s.section}>
      <Caption1 className={s.sectionTitle}>{related.title ?? 'Related elements'}</Caption1>
      <SearchBox
        value={filter}
        onChange={(_, d) => setFilter(d.value)}
        placeholder="Find by name"
        aria-label="Find related elements by name"
        size="small"
      />
      <div className={s.relatedList}>
        {items.map((it) => {
          const content = (
            <>
              {it.icon && <span className={s.relatedIcon} aria-hidden>{it.icon}</span>}
              <span className={s.relatedName} title={it.name}>{it.name}</span>
              {it.kind && <Caption1 className={s.relatedKind}>{it.kind}</Caption1>}
            </>
          );
          if (it.href) {
            return (
              <a key={it.id} className={s.relatedItem} href={it.href} title={it.name}>{content}</a>
            );
          }
          return (
            <div
              key={it.id}
              className={s.relatedItem}
              role="button"
              tabIndex={0}
              onClick={it.onClick}
              onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && it.onClick) { e.preventDefault(); it.onClick(); } }}
              title={it.name}
            >
              {content}
            </div>
          );
        })}
        {items.length === 0 && (
          <Caption1 className={s.hint}>{related.emptyText ?? 'No related elements.'}</Caption1>
        )}
      </div>
    </div>
  );
}

export function DetailsPanel({
  title, subtitle, icon, sections, related, onClose, loading, error, width = 320, className,
}: DetailsPanelProps) {
  const s = useStyles();
  return (
    <aside
      className={mergeClasses(s.root, className)}
      style={{ width: typeof width === 'number' ? `${width}px` : width, flex: `0 0 ${typeof width === 'number' ? `${width}px` : width}` }}
      aria-label={title}
    >
      <div className={s.header}>
        {icon && <span className={s.headerIcon} aria-hidden>{icon}</span>}
        <div className={s.headerText}>
          <Subtitle2>{title}</Subtitle2>
          {subtitle && <Caption1 className={s.statLabel}>{subtitle}</Caption1>}
        </div>
        {onClose && (
          <Tooltip content="Close details" relationship="label">
            <Button size="small" appearance="subtle" icon={<Dismiss20Regular />} onClick={onClose} aria-label="Close details" />
          </Tooltip>
        )}
      </div>

      <div className={s.body}>
        {loading && (
          <div className={s.center}><Spinner size="small" label="Loading details…" /></div>
        )}
        {error && !loading && (
          <MessageBar intent="warning">
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        )}

        {!loading && sections.map((sec, i) => {
          const hasContent = (sec.stats?.length || sec.uris?.length || sec.policies?.length);
          if (!hasContent) return null;
          return (
            <div key={sec.key} className={s.section}>
              {i > 0 && <Divider />}
              <Caption1 className={s.sectionTitle}>{sec.title}</Caption1>
              {sec.stats?.map((st) => (
                <div key={st.key} className={s.statRow}>
                  <Caption1 className={s.statLabel}>{st.label}</Caption1>
                  <div style={{ minWidth: 0 }}>
                    <Body1 className={s.statValue}>{st.value}</Body1>
                    {st.hint && <Caption1 className={s.hint}>{st.hint}</Caption1>}
                  </div>
                </div>
              ))}
              {sec.uris?.map((u) => <UriRowView key={u.key} row={u} />)}
              {sec.policies?.map((p) => <PolicyRowView key={p.key} row={p} />)}
            </div>
          );
        })}

        {related && <RelatedList related={related} />}
      </div>
    </aside>
  );
}

export default DetailsPanel;
