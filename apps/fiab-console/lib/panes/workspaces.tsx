'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Title2,
  Body1,
  Card,
  CardHeader,
  CardPreview,
  Button,
  makeStyles,
  tokens,
  Spinner,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components';
import { Add24Regular } from '@fluentui/react-icons';
import Link from 'next/link';
import { listWorkspaces, type Workspace } from '@/lib/api/workspaces';

const useStyles = makeStyles({
  header: {
    display: 'flex',
    alignItems: 'center',
    marginBottom: '24px',
    gap: '16px',
  },
  spacer: { flex: 1 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '16px',
  },
  card: {
    width: '100%',
    height: '160px',
    cursor: 'pointer',
    transition: 'transform 0.15s, box-shadow 0.15s',
    ':hover': {
      transform: 'translateY(-2px)',
      boxShadow: tokens.shadow8,
    },
  },
  capacity: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
  },
});

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
        <Button appearance="primary" icon={<Add24Regular />}>
          New workspace
        </Button>
      </div>

      {isLoading && <Spinner label="Loading workspaces..." />}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>Failed to load workspaces. Check your tenant connection.</MessageBarBody>
        </MessageBar>
      )}

      {data && (
        <div className={styles.grid}>
          {data.map((ws) => (
            <Link key={ws.id} href={`/workspace/${ws.id}`}>
              <Card className={styles.card}>
                <CardPreview style={{ backgroundColor: tokens.colorBrandBackground2, height: '60px' }} />
                <CardHeader
                  header={<Body1 weight="semibold">{ws.name}</Body1>}
                  description={
                    <div>
                      <Body1>{ws.itemCount} items</Body1>
                      <div className={styles.capacity}>{ws.capacitySku} · {ws.region}</div>
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
