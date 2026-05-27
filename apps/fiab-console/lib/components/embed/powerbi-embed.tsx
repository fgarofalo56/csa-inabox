'use client';

/**
 * PowerBIEmbedFrame — production embed surface for Power BI reports,
 * dashboards, and semantic-model exploration. Replaces the v3.x
 * "metadata text" placeholder that the v2 validator flagged across
 * `report`, `dashboard`, and `semantic-model` editors.
 *
 * Token acquisition: this component is a *renderer*. The caller fetches
 * a short-lived embed token from the BFF route
 *   POST /api/items/<type>/<id>/embed-token
 * which itself proxies the Power BI REST
 *   POST /v1.0/myorg/groups/{ws}/<type>s/{id}/GenerateToken
 * using the Console UAMI. If GenerateToken returns 401/403 the caller
 * surfaces the underlying message in a MessageBar — no fake render.
 */

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { MessageBar, MessageBarBody, MessageBarTitle, Spinner, tokens } from '@fluentui/react-components';

// The powerbi-client-react package ships ESM that must run in the
// browser. Loaded lazily to avoid SSR breakage.
const LazyEmbed = dynamic(
  () => import('powerbi-client-react').then(m => m.PowerBIEmbed),
  { ssr: false, loading: () => null },
);

export interface PowerBIEmbedFrameProps {
  /** report | dashboard | tile (full tile) | qna */
  embedType: 'report' | 'dashboard' | 'tile' | 'qna';
  /** The PBI item id (report id, dashboard id, etc.). */
  id: string;
  /** Embed URL returned by /groups/{ws}/<type>s/{id} */
  embedUrl: string;
  /** Token from /groups/{ws}/<type>s/{id}/GenerateToken */
  accessToken: string;
  /** Optional explicit height (default 600). */
  height?: number | string;
  /** Optional report page name to deep-link into. */
  pageName?: string;
  /** Show "Edit" toolbar (reports only — requires edit-tier embed token). */
  edit?: boolean;
}

export function PowerBIEmbedFrame({ embedType, id, embedUrl, accessToken, height = 600, pageName, edit }: PowerBIEmbedFrameProps) {
  const [models, setModels] = useState<any>(null);
  // Load `models` lazily client-side so we can map permissions/tokenType enums.
  useEffect(() => {
    import('powerbi-client').then((m) => setModels(m.models));
  }, []);

  if (!embedUrl || !accessToken) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>
          <MessageBarTitle>Missing embed token</MessageBarTitle>
          The BFF returned no <code>accessToken</code> + <code>embedUrl</code>. Confirm the Console UAMI is registered in the Power BI tenant and added to the source workspace.
        </MessageBarBody>
      </MessageBar>
    );
  }

  if (!models) {
    return <Spinner size="small" label="Loading Power BI SDK…" labelPosition="after" />;
  }

  const config: any = {
    type: embedType,
    id,
    embedUrl,
    accessToken,
    tokenType: models.TokenType.Embed,
    permissions: edit ? models.Permissions.All : models.Permissions.Read,
    viewMode: edit && embedType === 'report' ? models.ViewMode.Edit : models.ViewMode.View,
    pageName,
    settings: {
      panes: {
        filters: { expanded: false, visible: true },
        pageNavigation: { visible: embedType === 'report' },
      },
      bars: { statusBar: { visible: true } },
      background: models.BackgroundType.Transparent,
    },
  };

  return (
    <div
      style={{
        width: '100%',
        height,
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      <LazyEmbed
        embedConfig={config}
        cssClassName="loom-pbi-embed"
      />
    </div>
  );
}

export default PowerBIEmbedFrame;
