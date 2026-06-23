'use client';

/**
 * WarehouseAcceleration — the "Query acceleration" dialog for the Warehouse
 * editor, the Azure-native parity of Fabric's GPU-accelerated warehouse
 * (Fabric Build 2026). Two honest tiers, both wired to the real BFF
 * (/api/items/warehouse/[id]/query-acceleration):
 *
 *   1. GPU acceleration — a Fabric-engine-only capability. On the Azure-native
 *      default (Synapse Dedicated SQL pool, which has no GPU) the toggle is an
 *      HONEST GATE: it renders, is non-actionable, and a warning MessageBar
 *      names the exact opt-in (LOOM_WAREHOUSE_BACKEND=fabric-warehouse + a bound
 *      Fabric workspace). It is enabled + on only when the Fabric backend is
 *      opted into. We never fake GPU compute on Synapse.
 *
 *   2. Result-set caching — the REAL Azure-native query-acceleration knob. The
 *      Switch issues a live `ALTER DATABASE … SET RESULT_SET_CACHING { ON | OFF }`
 *      via the BFF and reflects sys.databases.is_result_set_caching_on. No mocks.
 *
 * Per no-fabric-dependency.md the surface is 100% functional with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset; per no-vaporware.md every control hits a
 * real backend or shows an honest gate.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Caption1, Body1, Switch, Spinner, Badge,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Flash24Regular, Database20Regular, Rocket20Regular, History20Regular } from '@fluentui/react-icons';

type WarehouseBackend = 'synapse-dedicated' | 'fabric-warehouse';

interface GpuStatus {
  available: boolean;
  enabled: boolean;
  engine: 'fabric' | 'synapse-dedicated';
  detail: string;
}

interface AccelerationStatus {
  ok: boolean;
  backend: WarehouseBackend;
  warehouse: string | null;
  sku: string | null;
  poolState: string;
  gpu: GpuStatus;
  resultSetCaching: {
    enabled: boolean | null;
    supported: boolean;
    detail: string;
  };
  error?: string;
}

const useStyles = makeStyles({
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  hint: { color: tokens.colorNeutralForeground3 },
  badges: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
    alignItems: 'center',
    flexWrap: 'wrap',
    marginBottom: tokens.spacingVerticalXS,
  },
  // Each acceleration tier is a self-contained card so the GPU (opt-in) and
  // result-set-caching (Azure-native) tiers read as distinct, scannable units.
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground1,
  },
  cardTitle: { fontWeight: tokens.fontWeightSemibold },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  cardStack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, paddingTop: tokens.spacingVerticalS },
  footnote: {
    color: tokens.colorNeutralForeground3,
    display: 'block',
    paddingTop: tokens.spacingVerticalS,
  },
});

export function WarehouseAcceleration({
  id,
  open,
  onOpenChange,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const s = useStyles();
  const [status, setStatus] = useState<AccelerationStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (id === 'new') return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/items/warehouse/${encodeURIComponent(id)}/query-acceleration`);
      const j = (await r.json()) as AccelerationStatus;
      if (!j.ok) setError(j.error || 'Could not load acceleration status');
      setStatus(j);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (open) {
      setNotice(null);
      void load();
    }
  }, [open, load]);

  const toggleResultSetCaching = useCallback(
    async (next: boolean) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const r = await fetch(`/api/items/warehouse/${encodeURIComponent(id)}/query-acceleration`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tier: 'result-set-caching', accelerate: next }),
        });
        const j = await r.json();
        if (!j.ok) {
          setError(j.error || 'Could not change result-set caching');
        } else {
          setNotice(`Result-set caching ${j.enabled ? 'enabled' : 'disabled'} on the warehouse.`);
        }
        await load();
      } catch (e: any) {
        setError(e?.message || String(e));
      } finally {
        setBusy(false);
      }
    },
    [id, load],
  );

  const requestGpu = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await fetch(`/api/items/warehouse/${encodeURIComponent(id)}/query-acceleration`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier: 'gpu', accelerate: true }),
      });
      const j = await r.json();
      if (!j.ok) setError(j.error || 'GPU acceleration is not available on this backend.');
      else setNotice('GPU acceleration is active on the Fabric warehouse engine.');
      await load();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [id, load]);

  const gpuAvailable = status?.gpu.available === true;
  const rscEnabled = status?.resultSetCaching.enabled === true;
  const poolOnline = status?.poolState === 'Online';

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: '680px', width: '92vw' }}>
        <DialogBody>
          <DialogTitle>
            <span className={s.header}>
              <Flash24Regular /> Query acceleration
            </span>
          </DialogTitle>
          <DialogContent>
            {loading && <Spinner size="small" label="Loading acceleration status…" labelPosition="after" />}

            {!loading && status && (
              <>
                <div className={s.badges}>
                  <Badge appearance="outline" icon={<Database20Regular />}>
                    {status.warehouse || 'warehouse —'}
                  </Badge>
                  <Badge appearance="outline">{status.sku || 'SKU —'}</Badge>
                  <Badge appearance="filled" color={poolOnline ? 'success' : 'warning'}>
                    {status.poolState}
                  </Badge>
                  <Badge appearance="tint" color={status.backend === 'fabric-warehouse' ? 'brand' : 'informative'}>
                    backend: {status.backend}
                  </Badge>
                </div>

                <div className={s.cardStack}>
                  {/* ---- GPU acceleration tier (Fabric-only; honest gate) ---- */}
                  <div className={s.card}>
                    <div className={s.cardHeader}>
                      <Rocket20Regular />
                      <Body1 className={s.cardTitle}>GPU acceleration</Body1>
                      <Badge
                        appearance="tint"
                        color={gpuAvailable ? 'brand' : 'informative'}
                        style={{ marginInlineStart: 'auto' }}
                      >
                        {gpuAvailable ? 'Fabric engine' : 'Opt-in'}
                      </Badge>
                    </div>
                    <div className={s.row}>
                      <Switch
                        checked={gpuAvailable && status.gpu.enabled}
                        disabled={!gpuAvailable || busy}
                        onChange={() => { if (gpuAvailable) void requestGpu(); }}
                        label="GPU-accelerated query execution"
                        aria-label="Toggle GPU-accelerated query execution"
                      />
                      {busy && gpuAvailable && <Spinner size="tiny" />}
                    </div>
                    {!gpuAvailable ? (
                      <MessageBar intent="warning">
                        <MessageBarBody>
                          <MessageBarTitle>GPU acceleration requires the Fabric backend</MessageBarTitle>
                          {status.gpu.detail}
                        </MessageBarBody>
                      </MessageBar>
                    ) : (
                      <Caption1 className={s.hint}>{status.gpu.detail}</Caption1>
                    )}
                  </div>

                  {/* ---- Result-set caching tier (Azure-native, functional) ---- */}
                  <div className={s.card}>
                    <div className={s.cardHeader}>
                      <History20Regular />
                      <Body1 className={s.cardTitle}>Result-set caching</Body1>
                      <Badge
                        appearance="tint"
                        color={rscEnabled ? 'success' : 'informative'}
                        style={{ marginInlineStart: 'auto' }}
                      >
                        {rscEnabled ? 'On' : 'Azure-native'}
                      </Badge>
                    </div>
                    <div className={s.row}>
                      <Switch
                        checked={rscEnabled}
                        disabled={!status.resultSetCaching.supported || !poolOnline || busy}
                        onChange={(_, d) => void toggleResultSetCaching(d.checked)}
                        label="Result-set caching (Azure-native acceleration)"
                        aria-label="Toggle result-set caching"
                      />
                      {busy && <Spinner size="tiny" />}
                    </div>
                    <Caption1 className={s.hint}>{status.resultSetCaching.detail}</Caption1>
                    {!poolOnline && status.resultSetCaching.supported && (
                      <MessageBar intent="info">
                        <MessageBarBody>
                          <MessageBarTitle>Warehouse compute is {status.poolState}</MessageBarTitle>
                          Resume the Synapse Dedicated SQL pool to change result-set caching.
                        </MessageBarBody>
                      </MessageBar>
                    )}
                  </div>
                </div>

                <Caption1 className={s.footnote}>
                  GPU acceleration is a Fabric-engine capability. The Azure-native default delivers query
                  acceleration via result-set caching plus the dedicated pool&apos;s batch-mode columnar engine.
                </Caption1>
              </>
            )}

            {notice && (
              <MessageBar intent="success" style={{ marginTop: tokens.spacingVerticalS }}>
                <MessageBarBody>{notice}</MessageBarBody>
              </MessageBar>
            )}
            {error && (
              <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS }}>
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => load()} disabled={loading || busy}>
              Refresh
            </Button>
            <Button appearance="primary" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
