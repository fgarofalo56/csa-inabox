'use client';

/**
 * SignInGate — small affordance that turns 401 responses into a clear
 * "Sign in to see your tenant data" CTA instead of misleading empty
 * states. Drop into any client component that reads from a session-gated
 * BFF route.
 */
import { Button, makeStyles, tokens, MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';

const useStyles = makeStyles({
  wrap: { marginTop: 8, marginBottom: 12 },
  row: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
});

export function SignInRequired({ subject }: { subject?: string }) {
  const styles = useStyles();
  return (
    <div className={styles.wrap}>
      <MessageBar intent="warning">
        <MessageBarTitle>Sign in required</MessageBarTitle>
        <MessageBarBody>
          <div className={styles.row}>
            <span>
              You're not signed in, so the page can't load
              {subject ? ` ${subject}` : ' tenant-scoped data'} yet.
            </span>
            <Button appearance="primary" size="small" as="a" href="/auth/sign-in">
              Sign in
            </Button>
          </div>
        </MessageBarBody>
      </MessageBar>
    </div>
  );
}

/**
 * Helper that returns true if a Response was a 401 (session expired /
 * not present). Centralizes the check so all panes behave consistently.
 */
export function isUnauthorized(r: Response): boolean {
  return r.status === 401 || r.status === 403;
}
