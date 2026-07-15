'use client';

/**
 * DP-17 — shared owners people-picker.
 *
 * A search-as-you-type Microsoft Graph people-picker that writes the rich
 * `{ id, upn, displayName }` owner shape. Extracted from the data-product create
 * wizard so the edit dialog and the studio editor reuse the SAME control instead
 * of a comma-separated `<Input>` (a `loom_no_freeform_config` violation). Backed
 * by the real `/api/admin/permissions/principals` Graph search — Gov resolves
 * its own Graph endpoint there, per no-fabric-dependency.md.
 */

import { useCallback, useRef, useState } from 'react';
import {
  Button, Field, Input, Persona, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { PersonAdd20Regular, Dismiss16Regular } from '@fluentui/react-icons';

/** The rich owner shape persisted on `state.owners[]`. */
export interface OwnerRef { id: string; upn: string; displayName: string }
interface PrincipalResult { id: string; upn?: string; displayName?: string; mail?: string }

const useStyles = makeStyles({
  results: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    maxHeight: '220px', overflow: 'auto',
  },
  result: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalSNudge} ${tokens.spacingHorizontalM}`, cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  chips: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, marginTop: tokens.spacingVerticalXS },
  chip: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalSNudge} ${tokens.spacingHorizontalS}`, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
});

export interface OwnerPeoplePickerProps {
  owners: OwnerRef[];
  onChange: (owners: OwnerRef[]) => void;
  /** Field label (defaults to "Owners"). */
  label?: string;
  /** Field required marker + hint text. */
  required?: boolean;
  hint?: string;
}

/**
 * Reusable owners picker. Debounced (300 ms) Graph search, add/remove chips,
 * de-dupes by principal id. Writes `OwnerRef[]` upward — never a delimited
 * string.
 */
export function OwnerPeoplePicker({
  owners, onChange,
  label = 'Owners',
  required,
  hint = 'Search your directory (Microsoft Graph) and add owners.',
}: OwnerPeoplePickerProps) {
  const s = useStyles();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PrincipalResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback((q: string) => {
    setQuery(q);
    if (debounce.current) clearTimeout(debounce.current);
    if (!q.trim()) { setResults([]); setError(undefined); return; }
    debounce.current = setTimeout(async () => {
      setSearching(true); setError(undefined);
      try {
        const r = await fetch(`/api/admin/permissions/principals?kind=user&q=${encodeURIComponent(q.trim())}`);
        const j = await r.json();
        if (j.ok) setResults(j.results || []);
        else { setResults([]); setError(j.remediation || j.error || `Search failed (HTTP ${r.status}).`); }
      } catch (e: any) {
        setResults([]); setError(e?.message || String(e));
      } finally { setSearching(false); }
    }, 300);
  }, []);

  const add = useCallback((p: PrincipalResult) => {
    onChange(
      owners.some((o) => o.id === p.id)
        ? owners
        : [...owners, { id: p.id, upn: p.upn || p.mail || '', displayName: p.displayName || p.upn || p.id }],
    );
    setQuery(''); setResults([]);
  }, [owners, onChange]);

  const remove = useCallback((id: string) => onChange(owners.filter((o) => o.id !== id)), [owners, onChange]);

  return (
    <>
      <Field label={label} required={required} hint={hint}>
        <Input
          value={query}
          onChange={(_, d) => runSearch(d.value)}
          placeholder="Search by name or UPN…"
          contentBefore={<PersonAdd20Regular />}
          contentAfter={searching ? <Spinner size="tiny" /> : undefined}
        />
      </Field>
      {error && (
        <MessageBar intent="warning">
          <MessageBarBody><MessageBarTitle>Directory search unavailable</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}
      {results.length > 0 && (
        <div className={s.results}>
          {results.map((p) => (
            <div key={p.id} className={s.result} onClick={() => add(p)} role="button" tabIndex={0}>
              <Persona name={p.displayName || p.upn || p.id} secondaryText={p.upn || p.mail} avatar={{ color: 'colorful' }} />
              <Button size="small" appearance="subtle" icon={<PersonAdd20Regular />} aria-label={`Add ${p.displayName || p.id}`}>Add</Button>
            </div>
          ))}
        </div>
      )}
      {owners.length > 0 && (
        <div className={s.chips}>
          {owners.map((o) => (
            <div key={o.id} className={s.chip}>
              <Persona name={o.displayName} secondaryText={o.upn} avatar={{ color: 'colorful' }} />
              <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${o.displayName}`} onClick={() => remove(o.id)} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default OwnerPeoplePicker;
