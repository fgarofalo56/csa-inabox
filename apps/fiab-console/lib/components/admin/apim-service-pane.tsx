'use client';

import { useEffect, useState } from 'react';
import {
  makeStyles, tokens, Spinner, MessageBar, MessageBarBody, MessageBarTitle,
  Body1, Caption1, Badge, Button, Dialog, DialogTrigger, DialogSurface, DialogContent, DialogBody,
  DialogTitle, DialogActions, Dropdown, Option, SpinButton, Field,
} from '@fluentui/react-components';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { ApimServiceShape } from '@/lib/azure/apim-client';
import { apimFetchJson } from './apim-pane-fetch';

const useStyles = makeStyles({
  stats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: tokens.spacingHorizontalL,
    marginBottom: tokens.spacingVerticalL,
  },
  stat: {
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  statLabel: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', color: tokens.colorNeutralForeground3, fontWeight: 600 },
  statValue: { fontSize: '20px', fontWeight: 700, marginTop: '8px', lineHeight: 1.1 },
});

const SKU_OPTIONS = ['Developer', 'Basic', 'Standard', 'Premium', 'BasicV2', 'StandardV2'];
const CAPACITY_RANGE = { min: 1, max: 10 };

export function ApimServicePane() {
  const styles = useStyles();
  const [service, setService] = useState<ApimServiceShape | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newSku, setNewSku] = useState('');
  const [newCapacity, setNewCapacity] = useState(1);
  const [scaling, setScaling] = useState(false);

  useEffect(() => {
    apimFetchJson('/api/apim/service')
      .then((d) => {
        if (d.ok && d.service) {
          const svc = d.service as ApimServiceShape;
          setService(svc);
          setNewSku(svc.sku.name);
          setNewCapacity(svc.sku.capacity);
        } else {
          setError((d.error as string) || 'Failed to load service');
        }
        setLoading(false);
      })
      .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false); });
  }, []);

  async function handleScale() {
    setScaling(true);
    setError(null);
    try {
      const d = await apimFetchJson('/api/apim/service', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sku: newSku, capacity: newCapacity }),
      });
      if (d.ok && d.service) {
        setService(d.service as ApimServiceShape);
      } else {
        setError((d.error as string) || 'Scale operation failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScaling(false);
    }
  }

  if (loading) return <Section><Spinner label="Loading service..." /></Section>;
  if (error) {
    return (
      <Section>
        <MessageBar intent="error">
          <MessageBarTitle>Error</MessageBarTitle>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      </Section>
    );
  }

  if (!service) {
    return (
      <Section>
        <MessageBar intent="warning">
          <MessageBarBody>Service not found.</MessageBarBody>
        </MessageBar>
      </Section>
    );
  }

  const stateColor =
    service.provisioningState === 'Succeeded' ? 'success' :
    service.provisioningState === 'Updating' ? 'warning' : 'subtle';

  return (
    <>
      <Section title="Service overview">
        <div className={styles.stats}>
          <div className={styles.stat}>
            <div className={styles.statLabel}>Service</div>
            <div className={styles.statValue}>{service.name}</div>
            <Caption1>{service.location}</Caption1>
          </div>
          <div className={styles.stat}>
            <div className={styles.statLabel}>SKU</div>
            <div className={styles.statValue}>{service.sku.name}</div>
            <Caption1>Capacity: {service.sku.capacity}</Caption1>
          </div>
          <div className={styles.stat}>
            <div className={styles.statLabel}>State</div>
            <Badge appearance="outline" color={stateColor}>
              {service.provisioningState || 'Unknown'}
            </Badge>
          </div>
        </div>
      </Section>

      <Section title="Scale SKU & capacity">
        <Dialog>
          <DialogTrigger disableButtonEnhancement>
            <Button appearance="primary">Change SKU</Button>
          </DialogTrigger>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Scale APIM Service</DialogTitle>
              <DialogContent>
                <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                  <Field label="SKU">
                    <Dropdown
                      value={newSku}
                      selectedOptions={[newSku]}
                      onOptionSelect={(_, d) => setNewSku(d.optionValue || '')}
                    >
                      {SKU_OPTIONS.map((s) => <Option key={s} value={s}>{s}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Capacity">
                    <SpinButton
                      value={newCapacity}
                      onChange={(_, d) => {
                        const raw = d.value ?? (d.displayValue ? parseInt(d.displayValue, 10) : newCapacity);
                        setNewCapacity(Math.max(CAPACITY_RANGE.min, Math.min(CAPACITY_RANGE.max, Number(raw) || 1)));
                      }}
                      min={CAPACITY_RANGE.min}
                      max={CAPACITY_RANGE.max}
                      step={1}
                    />
                  </Field>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    SKU update is async — this initiates a PATCH and returns immediately. Monitor provisioning state for completion.
                  </Caption1>
                </div>
              </DialogContent>
              <DialogActions>
                <DialogTrigger disableButtonEnhancement>
                  <Button appearance="secondary">Cancel</Button>
                </DialogTrigger>
                <Button appearance="primary" onClick={handleScale} disabled={scaling}>
                  {scaling ? 'Scaling...' : 'Apply'}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </Section>
    </>
  );
}
