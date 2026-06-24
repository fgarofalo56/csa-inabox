'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Body1,
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
import { SignInRequired } from '@/lib/components/sign-in-required';

const useStyles = makeStyles({
  header: { display: 'flex', alignItems: 'center', marginBottom: tokens.spacingVerticalXL, gap: tokens.spacingHorizontalL, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  card: {
    paddingTop: '20px', paddingRight: '20px', paddingBottom: '20px', paddingLeft: '20px',
    borderRadius: '12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    textDecoration: 'none',
    display: 'flex', flexDirection: 'column',
    minWidth: 0,
    minHeight: '140px',
    cursor: 'pointer',
    transition: 'transform 0.15s, box-shadow 0.15s, border-color 0.15s',
    ':hover': {
      transform: 'translateY(-2px)',
      boxShadow: tokens.shadow8,
      borderColor: tokens.colorBrandStroke1,
    },
  },
  cardName: { fontSize: '15px', fontWeight: 600, lineHeight: 1.3, marginBottom: '8px', overflowWrap: 'anywhere', wordBreak: 'break-word' },
  cardDesc: { fontSize: '13px', color: tokens.colorNeutralForeground2, lineHeight: 1.45, marginBottom: '10px', overflowWrap: 'anywhere', wordBreak: 'break-word' },
  meta: { fontSize: '11px', color: tokens.colorNeutralForeground3, marginTop: 'auto' },
  empty: {
    paddingTop: '32px', paddingRight: '32px', paddingBottom: '32px', paddingLeft: '32px',
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: '12px',
    lineHeight: 1.6,
  },
  formCol: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
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

  const unauth = error && (error as any)?.message?.includes('401');

  return (
    <div>
      <div className={styles.header}>
        <div className={styles.spacer} />
        <CreateWorkspaceDialog />
      </div>

      {unauth && <SignInRequired subject="workspaces" />}

      {isLoading && <Spinner label="Loading workspaces…" />}

      {error && !unauth && (
        <MessageBar intent="error">
          <MessageBarBody>Failed to load workspaces: {(error as Error).message}</MessageBarBody>
        </MessageBar>
      )}

      {data && data.length === 0 && (
        <div className={styles.empty}>
          No workspaces yet. Click <b>+ New workspace</b> to create your first one.<br />
          A workspace is a Cosmos-backed container that owns items + permissions + SCM bindings.
        </div>
      )}

      {data && data.length > 0 && (
        <div className={styles.grid}>
          {data.map((ws) => (
            <Link key={ws.id} href={`/workspaces/${ws.id}`} className={styles.card}>
              <div className={styles.cardName}>{ws.name}</div>
              {ws.description && <div className={styles.cardDesc}>{ws.description}</div>}
              <div className={styles.meta}>
                {[ws.capacity, ws.domain].filter(Boolean).join(' · ') || 'No capacity / domain'}
                {' · Created '}{new Date(ws.createdAt).toLocaleDateString()}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
