'use client';

/**
 * SparkLineageFixitDialog (issue #2625) — the inline **Fix it** wizard behind
 * the Runs-tab lineage gate.
 *
 * WHAT IT ACTUALLY DOES (no-vaporware): the operator picks the workspace
 * storage roots this job READS and WRITES from a live, server-supplied list;
 * Apply writes them into the job's `spec.conf` as
 * `spark.loom.lineage.inputs` / `spark.loom.lineage.outputs` — the exact keys
 * `parseSparkDatasets` reads — and persists the spec through the item's own
 * PUT. Every subsequent successful batch then stamps real lineage edges with
 * no listener, no Fabric, and no further operator action.
 *
 * PICKERS ONLY, NEVER A TEXT BOX (`loom_no_freeform_config`). The options come
 * from GET …/lineage-targets, which returns the SAME candidate set the harvest
 * resolves against, scoped to this item's own workspace — so every option is
 * one that provably resolves to a deep-linkable Loom item, and none of them
 * discloses another workspace's storage layout.
 *
 * The higher-fidelity alternative (column-level lineage from the
 * openlineage-spark listener) is a pool-config step, not an item one, so it is
 * offered here as a deep link to its own registry gate rather than pretended
 * to be resolvable from this dialog.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Button, Caption1, Dialog, DialogActions, DialogBody, DialogContent,
  DialogSurface, DialogTitle, Dropdown, Field, MessageBar, MessageBarBody,
  MessageBarTitle, Option, Spinner, makeStyles, tokens,
} from '@fluentui/react-components';
import { Open16Regular, Wrench16Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import {
  SPARK_CONF_INPUTS,
  SPARK_CONF_OUTPUTS,
} from '@/lib/lineage/spark-conf-keys';
import { SPARK_LINEAGE_GATE_ID } from './harvest-receipt';
import { applyLineageConf, selectedFromConf } from './lineage-conf';

const useStyles = makeStyles({
  fields: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    marginTop: tokens.spacingVerticalM,
  },
  meta: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
  },
  listener: { marginTop: tokens.spacingVerticalL },
});

export interface LineageTargetOption {
  path: string;
  itemId: string;
  itemType: string;
  displayName: string;
}

/**
 * Merge the picked roots into an existing Spark conf.
 *
 * PURE + exported so the write is unit-testable without a DOM. Unrelated conf
 * keys are preserved verbatim; an empty selection DELETES its key rather than
 * writing an empty string, because `parseSparkDatasets` splits on `,` and an
 * empty value would leave a stale, meaningless declaration behind.
 */
export { applyLineageConf, selectedFromConf } from './lineage-conf';

