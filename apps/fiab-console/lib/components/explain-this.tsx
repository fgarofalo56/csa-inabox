'use client';

/**
 * Explain-this — the cross-item "Explain this" Copilot action (Wave-2 W19).
 *
 * A toolbar action rendered by {@link ItemEditorChrome} on every pipeline /
 * notebook / warehouse editor. It sends the artifact's LIVE structured
 * definition (from the editor's in-memory state via {@link ExplainConfig.getDefinition})
 * to the shared `POST /api/items/[type]/[id]/explain` edge, which returns a
 * STRUCTURED explanation — a plain-English summary plus steps, inputs, outputs
 * and risks — and renders it in a Fluent Drawer. This generalizes the report's
 * smart-narrative / Q&A layer to the three data-engineering item families.
 *
 * Rules compliance:
 *  - no-vaporware.md: the explanation is a REAL Azure OpenAI completion over the
 *    artifact JSON (never canned). A missing AOAI deployment surfaces the SAME
 *    honest warning MessageBar the Copilot uses, naming the exact remediation;
 *    Retry always re-issues a real request. No dead controls.
 *  - loom design standards: Fluent v9 + Loom tokens only (no hard-coded px/hex);
 *    Sparkle-accented header, keyboard-navigable Drawer, dark-legible.
 *  - no-fabric-dependency.md: the backend is Azure-native (AI Foundry chat
 *    deployment); nothing here reaches a Fabric / Power BI host.
 */

import { useCallback, useState, type ReactElement } from 'react';
import {
  Button, Tooltip, Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Spinner, Body1, Caption1,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Lightbulb20Regular, Dismiss24Regular, ArrowClockwise16Regular, Sparkle24Regular,
  ArrowStepIn20Regular, ArrowStepOut20Regular, Warning20Regular, ListBar20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';

/** The three artifact families the Explain action supports. */
export type ExplainFamily = 'pipeline' | 'notebook' | 'warehouse';

/**
 * Config an editor threads to {@link ItemEditorChrome} to opt into the Explain
 * action. `getDefinition` is called at click time so the explanation always
 * reflects the CURRENT canvas / cells / schema, not a stale snapshot.
 */
export interface ExplainConfig {
  family: ExplainFamily;
  /** Returns the artifact's structured definition (activities / cells / schema). */
  getDefinition: () => unknown;
}

/** Structured explanation returned by the /explain edge. */
interface ExplainResult {
  summary: string;
  steps?: string[];
  inputs?: string[];
  outputs?: string[];
  risks?: string[];
}

const FAMILY_LABEL: Record<ExplainFamily, string> = {
  pipeline: 'pipeline',
  notebook: 'notebook',
  warehouse: 'warehouse schema',
};

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, paddingTop: tokens.spacingVerticalS },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground2 },
  list: { margin: 0, paddingLeft: tokens.spacingHorizontalXL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  summary: {
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
  },
  loading: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, paddingTop: tokens.spacingVerticalXL, justifyContent: 'center' },
});

interface Props {
  itemType: string;
  itemId: string;
  family: ExplainFamily;
  getDefinition: () => unknown;
}

export function ExplainThisButton({ itemType, itemId, family, getDefinition }: Props) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExplainResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  const label = FAMILY_LABEL[family];

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    setGate(null);
    setResult(null);
    try {
      const definition = getDefinition();
      const res = await clientFetch(`/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/explain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 503 && j?.code === 'no_aoai') {
        setGate(j.hint || j.error || 'Azure OpenAI is not configured for this deployment.');
        return;
      }
      if (!res.ok || !j?.ok) {
        setError(j?.error || `Explain failed (HTTP ${res.status}).`);
        return;
      }
      setResult(j.explanation as ExplainResult);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [getDefinition, itemType, itemId]);

  const onOpen = useCallback(() => {
    setOpen(true);
    // Kick off the explanation as soon as the drawer opens (mirrors the report
    // smart-narrative auto-run); Retry re-issues on demand.
    void run();
  }, [run]);

  const renderList = (
    icon: ReactElement,
    title: string,
    items: string[] | undefined,
  ) =>
    items && items.length > 0 ? (
      <div className={styles.section}>
        <div className={styles.sectionHead}>
          {icon}
          <Caption1>{title}</Caption1>
        </div>
        <ul className={styles.list}>
          {items.map((t, i) => (
            <li key={i}><Body1>{t}</Body1></li>
          ))}
        </ul>
      </div>
    ) : null;

  return (
    <>
      <Tooltip content={`Explain this ${label} in plain English — a real AI summary of what it does, its inputs/outputs, and risks`} relationship="label">
        <Button appearance="subtle" size="small" icon={<Lightbulb20Regular />} onClick={onOpen}>
          Explain
        </Button>
      </Tooltip>
      <Drawer open={open} onOpenChange={(_, d) => { if (!d.open) setOpen(false); }} position="end" size="medium">
        <DrawerHeader>
          <DrawerHeaderTitle
            action={
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS }}>
                <Tooltip content="Re-explain" relationship="label">
                  <Button appearance="subtle" icon={<ArrowClockwise16Regular />} aria-label="Re-explain"
                    disabled={busy} onClick={() => void run()} />
                </Tooltip>
                <Button appearance="subtle" icon={<Dismiss24Regular />} aria-label="Close" onClick={() => setOpen(false)} />
              </div>
            }
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
              <Sparkle24Regular /> Explain this {label}
            </span>
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          {busy && (
            <div className={styles.loading}>
              <Spinner size="small" label={`Explaining this ${label}…`} />
            </div>
          )}

          {!busy && gate && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Azure OpenAI not configured</MessageBarTitle>
                {gate}
              </MessageBarBody>
            </MessageBar>
          )}

          {!busy && error && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Couldn’t explain this {label}</MessageBarTitle>
                {error}
              </MessageBarBody>
            </MessageBar>
          )}

          {!busy && !gate && !error && result && (
            <div className={styles.body}>
              <div className={styles.summary}>
                <Body1>{result.summary}</Body1>
              </div>
              {renderList(<ListBar20Regular />, 'Steps', result.steps)}
              {renderList(<ArrowStepIn20Regular />, 'Inputs', result.inputs)}
              {renderList(<ArrowStepOut20Regular />, 'Outputs', result.outputs)}
              {renderList(<Warning20Regular />, 'Risks & gotchas', result.risks)}
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Generated by Azure OpenAI over this {label}’s live definition. Verify before acting on it.
              </Caption1>
            </div>
          )}
        </DrawerBody>
      </Drawer>
    </>
  );
}
