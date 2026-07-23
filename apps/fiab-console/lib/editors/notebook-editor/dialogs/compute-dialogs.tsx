'use client';

// notebook-editor/dialogs/compute-dialogs.tsx — the two self-contained Azure ML
// compute dialogs (Configure compute / New compute instance), extracted from
// notebook-editor.tsx (R9 decomposition). Dropdown-only per
// loom_no_freeform_config. JSX verbatim from the shell — the closed-over state
// and handlers become fully-typed props, so behavior is preserved. The shell
// keeps the owning state (configCi*/newCi*) + the POST handlers.
import {
  Button, Input, Select, Caption1,
  MessageBar, MessageBarBody,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  tokens,
} from '@fluentui/react-components';
import { IDLE_TTL_OPTIONS, AML_CI_VM_SIZES } from '../constants';
import type { ComputeTarget } from '../types';

/** Configure compute — idle auto-shutdown TTL for the selected CI. Dropdown
 *  only (loom_no_freeform_config). POST .../idle-shutdown. */
export function ConfigureComputeDialog(props: {
  open: boolean;
  onClose: () => void;
  selectedCompute: ComputeTarget | null;
  ttl: string;
  onTtlChange: (v: string) => void;
  err: string | null;
  busy: boolean;
  onSave: () => void;
}) {
  const { open, onClose, selectedCompute, ttl, onTtlChange, err, busy, onSave } = props;
  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Configure compute</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
              <Caption1>
                Auto-stop {selectedCompute?.name ? <strong>{selectedCompute.name}</strong> : 'this Compute Instance'} after it sits idle, so it stops billing.
              </Caption1>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                <Caption1>Idle shutdown</Caption1>
                <Select aria-label="Idle shutdown" value={ttl} onChange={(_, d) => onTtlChange(d.value)}>
                  {IDLE_TTL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </div>
              {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={busy} onClick={onSave}>{busy ? 'Saving…' : 'Save'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** New Compute Instance — name + VM size + idle TTL (dropdowns only).
 *  POST /api/aml/compute-instances → createCI. */
export function NewComputeInstanceDialog(props: {
  open: boolean;
  onClose: () => void;
  name: string;
  onNameChange: (v: string) => void;
  vmSize: string;
  onVmSizeChange: (v: string) => void;
  ttl: string;
  onTtlChange: (v: string) => void;
  err: string | null;
  busy: boolean;
  onCreate: () => void;
}) {
  const { open, onClose, name, onNameChange, vmSize, onVmSizeChange, ttl, onTtlChange, err, busy, onCreate } = props;
  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>New compute instance</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                <Caption1>Name</Caption1>
                <Input placeholder="my-compute" value={name} onChange={(_, d) => onNameChange(d.value)} style={{ width: '100%' }} />
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>3-24 chars · start with a letter · letters, numbers, and hyphens.</Caption1>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                <Caption1>Virtual machine size</Caption1>
                <Select aria-label="VM size" value={vmSize} onChange={(_, d) => onVmSizeChange(d.value)}>
                  {AML_CI_VM_SIZES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                <Caption1>Idle shutdown</Caption1>
                <Select aria-label="Idle shutdown" value={ttl} onChange={(_, d) => onTtlChange(d.value)}>
                  {IDLE_TTL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </div>
              {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={busy || !name.trim()} onClick={onCreate}>{busy ? 'Creating…' : 'Create'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
