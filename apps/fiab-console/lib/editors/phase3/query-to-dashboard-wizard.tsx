'use client';

/**
 * QueryToDashboardWizard — operator review 5.2: "Query → Dashboard conversion".
 *
 * Step-by-step wizard launched from the KQL database editor (ribbon "Create
 * dashboard tile from query" + the query-result "Create dashboard tile"
 * action). Pins the editor's current KQL query as a tile on a Real-Time
 * Dashboard:
 *
 *   1. Target       — a NEW kql-dashboard, or an EXISTING one in the workspace
 *                     (real /api/items/by-type picker, workspace-scoped).
 *   2. Visual type  — table / timechart / column / bar / pie / stat, with a
 *                     "Help me choose" Copilot assist that calls the existing
 *                     kql-dashboard tile-generation route in SUGGEST mode
 *                     (title + viz for THIS query, query preserved verbatim).
 *   3. Title & size — tile heading + structured size presets.
 *   4. Review       — POSTs /api/thread/kql-query-to-dashboard-tile, which
 *                     VALIDATES the query by executing it against the real ADX
 *                     cluster and then creates/updates the real kql-dashboard
 *                     item. A failing query surfaces the honest ADX error.
 *
 * All configuration is pickers/dropdowns (loom-no-freeform-config); the KQL
 * itself comes from the editor's query surface. Fluent v9 + Loom tokens only
 * (web3-ui.md). Step gating lives in the pure, unit-tested
 * lib/azure/kql-tile-conversion.ts state machine.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge, Button, Caption1, Field, Input, Radio, RadioGroup, Select, Spinner,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  tokens,
} from '@fluentui/react-components';
import {
  Sparkle16Regular, GridDots20Regular, CheckmarkCircle20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import type { TileViz } from '@/lib/azure/kql-dashboard-model';
import {
  CONVERSION_STEP_LABELS, CONVERSION_VIZ_CHOICES, CONVERSION_WIZARD_STEPS, TILE_SIZES,
  canAdvance, initialConversionState, nextConversionStep, prevConversionStep,
  type ConversionWizardState, type ConversionWizardStep, type TileSizeKey,
} from '@/lib/azure/kql-tile-conversion';

interface DashboardOption { id: string; displayName: string }

interface Props {
  open: boolean;
  onClose: () => void;
  /** The source kql-database item id (the tile query's database resolves from it). */
  itemId: string;
  /** Source display name — seeds the new-dashboard name. */
  itemName: string;
  /** Workspace to list existing dashboards from (and create the new one in). */
  workspaceId?: string;
  /** The current query in the editor — becomes the tile's KQL. */
  kql: string;
}

