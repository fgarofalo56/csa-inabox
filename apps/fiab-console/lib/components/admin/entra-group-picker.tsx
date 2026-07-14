'use client';

/**
 * EntraGroupPicker — a reusable Entra (Azure AD) security-group picker.
 *
 * Extracted so every surface that binds an admin/member group (domain settings,
 * the Add-landing-zone wizard, the logical-LZ create step) uses ONE real,
 * backed picker instead of a free-form object-id Input (loom-no-freeform-config).
 * It searches live via GET /api/admin/permissions/principals?q=…&kind=group
 * (Microsoft Graph) and returns the chosen group's object id. When Graph search
 * isn't configured the route honest-gates and this shows the remediation
 * (no-vaporware) — the caller can still paste a valid GUID as a fallback.
 *
 * Fluent v9 + Loom tokens only.
 */
import { useEffect, useState } from 'react';
import {
  Field, Input, Spinner, Caption1, TagGroup, Tag,
  MessageBar, MessageBarBody, makeStyles, tokens,
} from '@fluentui/react-components';
import { clientFetch } from '@/lib/client-fetch';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const useStyles = makeStyles({
  results: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    marginTop: tokens.spacingVerticalXS,
    maxHeight: '180px',
    overflowY: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  row: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '2px',
    padding: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    backgroundColor: 'transparent',
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    textAlign: 'left',
    width: '100%',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  note: { color: tokens.colorNeutralForeground3 },
  tag: { marginTop: tokens.spacingVerticalXS },
});

export function EntraGroupPicker({
  label, value, onChange, disabled, hint,
}: {
  label: string;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const styles = useStyles();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Array<{ id: string; displayName: string; mail?: string }>>([]);
  const [searching, setSearching] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [chosenName, setChosenName] = useState('');

  useEffect(() => {
    const term = q.trim();
    // Let a pasted GUID stand on its own (the honest-gate fallback) — don't search it.
    if (term.length < 2 || GUID_RE.test(term)) { setResults([]); setGate(null); return; }
    const t = setTimeout(async () => {
      setSearching(true); setGate(null);
      try {
        const r = await clientFetch(`/api/admin/permissions/principals?q=${encodeURIComponent(term)}&kind=group`);
        const j = await r.json().catch(() => ({}));
        if (r.status === 503 || j?.ok === false) {
          setGate(j?.remediation || j?.error || 'Microsoft Graph group search is not configured — paste the group object id (GUID) instead.');
          setResults([]);
        } else {
          setResults((j.results || []).map((p: any) => ({ id: p.id, displayName: p.displayName, mail: p.mail })));
        }
      } catch (e: any) {
        setGate(e?.message || String(e));
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <Field label={label} hint={hint}>
      {value ? (
        <TagGroup className={styles.tag} onDismiss={() => { onChange(''); setChosenName(''); }} aria-label={label}>
          <Tag value={value} dismissible dismissIcon={{ 'aria-label': 'Remove group' }}>
            {chosenName || value}
          </Tag>
        </TagGroup>
      ) : (
        <Input
          value={q}
          disabled={disabled}
          placeholder="Search Entra security groups… (or paste the group object id)"
          onChange={(_e, d) => {
            setQ(d.value);
            // A pasted GUID is directly accepted as the group id (honest fallback).
            if (GUID_RE.test(d.value.trim())) { onChange(d.value.trim()); setChosenName(d.value.trim()); }
          }}
        />
      )}
      {searching && <Spinner size="tiny" label="Searching Entra…" />}
      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>{gate}</MessageBarBody>
        </MessageBar>
      )}
      {!value && results.length > 0 && (
        <div className={styles.results}>
          {results.map((g) => (
            <button
              key={g.id}
              type="button"
              className={styles.row}
              onClick={() => { onChange(g.id); setChosenName(g.displayName); setQ(''); setResults([]); }}
            >
              <span>{g.displayName}</span>
              {g.mail && <Caption1 className={styles.note}>{g.mail}</Caption1>}
            </button>
          ))}
        </div>
      )}
    </Field>
  );
}

export default EntraGroupPicker;
