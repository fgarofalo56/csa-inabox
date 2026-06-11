'use client';

/**
 * ClassificationPane — item-level data-classification flyout, one-for-one with
 * the Microsoft Purview "Classifications" picker on a Data Map asset (Learn:
 * data-map-classification-apply-manual — "From the Classifications drop-down
 * list, select one or more classifications").
 *
 * The picker is ALWAYS bound to the tenant LABEL TAXONOMY managed in
 * Governance → Classifications (#704) — never free-text — honouring
 * .claude/rules/loom-no-freeform-config.md. Backed by:
 *
 *   GET /api/items/[type]/[id]/classifications  → current + taxonomy
 *   PUT /api/items/[type]/[id]/classifications  → persist selection
 *
 * Saving writes item.state.classifications in the Loom catalog (Cosmos — the
 * authoritative store in every cloud, no Microsoft Fabric / Power BI / real
 * Purview dependency) and, when Microsoft Purview is configured and the item is
 * cataloged there, best-effort tags the asset's Atlas entity. When the taxonomy
 * is empty the pane shows an honest empty state deep-linking to the admin page
 * (NO free-text fallback).
 */

import { useEffect, useState } from 'react';
import {
  Button, Spinner, Badge, Dropdown, Option, Field,
  MessageBar, MessageBarBody, MessageBarTitle, Caption1,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Tag24Regular, Open16Regular } from '@fluentui/react-icons';

interface Props { type: string; id: string; }

interface TaxonomyEntry { name: string; sensitivity?: string; color?: string; description?: string; }

const useStyles = makeStyles({
  list: { display: 'flex', flexDirection: 'column', gap: 12 },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  swatch: {
    display: 'inline-block', width: 10, height: 10, borderRadius: 3, flexShrink: 0,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  actions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  link: { display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 600 },
});

export function ClassificationPane({ type, id }: Props) {
  const styles = useStyles();
  const [taxonomy, setTaxonomy] = useState<TaxonomyEntry[] | null>(null);
  const [current, setCurrent] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [purviewConfigured, setPurviewConfigured] = useState(false);
  const [hasAsset, setHasAsset] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/items/${type}/${id}/classifications`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setError(data?.error || `Failed to load classifications (${res.status})`);
        return;
      }
      setTaxonomy(data.taxonomy || []);
      setCurrent(data.classifications || []);
      setSelected(data.classifications || []);
      setPurviewConfigured(!!data.purviewConfigured);
      setHasAsset(!!data.hasPurviewAsset);
    } catch (e: any) {
      setError(e?.message || 'Failed to load classifications');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [type, id]);

  const dirty =
    selected.length !== current.length ||
    selected.some((s) => !current.includes(s));

  const save = async () => {
    setBusy(true); setError(null); setOk(null);
    try {
      const res = await fetch(`/api/items/${type}/${id}/classifications`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ classifications: selected }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setError(data?.error || `Failed to save classifications (${res.status})`);
        return;
      }
      setCurrent(data.classifications || []);
      setSelected(data.classifications || []);
      const pv = data.purviewStatus === 'written'
        ? ' Also tagged on the asset in Microsoft Purview.'
        : '';
      setOk(
        (data.classifications?.length
          ? 'Classifications applied — they now show in the governance catalog.'
          : 'Classifications cleared.') + pv,
      );
    } catch (e: any) {
      setError(e?.message || 'Failed to save classifications');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner size="tiny" label="Loading classifications…" />;

  const tax = taxonomy || [];
  const colorOf = (name: string) => tax.find((t) => t.name === name)?.color || '#8a8a8a';

  return (
    <div className={styles.list}>
      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      {ok && <MessageBar intent="success"><MessageBarBody>{ok}</MessageBarBody></MessageBar>}

      {current.length > 0 && (
        <div>
          <Caption1 block style={{ marginBottom: 4 }}>Applied classifications</Caption1>
          <div className={styles.chips}>
            {current.map((c) => (
              <Badge key={c} appearance="tint" color="informative">
                <span className={styles.swatch} style={{ backgroundColor: colorOf(c), marginRight: 6 }} aria-hidden />
                {c}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {tax.length === 0 ? (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>No classification taxonomy defined</MessageBarTitle>
            Your tenant has no classification labels yet. Define the standard set
            in <a className={styles.link} href="/governance/classifications" target="_blank" rel="noreferrer">
              Governance → Classifications <Open16Regular />
            </a>, then return here to apply them. Classifications are picked from
            the taxonomy — never free-typed.
          </MessageBarBody>
        </MessageBar>
      ) : (
        <Field
          label="Classifications"
          hint="Pick one or more from the tenant label taxonomy (manage in Governance → Classifications)."
        >
          <Dropdown
            multiselect
            placeholder="Select classifications…"
            value={selected.join(', ')}
            selectedOptions={selected}
            onOptionSelect={(_, d) => setSelected(d.selectedOptions || [])}
          >
            {tax.map((t) => (
              <Option key={t.name} value={t.name} text={t.name}>
                <span className={styles.swatch} style={{ backgroundColor: t.color || '#8a8a8a', marginRight: 8 }} aria-hidden />
                {t.name}
                {t.sensitivity ? ` · ${t.sensitivity}` : ''}
              </Option>
            ))}
          </Dropdown>
        </Field>
      )}

      {tax.length > 0 && (
        <div className={styles.actions}>
          <Button appearance="primary" onClick={save} disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save classifications'}
          </Button>
          {selected.length > 0 && (
            <Button appearance="subtle" onClick={() => setSelected([])} disabled={busy}>
              Clear all
            </Button>
          )}
        </div>
      )}

      <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>
        Classifications are stored in the Loom governance catalog and feed the
        Classifications rollup. {purviewConfigured
          ? (hasAsset
              ? 'This item is cataloged in Microsoft Purview, so saved classifications are also tagged on its Data Map asset.'
              : 'When this item is cataloged in Microsoft Purview, saved classifications are also tagged on its asset.')
          : 'Microsoft Purview is not configured in this deployment; the catalog (Cosmos) is the classification store.'}
      </Caption1>
    </div>
  );
}

export { Tag24Regular as ClassificationIcon };
