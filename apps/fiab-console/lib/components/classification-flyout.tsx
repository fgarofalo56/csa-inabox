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

interface GlossaryTerm { guid: string; name: string; glossaryGuid?: string; longDescription?: string; status?: string; }

const useStyles = makeStyles({
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalM },
  loading: { display: 'flex', justifyContent: 'center', padding: 'var(--loom-space-4, 16px)' },
  applied: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalSNudge,
    padding: 'var(--loom-space-3, 12px)',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 'var(--loom-radius-md, 6px)',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  appliedHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge },
  chips: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalSNudge },
  swatch: {
    display: 'inline-block', width: tokens.spacingHorizontalMNudge, height: tokens.spacingVerticalMNudge, borderRadius: '3px', flexShrink: 0,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  optionRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalXXS, minWidth: 0 },
  optionName: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  optionDesc: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  link: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, fontWeight: 600, verticalAlign: 'middle' },
  glossary: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalM,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  glossaryHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge },
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

  // Glossary terms — attach standardized Purview business terms to this asset.
  const [glossaryTerms, setGlossaryTerms] = useState<GlossaryTerm[] | null>(null);
  const [selectedTerms, setSelectedTerms] = useState<string[]>([]); // term GUIDs
  const [assetGuid, setAssetGuid] = useState<string | null>(null);
  const [glossaryBusy, setGlossaryBusy] = useState(false);
  const [glossaryMsg, setGlossaryMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);

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

      // Best-effort glossary surface (never blocks the classifications pane).
      // Only meaningful when Purview is configured; the apply call needs the
      // item's Atlas entity GUID, resolved from the item record below.
      if (data.purviewConfigured) {
        try {
          const gr = await fetch('/api/catalog/glossary');
          const gj = await gr.json().catch(() => ({}));
          setGlossaryTerms(gr.ok && gj?.ok ? (gj.terms || []) : []);
        } catch { setGlossaryTerms([]); }
        try {
          const ir = await fetch(`/api/items/${type}/${id}`);
          const ij = await ir.json().catch(() => ({}));
          setAssetGuid(ir.ok ? (ij?.state?.purviewAssetGuid || ij?.state?.purviewGuid || null) : null);
        } catch { /* leave assetGuid null → honest gate on apply */ }
      }
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

  const applyGlossary = async () => {
    if (!assetGuid) {
      setGlossaryMsg({ intent: 'warning', text: 'This item is not yet cataloged in Microsoft Purview, so terms cannot be attached. It is registered after the item is onboarded/scanned.' });
      return;
    }
    const chosen = (glossaryTerms || []).filter((t) => selectedTerms.includes(t.guid));
    if (!chosen.length) { setGlossaryMsg({ intent: 'warning', text: 'Select at least one glossary term.' }); return; }
    setGlossaryBusy(true); setGlossaryMsg(null);
    try {
      let applied = 0;
      for (const t of chosen) {
        // Reuse the existing glossary BFF route: create-or-resolve the term by
        // name (idempotent) and apply it to this asset's Atlas entity.
        const res = await fetch('/api/catalog/glossary', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ term: { name: t.name, glossaryGuid: t.glossaryGuid }, applyTo: { entityGuid: assetGuid } }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j?.ok) {
          setGlossaryMsg({ intent: 'error', text: j?.error || `Failed to apply "${t.name}" (${res.status})` });
          return;
        }
        if (j.applied) applied += 1;
      }
      setGlossaryMsg({ intent: 'success', text: `Applied ${applied || chosen.length} glossary term${(applied || chosen.length) === 1 ? '' : 's'} to this asset in Microsoft Purview.` });
    } catch (e: any) {
      setGlossaryMsg({ intent: 'error', text: e?.message || String(e) });
    } finally {
      setGlossaryBusy(false);
    }
  };

  if (loading) {
    return (
      <div className={styles.loading}>
        <Spinner size="tiny" label="Loading classifications…" />
      </div>
    );
  }

  const tax = taxonomy || [];
  const colorOf = (name: string) => tax.find((t) => t.name === name)?.color || '#8a8a8a';

  return (
    <div className={styles.list}>
      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      {ok && <MessageBar intent="success"><MessageBarBody>{ok}</MessageBarBody></MessageBar>}

      {current.length > 0 && (
        <div className={styles.applied}>
          <div className={styles.appliedHead}>
            <Caption1>Applied classifications</Caption1>
            <Badge size="small" appearance="tint" color="informative">{current.length}</Badge>
          </div>
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
          hint={
            selected.length > 0
              ? `${selected.length} selected · pick from the tenant label taxonomy (manage in Governance → Classifications).`
              : 'Pick one or more from the tenant label taxonomy (manage in Governance → Classifications).'
          }
        >
          <Dropdown
            multiselect
            placeholder="Select classifications…"
            value={selected.join(', ')}
            selectedOptions={selected}
            onOptionSelect={(_, d) => setSelected(d.selectedOptions || [])}
          >
            {tax.map((t) => (
              <Option key={t.name} value={t.name} text={t.name} title={t.description || undefined}>
                <div className={styles.optionRow}>
                  <span className={styles.optionName}>
                    <span className={styles.swatch} style={{ backgroundColor: t.color || '#8a8a8a' }} aria-hidden />
                    {t.name}
                    {t.sensitivity ? ` · ${t.sensitivity}` : ''}
                  </span>
                  {t.description && <span className={styles.optionDesc}>{t.description}</span>}
                </div>
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

      {purviewConfigured && (
        <div className={styles.glossary}>
          <div className={styles.glossaryHead}>
            <Caption1>Glossary terms</Caption1>
          </div>
          {glossaryMsg && (
            <MessageBar intent={glossaryMsg.intent}><MessageBarBody>{glossaryMsg.text}</MessageBarBody></MessageBar>
          )}
          {glossaryTerms && glossaryTerms.length > 0 ? (
            <>
              <Field
                hint={assetGuid
                  ? 'Attach standardized Microsoft Purview business terms to this asset.'
                  : 'Available once this item is cataloged in Microsoft Purview (after onboarding/scan).'}
              >
                <Dropdown
                  multiselect
                  placeholder="Select glossary terms…"
                  value={glossaryTerms.filter((t) => selectedTerms.includes(t.guid)).map((t) => t.name).join(', ')}
                  selectedOptions={selectedTerms}
                  onOptionSelect={(_, d) => setSelectedTerms(d.selectedOptions || [])}
                  disabled={!assetGuid || glossaryBusy}
                >
                  {glossaryTerms.map((t) => (
                    <Option key={t.guid} value={t.guid} text={t.name} title={t.longDescription || undefined}>{t.name}</Option>
                  ))}
                </Dropdown>
              </Field>
              <div className={styles.actions}>
                <Button appearance="primary" onClick={applyGlossary} disabled={glossaryBusy || !assetGuid || selectedTerms.length === 0}>
                  {glossaryBusy ? 'Applying…' : 'Apply terms'}
                </Button>
                <a className={styles.link} href="/governance/glossary" target="_blank" rel="noreferrer">
                  Manage glossary <Open16Regular />
                </a>
              </div>
            </>
          ) : (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              No glossary terms defined. Create them in <a className={styles.link} href="/governance/glossary" target="_blank" rel="noreferrer">Governance → Glossary <Open16Regular /></a>, then return here to attach them.
            </Caption1>
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
