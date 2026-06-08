'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Field, Dropdown, Option, Textarea, MessageBar, MessageBarTitle,
  MessageBarBody, Spinner, Badge, makeStyles, tokens,
} from '@fluentui/react-components';
import { KeyRegular } from '@fluentui/react-icons';
import type { AccessRequest } from '@/lib/types/access-request';
import type { PermittedPurpose } from '@/app/api/data-products/[id]/policies/route';

interface Props {
  dataProductId: string;
  dataProductName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (req: AccessRequest) => void;
}

const useStyles = makeStyles({
  surface: { maxWidth: '520px' },
  field: { marginBottom: tokens.spacingVerticalM },
  receipt: { marginTop: tokens.spacingVerticalS },
});

/**
 * F15 — "Request access" dialog. Lists ONLY the permitted purposes the owner
 * defined for this data product (Access-kind governance policies, fetched via
 * GET /api/data-products/[id]/policies). Submitting POSTs a real, purpose-bound
 * access request to Cosmos and shows a receipt with the new request id.
 */
export function RequestAccessDialog({
  dataProductId, dataProductName, open, onOpenChange, onSuccess,
}: Props) {
  const styles = useStyles();
  const [policies, setPolicies] = useState<PermittedPurpose[]>([]);
  const [loadingPolicies, setLoadingPolicies] = useState(false);
  const [selectedPolicyId, setSelectedPolicyId] = useState('');
  const [selectedPurposeName, setSelectedPurposeName] = useState('');
  const [justification, setJustification] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<AccessRequest | null>(null);

  const loadPolicies = useCallback(async () => {
    if (!dataProductId) return;
    setLoadingPolicies(true);
    setError(null);
    try {
      const r = await fetch(`/api/data-products/${dataProductId}/policies`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setPolicies([]); return; }
      setPolicies(j.policies ?? []);
    } catch (e: any) {
      setError(e?.message || String(e));
      setPolicies([]);
    } finally {
      setLoadingPolicies(false);
    }
  }, [dataProductId]);

  useEffect(() => {
    if (open) {
      setSelectedPolicyId('');
      setSelectedPurposeName('');
      setJustification('');
      setError(null);
      setReceipt(null);
      loadPolicies();
    }
  }, [open, loadPolicies]);

  const handleSubmit = useCallback(async () => {
    if (!selectedPolicyId) { setError('Select a permitted purpose.'); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/data-products/${dataProductId}/access-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ policyId: selectedPolicyId, purposeName: selectedPurposeName, justification }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setReceipt(j.request as AccessRequest);
      onSuccess?.(j.request as AccessRequest);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [dataProductId, selectedPolicyId, selectedPurposeName, justification, onSuccess]);

  const noPolicies = !loadingPolicies && policies.length === 0;

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>Request access — {dataProductName}</DialogTitle>
          <DialogContent>
            {receipt ? (
              <MessageBar intent="success" className={styles.receipt}>
                <MessageBarBody>
                  <MessageBarTitle>Request submitted</MessageBarTitle>
                  Purpose: <strong>{receipt.purposeName}</strong> · Status:{' '}
                  <Badge appearance="tint" color="warning">pending</Badge>
                  <br />
                  Request ID: <code>{receipt.id}</code>
                  <br />
                  The owner reviews it in their approver inbox; you can track it
                  under <strong>My data access</strong>.
                </MessageBarBody>
              </MessageBar>
            ) : (
              <>
                {loadingPolicies && <Spinner size="small" label="Loading permitted purposes…" />}
                {noPolicies && !error && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>No access purposes configured</MessageBarTitle>
                      The data product owner has not defined any permitted access
                      purposes for this product. Contact the owner to add an
                      Access policy before requesting access.
                    </MessageBarBody>
                  </MessageBar>
                )}
                {!loadingPolicies && policies.length > 0 && (
                  <>
                    <Field label="Permitted purpose" required className={styles.field}>
                      <Dropdown
                        placeholder="Select a purpose"
                        value={selectedPurposeName}
                        selectedOptions={selectedPolicyId ? [selectedPolicyId] : []}
                        onOptionSelect={(_, d) => {
                          setSelectedPolicyId(d.optionValue ?? '');
                          setSelectedPurposeName(d.optionText ?? '');
                        }}
                      >
                        {policies.map((p) => (
                          <Option key={p.id} value={p.id} text={p.name}>
                            {p.name}
                          </Option>
                        ))}
                      </Dropdown>
                    </Field>
                    <Field label="Justification (optional)" className={styles.field}>
                      <Textarea
                        rows={3}
                        placeholder="Briefly explain your use case"
                        value={justification}
                        onChange={(_, d) => setJustification(d.value)}
                        resize="vertical"
                      />
                    </Field>
                  </>
                )}
                {error && (
                  <MessageBar intent="error">
                    <MessageBarBody>{error}</MessageBarBody>
                  </MessageBar>
                )}
              </>
            )}
          </DialogContent>
          <DialogActions>
            {receipt ? (
              <Button appearance="primary" onClick={() => onOpenChange(false)}>Close</Button>
            ) : (
              <>
                <Button
                  appearance="primary"
                  icon={busy ? <Spinner size="tiny" /> : <KeyRegular />}
                  disabled={busy || noPolicies || !selectedPolicyId}
                  onClick={handleSubmit}
                >
                  {busy ? 'Submitting…' : 'Send request'}
                </Button>
                <Button appearance="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
