'use client';

/**
 * CustomAttributesForm (F17)
 * --------------------------
 * Renders the admin-defined attribute schema for a given domain as a live
 * form. Consumed by:
 *   - the Create wizard's "Custom attributes" step (page 3), and
 *   - item Edit dialogs for domain-scoped items.
 *
 * It fetches `GET /api/attribute-groups?domain=<domainId>` on mount / when the
 * domain changes — no stale cache, so editing the schema in the admin surface
 * is reflected the next time the form opens. Returns `null` when there is no
 * domain or no group applies, so callers can render it unconditionally.
 *
 * Required attributes render with the Fluent `required` asterisk and surface a
 * validation message when left empty. Use the exported `validateCustomAttributes`
 * (or the `missingRequiredAttributes` helper in lib/types) to block submit.
 */

import { useEffect, useState, useCallback } from 'react';
import {
  Field, Input, Dropdown, Option, Spinner, MessageBar, MessageBarBody,
  Caption1, Body1, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  type AttributeGroupDoc,
  type AttributeDef,
  missingRequiredAttributes,
} from '@/lib/types/attribute-groups';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  group: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalM,
  },
  groupHead: {
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingBottom: tokens.spacingVerticalXS,
    marginBottom: tokens.spacingVerticalXS,
  },
  groupTitle: { fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1 },
});

export type AttributeValues = Record<string, unknown>;

interface Props {
  /** Domain to load schema for. `null`/empty = render nothing. */
  domainId: string | null | undefined;
  /** Current value map keyed by attribute id. */
  value: AttributeValues;
  onChange: (next: AttributeValues) => void;
  readOnly?: boolean;
  /** Surfaced after a failed submit so required fields highlight. */
  showValidation?: boolean;
  /** Called once the schema loads so callers can validate before submit. */
  onGroupsLoaded?: (groups: AttributeGroupDoc[]) => void;
}

/** Pure validation helper for callers that hold the loaded groups. */
export function validateCustomAttributes(
  groups: AttributeGroupDoc[],
  values: AttributeValues,
): string[] {
  return missingRequiredAttributes(groups, values);
}

export function CustomAttributesForm({
  domainId, value, onChange, readOnly, showValidation, onGroupsLoaded,
}: Props) {
  const styles = useStyles();
  const [groups, setGroups] = useState<AttributeGroupDoc[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!domainId) { setGroups([]); onGroupsLoaded?.([]); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/attribute-groups?domain=${encodeURIComponent(domainId)}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (!j.ok) { setError(j.error || 'failed to load attribute schema'); setGroups([]); return; }
        const g: AttributeGroupDoc[] = (j.groups || []).filter((x: AttributeGroupDoc) => (x.attributes?.length ?? 0) > 0);
        setGroups(g);
        onGroupsLoaded?.(g);
      })
      .catch((e) => { if (!cancelled) { setError(e?.message || String(e)); setGroups([]); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // onGroupsLoaded intentionally excluded — callers pass a stable/inline cb.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domainId]);

  const setField = useCallback((id: string, v: unknown) => {
    onChange({ ...value, [id]: v });
  }, [onChange, value]);

  if (!domainId) return null;
  if (loading) return <Spinner size="tiny" label="Loading custom attributes…" />;
  if (error) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>{error}</MessageBarBody>
      </MessageBar>
    );
  }
  if (!groups || groups.length === 0) {
    return (
      <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
        No custom attributes are defined for this domain.
      </Body1>
    );
  }

  return (
    <div className={styles.root}>
      {groups.map((g) => (
        <div key={g.groupId} className={styles.group}>
          <div className={styles.groupHead}>
            <Caption1 className={styles.groupTitle}>{g.name}</Caption1>
            {g.description && (
              <Body1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>{g.description}</Body1>
            )}
          </div>
          {g.attributes.map((a) => (
            <AttributeField
              key={a.id}
              attr={a}
              value={value[a.id]}
              onChange={(v) => setField(a.id, v)}
              readOnly={readOnly}
              showValidation={showValidation}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function AttributeField({
  attr, value, onChange, readOnly, showValidation,
}: {
  attr: AttributeDef;
  value: unknown;
  onChange: (v: unknown) => void;
  readOnly?: boolean;
  showValidation?: boolean;
}) {
  const empty = value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
  const invalid = !!(showValidation && attr.required && empty);
  const validationMessage = invalid ? `${attr.name} is required` : undefined;
  const sVal = value === undefined || value === null ? '' : String(value);

  return (
    <Field
      label={attr.name}
      required={attr.required}
      hint={attr.description}
      validationState={invalid ? 'error' : 'none'}
      validationMessage={validationMessage}
    >
      {attr.type === 'enum' ? (
        <Dropdown
          disabled={readOnly}
          placeholder={`Select ${attr.name.toLowerCase()}`}
          selectedOptions={sVal ? [sVal] : []}
          value={sVal}
          onOptionSelect={(_, d) => onChange(d.optionValue ?? '')}
        >
          {(attr.enumValues || []).map((ev) => (
            <Option key={ev} value={ev}>{ev}</Option>
          ))}
        </Dropdown>
      ) : (
        <Input
          disabled={readOnly}
          type={attr.type === 'number' ? 'number' : attr.type === 'date' ? 'date' : 'text'}
          value={sVal}
          onChange={(_, d) => onChange(d.value)}
        />
      )}
    </Field>
  );
}
