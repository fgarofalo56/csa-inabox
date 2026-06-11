'use client';

/**
 * LineageDrawer — item-to-item OneLake lineage drawer.
 *
 * Self-contained surface reachable from a card overflow menu or an item detail
 * pane. Renders a trigger icon button (uncontrolled mode) OR is driven by a
 * parent via `open` / `onOpenChange` (controlled mode). On open it fetches
 * `/api/items/[type]/[id]/lineage`, which auto-selects the lineage backend per
 * cloud boundary (Unity Catalog / Purview Atlas / Atlas-on-AKS) — see that
 * route. The graph itself is drawn by the shared React-Flow `LineageCanvas`,
 * which already implements upstream/downstream layered layout, hop expansion
 * (focus-chain), and click-to-open (`openHref`).
 *
 * When the backend is not configured the route returns a structured gate; this
 * component renders a NAMED Fluent MessageBar (the missing env var + bicep
 * module) instead of an empty graph, per no-vaporware.md.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Tooltip,
  Drawer,
  DrawerHeader,
  DrawerHeaderTitle,
  DrawerBody,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Dismiss24Regular, BranchFork24Regular } from '@fluentui/react-icons';
import {
  LineageCanvas,
  type CanvasLineageNode,
  type CanvasLineageEdge,
} from '@/lib/components/catalog/lineage-canvas';

export interface LineageDrawerProps {
  /** Item type slug (e.g. 'lakehouse', 'warehouse', 'semantic-model'). */
  type: string;
  /** Item id — Cosmos item id, or a raw lineage key (UC full_name / Atlas GUID). */
  id: string;
  /** Shown in the drawer header. */
  displayName?: string;
  /** Controlled mode: when provided the parent owns the open state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface SourceStatus {
  source: string;
  ok: boolean;
  gate?: string;
  nodeCount?: number;
}

interface LineageData {
  backend: string;
  nodes: CanvasLineageNode[];
  edges: CanvasLineageEdge[];
  focusId?: string;
  sources?: SourceStatus[];
}

interface GateHint {
  missingEnvVar?: string;
  bicepModule?: string;
  followUp?: string;
}

const useStyles = makeStyles({
  body: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    rowGap: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalM,
  },
  canvasHost: { flex: 1, minHeight: '320px' },
  hintBlock: { marginTop: tokens.spacingVerticalS, fontSize: tokens.fontSizeBase200 },
  hintMeta: { marginTop: tokens.spacingVerticalXS, fontSize: tokens.fontSizeBase100 },
});

export function LineageDrawer({
  type,
  id,
  displayName,
  open: controlledOpen,
  onOpenChange,
}: LineageDrawerProps) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<LineageData | null>(null);
  const [gate, setGate] = useState<{ error: string; hint: GateHint } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isControlled = controlledOpen !== undefined;
  const mergedOpen = isControlled ? controlledOpen : open;

  const load = useCallback(() => {
    setLoading(true);
    setGate(null);
    setErr(null);
    fetch(`/api/items/${encodeURIComponent(type)}/${encodeURIComponent(id)}/lineage`)
      .then((r) => r.json())
      .then((j) => {
        if (!j?.ok && j?.gate) {
          setGate({ error: j.error || 'Lineage backend not configured', hint: j.hint || {} });
          return;
        }
        if (!j?.ok) {
          setErr(j?.error || 'Failed to load lineage');
          return;
        }
        setData({ backend: j.backend, nodes: j.nodes || [], edges: j.edges || [], focusId: j.focusId, sources: Array.isArray(j.sources) ? j.sources : undefined });
      })
      .catch((e) => setErr(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, [type, id]);

  const setOpenState = useCallback(
    (v: boolean) => {
      if (!isControlled) setOpen(v);
      onOpenChange?.(v);
    },
    [isControlled, onOpenChange],
  );

  // Fetch on first open (or when the target item changes while open).
  useEffect(() => {
    if (mergedOpen && !data && !gate && !err && !loading) load();
    // Reset cached graph when the drawer closes so reopening on a different
    // item refetches.
    if (!mergedOpen && (data || gate || err)) {
      setData(null);
      setGate(null);
      setErr(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergedOpen, type, id]);

  return (
    <>
      {!isControlled && (
        <Tooltip content="View lineage" relationship="label">
          <Button
            appearance="subtle"
            icon={<BranchFork24Regular />}
            onClick={() => setOpenState(true)}
            aria-label="View lineage"
          />
        </Tooltip>
      )}
      <Drawer
        type="overlay"
        position="end"
        size="large"
        open={mergedOpen}
        onOpenChange={(_, d) => setOpenState(d.open)}
      >
        <DrawerHeader>
          <DrawerHeaderTitle
            action={
              <Button
                appearance="subtle"
                icon={<Dismiss24Regular />}
                onClick={() => setOpenState(false)}
                aria-label="Close lineage drawer"
              />
            }
          >
            Lineage — {displayName || id}
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody className={styles.body}>
          {loading && <Spinner label="Loading lineage…" />}

          {gate && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Lineage backend not configured</MessageBarTitle>
                {gate.error}
                {gate.hint?.followUp && <div className={styles.hintBlock}>{gate.hint.followUp}</div>}
                {(gate.hint?.missingEnvVar || gate.hint?.bicepModule) && (
                  <div className={styles.hintMeta}>
                    {gate.hint?.missingEnvVar && (
                      <>
                        Missing: <code>{gate.hint.missingEnvVar}</code>
                      </>
                    )}
                    {gate.hint?.bicepModule && (
                      <>
                        {' · '}Module: <code>{gate.hint.bicepModule}</code>
                      </>
                    )}
                  </div>
                )}
              </MessageBarBody>
            </MessageBar>
          )}

          {err && !gate && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Could not load lineage</MessageBarTitle>
                {err}
              </MessageBarBody>
            </MessageBar>
          )}

          {data && !loading && (
            <>
              {/* Honest per-source gates: one source's missing config never
                  blanks the unified graph — the other sources still draw. */}
              {(data.sources || []).filter((x) => !x.ok).map((src) => (
                <MessageBar key={src.source} intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>
                      {src.source === 'unity-catalog' ? 'Unity Catalog' : src.source === 'purview' ? 'Purview' : src.source}
                      {' '}lineage not merged
                    </MessageBarTitle>
                    {src.gate}
                  </MessageBarBody>
                </MessageBar>
              ))}
              {data.edges.length === 0 && (
                <MessageBar intent="info">
                  <MessageBarBody>
                    No upstream or downstream lineage was found for this item in the {data.backend}{' '}
                    backend. Showing the item only — lineage appears once dependent
                    pipelines/queries have run.
                  </MessageBarBody>
                </MessageBar>
              )}
              {data.nodes.length > 0 && (
                <div className={styles.canvasHost}>
                  <LineageCanvas nodes={data.nodes} edges={data.edges} focusId={data.focusId} />
                </div>
              )}
            </>
          )}
        </DrawerBody>
      </Drawer>
    </>
  );
}
