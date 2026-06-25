'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Field, Dropdown, Option, Textarea, MessageBar, MessageBarTitle,
  MessageBarBody, Spinner, Skeleton, SkeletonItem, Badge, Caption1, Subtitle2,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  KeyRegular, CheckmarkCircleFilled, ShieldKeyholeRegular,
} from '@fluentui/react-icons';
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
  // Web3.0 dialog header — Fluent icon chip + title + caption
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  titleIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    flexShrink: 0,
    borderRadius: tokens.borderRadiusLarge,
    backgroundImage: `linear-gradient(135deg, ${tokens.colorBrandBackground2}, ${tokens.colorBrandBackground})`,
    color: tokens.colorNeutralForegroundOnBrand,
    fontSize: '20px',
    boxShadow: tokens.shadow4,
  },
  titleText: { display: 'flex', flexDirection: 'column', minWidth: 0, gap: tokens.spacingVerticalXXS },
  titleSub: { color: tokens.colorNeutralForeground3 },
  // Skeleton loading block that mirrors the form shape
  loadingBlock: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  skelLabel: { width: '40%' },
  skelDropdown: { width: '100%' },
  skelTextarea: { width: '100%' },
  // Elevated success-receipt card
  receiptCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    marginTop: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorPaletteGreenBorder1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow16,
  },
  receiptHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorPaletteGreenForeground1,
  },
  receiptHeaderIcon: { fontSize: '22px' },
  receiptRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground2,
  },
  receiptCode: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
  },
  receiptHint: { color: tokens.colorNeutralForeground3 },
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
          <DialogTitle>
            <div className={styles.titleRow}>
              <span className={styles.titleIcon} aria-hidden><ShieldKeyholeRegular /></span>
              <span className={styles.titleText}>
                <Subtitle2>Request access</Subtitle2>
                <Caption1 className={styles.titleSub}>{dataProductName}</Caption1>
              </span>
            </div>
          </DialogTitle>
          <DialogContent>
            {receipt ? (
              <div className={styles.receiptCard} role="status">
                <div className={styles.receiptHeader}>
                  <CheckmarkCircleFilled className={styles.receiptHeaderIcon} aria-hidden />
                  <Subtitle2>Request submitted</Subtitle2>
                </div>
                <div className={styles.receiptRow}>
                  Purpose:&nbsp;<strong>{receipt.purposeName}</strong>
                  <span aria-hidden>·</span>
                  Status:&nbsp;<Badge appearance="tint" color="warning">pending</Badge>
                </div>
                <div className={styles.receiptRow}>
                  Request ID:&nbsp;<span className={styles.receiptCode}>{receipt.id}</span>
                </div>
                <Caption1 className={styles.receiptHint}>
                  The owner reviews it in their approver inbox; you can track it
                  under <strong>My data access</strong>.
                </Caption1>
              </div>
            ) : (
              <>
                {loadingPolicies && (
                  <Skeleton aria-label="Loading permitted purposes" className={styles.loadingBlock}>
                    <SkeletonItem size={16} className={styles.skelLabel} />
                    <SkeletonItem size={32} className={styles.skelDropdown} />
                    <SkeletonItem size={16} className={styles.skelLabel} />
                    <SkeletonItem size={72} className={styles.skelTextarea} />
                  </Skeleton>
                )}
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
