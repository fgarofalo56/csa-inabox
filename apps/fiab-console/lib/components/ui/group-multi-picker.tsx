'use client';

/**
 * GroupMultiPicker — multi-select Entra **security-group** picker backed by real
 * Microsoft Graph search. Used by the tenant-settings "Apply to" scope control
 * (F2) to choose the security groups a toggle applies to (or is excepted from).
 *
 * Mirrors Fabric's tenant-setting group picker: type to search, click a result
 * to add it as a chip, click the chip's X (or the result again) to remove it.
 * Group-kind only (no users / SPNs) — matches Fabric's security-group-only
 * restriction.
 *
 * Backend: GET /api/governance/identities/search?kind=group (graph-identity-
 * client.ts → searchGroups). When the Console UAMI lacks Group.Read.All (or the
 * picker env is unset) the BFF returns 503 and this renders an honest Fluent
 * MessageBar naming the exact grant — never a blank list or a fake result
 * (per no-vaporware.md).
 */

import { useState, useCallback, useEffect } from 'react';
import {
  Input, Field, Persona, Spinner, Button, Tag, TagGroup,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Search16Regular, People16Regular } from '@fluentui/react-icons';
import type { IdentityHit } from '@/lib/components/ui/identity-picker';

interface RoleHint { name: string; appRoleId: string; scope?: string; reason?: string }
interface NotConfiguredHint {
  missingEnvVar?: string; bicepModule?: string; rolesRequired?: RoleHint[]; followUp?: string;
}
interface PickerError { message: string; remediation?: string; hint?: NotConfiguredHint }

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '320px' },
  results: {
    maxHeight: '220px', overflowY: 'auto', borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, padding: '4px',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  row: {
    display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px',
    borderRadius: tokens.borderRadiusMedium, cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  rowSelected: { backgroundColor: tokens.colorBrandBackground2 },
  empty: { padding: '8px', color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  hintCode: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, display: 'block', padding: '2px 0' },
});

export interface GroupMultiPickerProps {
  selected: IdentityHit[];
  onSelectionChange: (groups: IdentityHit[]) => void;
  disabled?: boolean;
  label?: string;
  apiBase?: string;
}

export function GroupMultiPicker({
  selected,
  onSelectionChange,
  disabled = false,
  label = 'Add security groups',
  apiBase = '/api/governance/identities/search',
}: GroupMultiPickerProps) {
  const styles = useStyles();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<IdentityHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<PickerError | null>(null);

  const selectedIds = new Set(selected.map((g) => g.id));

  useEffect(() => {
    if (disabled) return;
    const phrase = q.trim();
    if (phrase.length < 2) { setHits([]); setError(null); setLoading(false); return; }
    const handle = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${apiBase}?q=${encodeURIComponent(phrase)}&kind=group`, { cache: 'no-store' });
        const json = await res.json();
        if (!res.ok || !json?.ok) {
          setError({ message: json?.error || `Graph ${res.status}`, remediation: json?.remediation, hint: json?.hint });
          setHits([]);
        } else {
          setHits(json.results || []);
        }
      } catch (e: any) {
        setError({ message: e?.message || String(e) });
        setHits([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [q, apiBase, disabled]);

  const toggle = useCallback((h: IdentityHit) => {
    if (selectedIds.has(h.id)) {
      onSelectionChange(selected.filter((g) => g.id !== h.id));
    } else {
      onSelectionChange([...selected, { ...h, type: 'group' }]);
    }
  }, [selected, onSelectionChange]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = useCallback((id: string) => {
    onSelectionChange(selected.filter((g) => g.id !== id));
  }, [selected, onSelectionChange]);

  return (
    <div className={styles.root}>
      {selected.length > 0 && (
        <TagGroup
          onDismiss={(_e, d) => remove(String(d.value))}
          aria-label="Selected security groups"
        >
          {selected.map((g) => (
            <Tag
              key={g.id}
              value={g.id}
              dismissible={!disabled}
              media={<People16Regular />}
              secondaryText={g.mail || g.description || 'group'}
            >
              {g.displayName}
            </Tag>
          ))}
        </TagGroup>
      )}

      <Field label={label}>
        <Input
          value={q}
          onChange={(_e, d) => setQ(d.value)}
          placeholder="Group display name"
          contentBefore={<Search16Regular />}
          disabled={disabled}
        />
      </Field>

      {error && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>{error.message}</MessageBarTitle>
            {error.remediation && <div style={{ marginTop: 4 }}>{error.remediation}</div>}
            {error.hint?.rolesRequired && error.hint.rolesRequired.length > 0 && (
              <div style={{ marginTop: 6 }}>
                Grant the Console UAMI these Microsoft Graph application permissions:
                {error.hint.rolesRequired.map((r) => (
                  <code key={r.appRoleId} className={styles.hintCode}>{r.name} — {r.appRoleId}</code>
                ))}
              </div>
            )}
            {error.hint?.followUp && <div style={{ marginTop: 6 }}>{error.hint.followUp}</div>}
          </MessageBarBody>
        </MessageBar>
      )}

      {q.trim().length >= 2 && (
        <div className={styles.results}>
          {loading && <Spinner size="tiny" label="Searching Entra groups…" />}
          {!loading && !error && hits.length === 0 && <div className={styles.empty}>No matching groups.</div>}
          {!loading && hits.map((h) => {
            const isSelected = selectedIds.has(h.id);
            return (
              <div
                key={h.id}
                className={`${styles.row} ${isSelected ? styles.rowSelected : ''}`}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                onClick={() => toggle(h)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(h); } }}
              >
                <People16Regular />
                <Persona name={h.displayName} secondaryText={h.description || h.mail || 'group'} presence={undefined as any} />
                {isSelected && <span style={{ marginLeft: 'auto', fontSize: 12, color: tokens.colorBrandForeground1 }}>Added</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default GroupMultiPicker;