export function SparkLineageFixitDialog({
  open,
  onClose,
  itemId,
  conf,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  /** The spark-job-definition item id (scopes the options query). */
  itemId: string;
  /** The job's CURRENT spec.conf — preserved except for the two lineage keys. */
  conf: Record<string, string>;
  /** Persists the merged conf (the editor's real item PUT). */
  onApply: (nextConf: Record<string, string>) => Promise<void>;
}) {
  const s = useStyles();
  const [targets, setTargets] = useState<LineageTargetOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<string[]>([]);
  const [outputs, setOutputs] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    setTargets(null);
    try {
      const r = await clientFetch(`/api/items/spark-job-definition/${encodeURIComponent(itemId)}/lineage-targets`);
      const j = await r.json().catch(() => null);
      if (j?.ok) setTargets((j.targets || []) as LineageTargetOption[]);
      else setLoadError(j?.error || `could not list workspace datasets (${r.status})`);
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    }
  }, [itemId]);

  useEffect(() => {
    if (!open) return;
    setApplied(false);
    setApplyError(null);
    setInputs(selectedFromConf(conf, SPARK_CONF_INPUTS));
    setOutputs(selectedFromConf(conf, SPARK_CONF_OUTPUTS));
    void load();
    // `conf` is a fresh object identity on every editor render — keying the
    // reset on `open` alone is deliberate, so re-renders don't wipe a picker
    // the operator is mid-way through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, load]);

  const apply = useCallback(async () => {
    setApplying(true);
    setApplyError(null);
    try {
      await onApply(applyLineageConf(conf, inputs, outputs));
      setApplied(true);
    } catch (e: any) {
      setApplyError(e?.message || String(e));
    } finally {
      setApplying(false);
    }
  }, [conf, inputs, outputs, onApply]);

  const label = (path: string) => {
    const t = targets?.find((x) => x.path === path);
    return t ? `${t.displayName} — ${t.path}` : path;
  };
  // BOTH sides are required: `sparkBatchRunEvent` emits nothing without an
  // input AND an output, so a half-declaration would leave the gate showing.
  const canApply = inputs.length > 0 && outputs.length > 0 && !applying;

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Declare this job&apos;s lineage datasets</DialogTitle>
          <DialogContent>
            <Caption1 className={s.meta}>
              Loom derives lineage from what a batch actually submitted. Pick the storage roots this job
              reads and writes; they are saved on the job spec as <code>{SPARK_CONF_INPUTS}</code> and{' '}
              <code>{SPARK_CONF_OUTPUTS}</code>, and every successful run from then on stamps lineage
              edges onto the canvas automatically.
            </Caption1>

            {!targets && !loadError && (
              <div className={s.row}><Spinner size="tiny" /><Caption1>Loading workspace datasets…</Caption1></div>
            )}

            {loadError && (
              <MessageBar intent="warning" layout="multiline" style={{ marginTop: tokens.spacingVerticalS }}>
                <MessageBarBody>
                  <MessageBarTitle>Could not list workspace datasets</MessageBarTitle>
                  {loadError}
                </MessageBarBody>
              </MessageBar>
            )}

            {targets && targets.length === 0 && (
              <MessageBar intent="warning" layout="multiline" style={{ marginTop: tokens.spacingVerticalS }}>
                <MessageBarBody>
                  <MessageBarTitle>No storage-rooted items in this workspace yet</MessageBarTitle>
                  Lineage endpoints are the storage roots of real Loom items. Create a lakehouse (or a mirrored
                  database) in this workspace first — its ADLS root then appears here and this job can declare
                  it as an input or output.
                </MessageBarBody>
              </MessageBar>
            )}

            {targets && targets.length > 0 && (
              <div className={s.fields}>
                <Field label="Reads from (inputs)" hint="One or more storage roots this job reads.">
                  <Dropdown
                    multiselect
                    aria-label="Reads from (inputs)"
                    placeholder="Select input datasets"
                    selectedOptions={inputs}
                    value={inputs.map(label).join(', ')}
                    onOptionSelect={(_, d) => setInputs(d.selectedOptions)}
                  >
                    {targets.map((t) => (
                      <Option key={`in-${t.path}`} value={t.path} text={`${t.displayName} — ${t.path}`}>
                        {`${t.displayName} (${t.itemType}) — ${t.path}`}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label="Writes to (outputs)" hint="One or more storage roots this job writes.">
                  <Dropdown
                    multiselect
                    aria-label="Writes to (outputs)"
                    placeholder="Select output datasets"
                    selectedOptions={outputs}
                    value={outputs.map(label).join(', ')}
                    onOptionSelect={(_, d) => setOutputs(d.selectedOptions)}
                  >
                    {targets.map((t) => (
                      <Option key={`out-${t.path}`} value={t.path} text={`${t.displayName} — ${t.path}`}>
                        {`${t.displayName} (${t.itemType}) — ${t.path}`}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              </div>
            )}

            {applyError && (
              <MessageBar intent="error" layout="multiline" style={{ marginTop: tokens.spacingVerticalS }}>
                <MessageBarBody>{applyError}</MessageBarBody>
              </MessageBar>
            )}
            {applied && (
              <MessageBar intent="success" layout="multiline" style={{ marginTop: tokens.spacingVerticalS }}>
                <MessageBarBody>
                  <MessageBarTitle>Saved to the job spec</MessageBarTitle>
                  The next successful batch stamps lineage for these datasets. Existing runs are not
                  back-filled — Loom only records what a run actually declared.
                </MessageBarBody>
              </MessageBar>
            )}

            <MessageBar intent="info" layout="multiline" className={s.listener}>
              <MessageBarBody>
                <MessageBarTitle>Want column-level lineage instead?</MessageBarTitle>
                The openlineage-spark listener reports the columns a job read and wrote, not just the
                datasets. It is a one-time Spark-pool configuration rather than a per-job setting, so it is
                managed as its own gate in the registry.
              </MessageBarBody>
            </MessageBar>
            <Button
              as="a"
              size="small"
              appearance="transparent"
              icon={<Open16Regular />}
              href={`/admin/gates?q=${encodeURIComponent(SPARK_LINEAGE_GATE_ID)}`}
            >
              Set up the Spark lineage listener
            </Button>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Close</Button>
            <Button
              appearance="primary"
              icon={applying ? <Spinner size="tiny" /> : <Wrench16Regular />}
              disabled={!canApply}
              onClick={apply}
            >
              Save declaration
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
