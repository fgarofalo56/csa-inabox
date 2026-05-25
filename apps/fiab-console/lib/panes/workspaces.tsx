'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Title2,
  Body1,
  Card,
  CardHeader,
  CardPreview,
  Button,
  Input,
  Field,
  Textarea,
  Dialog,
  DialogTrigger,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  makeStyles,
  tokens,
  Spinner,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components';
import { Add24Regular } from '@fluentui/react-icons';
import Link from 'next/link';
import { listWorkspaces, createWorkspace, type Workspace } from '@/lib/api/workspaces';

const useStyles = makeStyles({
  header: { display: 'flex', alignItems: 'center', marginBottom: '24px', gap: '16px' },
  spacer: { flex: 1 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '16px',
  },
  card: {
    width: '100%',
    minHeight: '160px',
    cursor: 'pointer',
    transition: 'transform 0.15s, box-shadow 0.15s',
    ':hover': { transform: 'translateY(-2px)', boxShadow: tokens.shadow8 },
  },
  meta: { fontSize: '12px', color: tokens.colorNeutralForeground3 },
  empty: {
    padding: '40px',
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: '8px',
  },
  formCol: { display: 'flex', flexDirection: 'column', gap: '12px' },
});

function CreateWorkspaceDialog() {
  const styles = useStyles();
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [capacity, setCapacity] = useState('');
  const [domain, setDomain] = useState('');

  const mut = useMutation({
    mutationFn: () => createWorkspace({
      name,
      description: description || undefined,
      capacity: capacity || undefined,
      domain: domain || undefined,
    }),
    onSuccess: (ws) => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      setOpen(false);
      setName(''); setDescription(''); setCapacity(''); setDomain('');
      router.push(`/workspaces/${ws.id}`);
    },
  });

  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Button appearance="primary" icon={<Add24Regular />}>New workspace</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Create workspace</DialogTitle>
          <DialogContent>
            <div className={styles.formCol}>
              <Field label="Name" required>
                <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="Sales analytics" />
              </Field>
              <Field label="Description">
                <Textarea value={description} onChange={(_, d) => setDescription(d.value)} rows={2} />
              </Field>
              <Field label="Capacity (optional)">
                <Input value={capacity} onChange={(_, d) => setCapacity(d.value)} placeholder="F64" />
              </Field>
              <Field label="Domain (optional)">
                <Input value={domain} onChange={(_, d) => setDomain(d.value)} placeholder="Sales" />
              </Field>
              {mut.error && (
                <MessageBar intent="error">
                  <MessageBarBody>{(mut.error as Error).message}</MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Cancel</Button>
            </DialogTrigger>
            <Button
              appearance="primary"
              disabled={!name.trim() || mut.isPending}
              onClick={() => mut.mutate()}
            >
              {mut.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export function WorkspacesPane() {
  const styles = useStyles();
  const { data, isLoading, error } = useQuery<Workspace[]>({
    queryKey: ['workspaces'],
    queryFn: listWorkspaces,
  });

  return (
    <div>
      <div className={styles.header}>
        <Title2>Workspaces</Title2>
        <div className={styles.spacer} />
        <CreateWorkspaceDialog />
      </div>

      {isLoading && <Spinner label="Loading workspaces…" />}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>Failed to load workspaces: {(error as Error).message}</MessageBarBody>
        </MessageBar>
      )}

      {data && data.length === 0 && (
        <div className={styles.empty}>
          <Body1>No workspaces yet. Create one to get started.</Body1>
        </div>
      )}

      {data && data.length > 0 && (
        <div className={styles.grid}>
          {data.map((ws) => (
            <Link key={ws.id} href={`/workspaces/${ws.id}`} style={{ textDecoration: 'none' }}>
              <Card className={styles.card}>
                <CardPreview style={{ backgroundColor: tokens.colorBrandBackground2, height: '60px' }} />
                <CardHeader
                  header={<Body1 weight="semibold">{ws.name}</Body1>}
                  description={
                    <div>
                      {ws.description && <Body1>{ws.description}</Body1>}
                      <div className={styles.meta}>
                        {[ws.capacity, ws.domain].filter(Boolean).join(' · ') || 'No capacity / domain'}
                      </div>
                      <div className={styles.meta}>Created {new Date(ws.createdAt).toLocaleDateString()}</div>
                    </div>
                  }
                />
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
