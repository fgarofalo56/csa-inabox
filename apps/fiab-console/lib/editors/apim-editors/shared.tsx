// shared.tsx — shared StatusBar component + LoadState type for the APIM /
// data-product editors. Extracted verbatim from apim-editors.tsx (WS-E1).
import { Spinner, MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';

export function StatusBar({ status }: { status: { kind: 'idle' | 'saving' | 'ok' | 'err'; msg?: string } }) {
  if (status.kind === 'idle') return null;
  if (status.kind === 'saving') return <Spinner size="tiny" label="Saving to APIM…" labelPosition="after" />;
  if (status.kind === 'ok') {
    return (
      <MessageBar intent="success">
        <MessageBarBody><MessageBarTitle>Saved</MessageBarTitle>{status.msg}</MessageBarBody>
      </MessageBar>
    );
  }
  return (
    <MessageBar intent="error">
      <MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{status.msg || 'Unknown error'}</MessageBarBody>
    </MessageBar>
  );
}

export type LoadState<T> = { loading: boolean; data: T | null; error?: string };
