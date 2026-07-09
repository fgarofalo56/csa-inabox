'use client';

/**
 * Explain-this — the cross-item "Explain this" Copilot action (Wave-2 W19).
 *
 * Two entry points share one backend + one drawer UI:
 *  - {@link ExplainThisButton} — a header/ribbon action rendered by
 *    {@link ItemEditorChrome} on every pipeline / notebook / warehouse editor.
 *    It explains the WHOLE artifact from the editor's live in-memory state.
 *  - {@link ExplainNodeDrawer} — a canvas node action ("Explain this step").
 *    It explains a SINGLE step (a pipeline activity) grounded on that node's
 *    definition plus its in-canvas neighbors.
 *
 * Both send to the shared `POST /api/items/[type]/[id]/explain` edge, which
 * returns a STRUCTURED explanation — a plain-English summary plus steps, inputs,
 * outputs and risks — and is additionally grounded server-side with the item's
 * cross-item lineage neighbors from the Loom Thread graph. This generalizes the
 * report's smart-narrative / Q&A layer to the data-engineering item families.
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

import { useCallback, useEffect, useState, type ReactElement } from 'react';
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
export interface ExplainResult {
  summary: string;
  steps?: string[];
  inputs?: string[];
  outputs?: string[];
  risks?: string[];
}

/** POST payload the /explain edge accepts (item OR node scope). */
interface ExplainRequest {
  definition: unknown;
  scope?: 'item' | 'node';
  focus?: { name?: string; upstream?: string[]; downstream?: string[] };
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

/** Fetch state shared by both the button and the node drawer. */
interface ExplainState {
  busy: boolean;
  result: ExplainResult | null;
  error: string | null;
  gate: string | null;
}

/**
 * Shared fetch hook — POSTs the request to the /explain edge and maps the
 * response into the honest three-way state (gate / error / result). Returns a
 * `run(payload)` the caller invokes when its drawer opens (and on Retry).
 */
function useExplainRun(itemType: string, itemId: string) {
  const [state, setState] = useState<ExplainState>({ busy: false, result: null, error: null, gate: null });
  const run = useCallback(async (payload: ExplainRequest) => {
    setState({ busy: true, result: null, error: null, gate: null });
    try {
      const res = await clientFetch(
        `/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/explain`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
      );
      const j = await res.json().catch(() => ({}));
      if (res.status === 503 && j?.code === 'no_aoai') {
        setState({ busy: false, result: null, error: null, gate: j.hint || j.error || 'Azure OpenAI is not configured for this deployment.' });
        return;
      }
      if (!res.ok || !j?.ok) {
        setState({ busy: false, result: null, error: j?.error || `Explain failed (HTTP ${res.status}).`, gate: null });
        return;
      }
      setState({ busy: false, result: j.explanation as ExplainResult, error: null, gate: null });
    } catch (e: any) {
      setState({ busy: false, result: null, error: e?.message || String(e), gate: null });
    }
  }, [itemType, itemId]);
  return { ...state, run };
}

/** Presentational drawer body — the busy / gate / error / result rendering. */
function ExplainDrawerBody({ state, label }: { state: ExplainState; label: string }) {
  const styles = useStyles();
  const { busy, gate, error, result } = state;

  const renderList = (icon: ReactElement, title: string, items: string[] | undefined) =>
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
            Generated by Azure OpenAI over this {label}’s live definition and its Loom Thread lineage. Verify before acting on it.
          </Caption1>
        </div>
      )}
    </>
  );
}

/** Shared drawer header (Sparkle title + Re-explain + Close). */
function ExplainDrawerHeaderTitle({ title, busy, onRetry, onClose }: { title: string; busy: boolean; onRetry: () => void; onClose: () => void }) {
  return (
    <DrawerHeaderTitle
      action={
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS }}>
          <Tooltip content="Re-explain" relationship="label">
            <Button appearance="subtle" icon={<ArrowClockwise16Regular />} aria-label="Re-explain" disabled={busy} onClick={onRetry} />
          </Tooltip>
          <Button appearance="subtle" icon={<Dismiss24Regular />} aria-label="Close" onClick={onClose} />
        </div>
      }
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
        <Sparkle24Regular /> {title}
      </span>
    </DrawerHeaderTitle>
  );
}