export function QueryToDashboardWizard({ open, onClose, itemId, itemName, workspaceId, kql }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<ConversionWizardStep>('target');
  const [state, setState] = useState<ConversionWizardState>(() => initialConversionState(kql, itemName));
  const [dashboards, setDashboards] = useState<DashboardOption[]>([]);
  const [dashboardsLoading, setDashboardsLoading] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<{ title: string; viz: TileViz } | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [done, setDone] = useState<{ link: string; message: string } | null>(null);

  // Reset + load the workspace's existing dashboards each time the wizard opens.
  useEffect(() => {
    if (!open) return;
    setStep('target');
    setState(initialConversionState(kql, itemName));
    setSuggestError(null);
    setSuggested(null);
    setCreateError(null);
    setDone(null);
    setDashboardsLoading(true);
    const qs = workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : '';
    clientFetch(`/api/items/by-type?types=kql-dashboard${qs}`)
      .then((r) => r.json())
      .then((j: any) => {
        const items = Array.isArray(j?.items) ? j.items : [];
        setDashboards(items.map((it: any) => ({ id: String(it.id), displayName: String(it.displayName || it.id) })));
      })
      .catch(() => setDashboards([]))
      .finally(() => setDashboardsLoading(false));
  }, [open, kql, itemName, workspaceId]);

  const patch = useCallback((p: Partial<ConversionWizardState>) => {
    setState((prev) => ({ ...prev, ...p }));
  }, []);

  const gate = canAdvance(step, state);
  const stepIndex = CONVERSION_WIZARD_STEPS.indexOf(step);

  /**
   * "Help me choose" — Copilot assist. Calls the EXISTING kql-dashboard
   * tile-generation route in SUGGEST mode with the source item id (the route
   * resolves the same database the tile will query); the model returns a title
   * + best viz for THIS query, which pre-fills the wizard fields.
   */
  const helpMeChoose = useCallback(async () => {
    setSuggesting(true);
    setSuggestError(null);
    try {
      const r = await clientFetch(`/api/items/kql-dashboard/${encodeURIComponent(itemId)}/generate-tile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Suggest a concise tile title and the best visualization for this exact KQL query. Do not change the query.',
          kql: state.kql,
        }),
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok || !j?.tile) {
        setSuggestError(j?.error || `Copilot suggestion failed (HTTP ${r.status}).`);
        return;
      }
      const viz = (CONVERSION_VIZ_CHOICES.some((v) => v.value === j.tile.viz) ? j.tile.viz : 'table') as TileViz;
      const title = String(j.tile.title || '').slice(0, 200);
      setSuggested({ title, viz });
      setState((prev) => ({ ...prev, viz, title: title || prev.title }));
    } catch (e: any) {
      setSuggestError(e?.message || String(e));
    } finally {
      setSuggesting(false);
    }
  }, [itemId, state.kql]);

  /** Final step — POST the conversion route (real ADX validation + item write). */
  const create = useCallback(async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const r = await clientFetch('/api/thread/kql-query-to-dashboard-tile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          from: { id: itemId, type: 'kql-database', name: itemName },
          values: {
            dashboardId: state.dashboardId,
            newDashboardName: state.newDashboardName,
            kql: state.kql,
            title: state.title,
            viz: state.viz,
            size: state.size,
          },
        }),
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) {
        setCreateError(j?.error || `Tile creation failed (HTTP ${r.status}).`);
        return;
      }
      setDone({ link: String(j.link || ''), message: String(j.message || 'Tile created.') });
    } catch (e: any) {
      setCreateError(e?.message || String(e));
    } finally {
      setCreating(false);
    }
  }, [itemId, itemName, state]);

  const kqlPreview = useMemo(() => {
    const t = (state.kql || '').trim();
    return t.length > 600 ? `${t.slice(0, 600)}\n…` : t;
  }, [state.kql]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open && !creating) onClose(); }}>
      <DialogSurface style={{ maxWidth: 640 }}>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <GridDots20Regular /> Create dashboard tile from query
            </span>
          </DialogTitle>
          <DialogContent>
            {done ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                <MessageBar intent="success" layout="multiline">
                  <MessageBarBody>
                    <MessageBarTitle>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
                        <CheckmarkCircle20Regular /> Tile created
                      </span>
                    </MessageBarTitle>
                    {done.message}
                  </MessageBarBody>
                </MessageBar>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                {/* Step indicator */}
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                  {CONVERSION_WIZARD_STEPS.map((sKey, i) => (
                    <Badge
                      key={sKey}
                      appearance={i === stepIndex ? 'filled' : 'outline'}
                      color={i < stepIndex ? 'success' : i === stepIndex ? 'brand' : 'informative'}
                    >
                      {i + 1}. {CONVERSION_STEP_LABELS[sKey]}
                    </Badge>
                  ))}
                </div>

                {step === 'target' && (
                  <>
                    <Field label="Where should the tile go?">
                      <RadioGroup
                        value={state.dashboardId === '__new__' ? 'new' : 'existing'}
                        onChange={(_, d) => {
                          if (d.value === 'new') patch({ dashboardId: '__new__' });
                          else patch({ dashboardId: dashboards[0]?.id || '' });
                        }}
                      >
                        <Radio value="new" label="A new Real-Time Dashboard" />
                        <Radio
                          value="existing"
                          label={`An existing dashboard in this workspace${dashboards.length ? ` (${dashboards.length})` : ''}`}
                          disabled={!dashboardsLoading && dashboards.length === 0}
                        />
                      </RadioGroup>
                    </Field>
                    {state.dashboardId === '__new__' ? (
                      <Field label="New dashboard name" required hint="Created in the same workspace as this KQL database.">
                        <Input
                          value={state.newDashboardName}
                          onChange={(_, d) => patch({ newDashboardName: d.value })}
                          placeholder="e.g. Telemetry overview"
                        />
                      </Field>
                    ) : (
                      <Field
                        label="Existing dashboard"
                        required
                        hint={dashboardsLoading ? undefined : 'Real-Time Dashboards in this workspace.'}
                      >
                        {dashboardsLoading ? (
                          <Spinner size="tiny" labelPosition="after" label="Loading dashboards…" />
                        ) : (
                          <Select value={state.dashboardId} onChange={(_, d) => patch({ dashboardId: d.value })}>
                            {dashboards.map((d) => (
                              <option key={d.id} value={d.id}>{d.displayName}</option>
                            ))}
                          </Select>
                        )}
                      </Field>
                    )}
                  </>
                )}

                {step === 'visual' && (
                  <>
                    <Field label="Visual type" required hint="How the tile renders the query result.">
                      <Select value={state.viz} onChange={(_, d) => patch({ viz: d.value as TileViz })}>
                        {CONVERSION_VIZ_CHOICES.map((v) => (
                          <option key={v.value} value={v.value}>{v.label}</option>
                        ))}
                      </Select>
                    </Field>
                    <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={suggesting ? <Spinner size="tiny" /> : <Sparkle16Regular />}
                        disabled={suggesting}
                        onClick={helpMeChoose}
                      >
                        {suggesting ? 'Asking Copilot…' : 'Help me choose'}
                      </Button>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                        Copilot suggests the best visual + a title from your query.
                      </Caption1>
                    </div>
                    {suggested && !suggestError && (
                      <MessageBar intent="success" layout="multiline">
                        <MessageBarBody>
                          <MessageBarTitle>Copilot suggestion applied</MessageBarTitle>
                          Visual: <strong>{suggested.viz}</strong>
                          {suggested.title ? <> · Title: <strong>{suggested.title}</strong></> : null}
                          {' '}— adjust either before continuing.
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {suggestError && (
                      <MessageBar intent="warning" layout="multiline">
                        <MessageBarBody>
                          <MessageBarTitle>Copilot could not suggest</MessageBarTitle>
                          {suggestError}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                  </>
                )}

                {step === 'details' && (
                  <>
                    <Field label="Tile title" required hint="The heading shown on the dashboard tile.">
                      <Input
                        value={state.title}
                        onChange={(_, d) => patch({ title: d.value })}
                        placeholder="e.g. Events per hour"
                      />
                    </Field>
                    <Field label="Tile size" required hint="Grid footprint (the dashboard grid is 12 columns wide).">
                      <Select value={state.size} onChange={(_, d) => patch({ size: d.value as TileSizeKey })}>
                        {TILE_SIZES.map((sz) => (
                          <option key={sz.value} value={sz.value}>{sz.label}</option>
                        ))}
                      </Select>
                    </Field>
                  </>
                )}

                {step === 'review' && (
                  <>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                      <Caption1>
                        Target:{' '}
                        <strong>
                          {state.dashboardId === '__new__'
                            ? `New dashboard "${state.newDashboardName.trim()}"`
                            : dashboards.find((d) => d.id === state.dashboardId)?.displayName || state.dashboardId}
                        </strong>
                        {' '}· Visual: <strong>{CONVERSION_VIZ_CHOICES.find((v) => v.value === state.viz)?.label || state.viz}</strong>
                        {' '}· Title: <strong>{state.title.trim()}</strong>
                        {' '}· Size: <strong>{TILE_SIZES.find((sz) => sz.value === state.size)?.label || state.size}</strong>
                      </Caption1>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                        Creating the tile first executes this query against the real ADX cluster — a failing
                        query is rejected with the exact error.
                      </Caption1>
                      <pre
                        style={{
                          margin: 0,
                          padding: tokens.spacingVerticalS,
                          border: `1px solid ${tokens.colorNeutralStroke2}`,
                          borderRadius: tokens.borderRadiusMedium,
                          background: tokens.colorNeutralBackground2,
                          fontSize: tokens.fontSizeBase200,
                          maxHeight: 180,
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {kqlPreview}
                      </pre>
                    </div>
                    {createError && (
                      <MessageBar intent="error" layout="multiline">
                        <MessageBarBody>
                          <MessageBarTitle>Tile not created</MessageBarTitle>
                          {createError}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                  </>
                )}

                {!gate.ok && step !== 'review' && (
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{gate.reason}</Caption1>
                )}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            {done ? (
              <>
                <Button appearance="secondary" onClick={onClose}>Close</Button>
                <Button appearance="primary" onClick={() => { onClose(); if (done.link) router.push(done.link); }}>
                  Open the dashboard
                </Button>
              </>
            ) : (
              <>
                <Button appearance="secondary" disabled={creating} onClick={onClose}>Cancel</Button>
                {prevConversionStep(step) && (
                  <Button appearance="secondary" disabled={creating} onClick={() => setStep(prevConversionStep(step)!)}>
                    Back
                  </Button>
                )}
                {step !== 'review' ? (
                  <Button appearance="primary" disabled={!gate.ok} onClick={() => setStep(nextConversionStep(step)!)}>
                    Next
                  </Button>
                ) : (
                  <Button
                    appearance="primary"
                    disabled={!gate.ok || creating}
                    icon={creating ? <Spinner size="tiny" /> : undefined}
                    onClick={create}
                  >
                    {creating ? 'Validating against ADX…' : 'Create tile'}
                  </Button>
                )}
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