interface ButtonProps {
  itemType: string;
  itemId: string;
  family: ExplainFamily;
  getDefinition: () => unknown;
}

/** Whole-artifact "Explain" action (item scope) — rendered in the editor chrome. */
export function ExplainThisButton({ itemType, itemId, family, getDefinition }: ButtonProps) {
  const [open, setOpen] = useState(false);
  const { busy, result, error, gate, run } = useExplainRun(itemType, itemId);
  const label = FAMILY_LABEL[family];

  const doRun = useCallback(() => { void run({ definition: getDefinition(), scope: 'item' }); }, [run, getDefinition]);

  const onOpen = useCallback(() => {
    setOpen(true);
    // Kick off the explanation as soon as the drawer opens (mirrors the report
    // smart-narrative auto-run); Retry re-issues on demand.
    doRun();
  }, [doRun]);

  return (
    <>
      <Tooltip content={`Explain this ${label} in plain English — a real AI summary of what it does, its inputs/outputs, and risks`} relationship="label">
        <Button appearance="subtle" size="small" icon={<Lightbulb20Regular />} onClick={onOpen}>
          Explain
        </Button>
      </Tooltip>
      <Drawer open={open} onOpenChange={(_, d) => { if (!d.open) setOpen(false); }} position="end" size="medium">
        <DrawerHeader>
          <ExplainDrawerHeaderTitle title={`Explain this ${label}`} busy={busy} onRetry={doRun} onClose={() => setOpen(false)} />
        </DrawerHeader>
        <DrawerBody>
          <ExplainDrawerBody state={{ busy, result, error, gate }} label={label} />
        </DrawerBody>
      </Drawer>
    </>
  );
}

/** The focus node the canvas host hands to {@link ExplainNodeDrawer}. */
export interface ExplainNodeTarget {
  /** The step's display name (e.g. the activity name). */
  name: string;
  /** The step's structured definition (the single activity JSON). */
  definition: unknown;
  /** In-canvas upstream neighbor names (steps this one depends on). */
  upstream?: string[];
  /** In-canvas downstream neighbor names (steps that depend on this one). */
  downstream?: string[];
}

interface NodeDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemType: string;
  itemId: string;
  family: ExplainFamily;
  /** The node to explain; null while closed (nothing is fetched). */
  node: ExplainNodeTarget | null;
}

/**
 * Canvas node "Explain this step" drawer (node scope). Controlled by the canvas
 * host: it opens when a node's Explain action fires, auto-runs a node-scoped
 * explanation grounded on the single step's definition + its in-canvas
 * neighbors, and reuses the same honest states + drawer body as the button.
 */
export function ExplainNodeDrawer({ open, onOpenChange, itemType, itemId, family, node }: NodeDrawerProps) {
  const { busy, result, error, gate, run } = useExplainRun(itemType, itemId);
  const nodeName = node?.name ?? '';

  const doRun = useCallback(() => {
    if (!node) return;
    void run({
      definition: node.definition,
      scope: 'node',
      focus: { name: node.name, upstream: node.upstream || [], downstream: node.downstream || [] },
    });
  }, [run, node]);

  // Auto-run whenever a new node is opened (open transitions true with a node).
  useEffect(() => {
    if (open && node) doRun();
    // Re-run when the focused node changes while the drawer stays open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, nodeName]);

  const label = nodeName || 'step';
  return (
    <Drawer open={open} onOpenChange={(_, d) => { if (!d.open) onOpenChange(false); }} position="end" size="medium">
      <DrawerHeader>
        <ExplainDrawerHeaderTitle title={nodeName ? `Explain "${nodeName}"` : 'Explain this step'} busy={busy} onRetry={doRun} onClose={() => onOpenChange(false)} />
      </DrawerHeader>
      <DrawerBody>
        <ExplainDrawerBody state={{ busy, result, error, gate }} label={label} />
      </DrawerBody>
    </Drawer>
  );
}
