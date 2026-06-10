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
  /**
   * Which embed shape to render. `'standard'` (default) uses
   * IEmbedConfiguration with panes / view mode / page navigation. `'paginated'`
   * uses IPaginatedReportLoadConfiguration — the same powerbi-client SDK but a
   * different config object: no panes, no page navigation, no view mode (these
   * are not supported for paginated reports), plus the parameter-panel command.
   * The `loaded`/`rendered` events are intentionally NOT wired for paginated
   * reports because Microsoft documents they do not fire.
   */
  embedVariant?: 'standard' | 'paginated';
  /**
   * Paginated-report parameter values (`rp:` parameters) seeded into the embed
   * via IPaginatedReportLoadConfiguration.parameterValues. Structured —
   * NOT a raw JSON blob — per the no-freeform-config rule.
   */
  parameterValues?: Array<{ name: string; value: string }>;
  /**
   * Receives the live powerbi-client embed instance once the visual is loaded.
   * The caller uses it to drive the report JS API for parity with the Power BI
   * service viewer toolbar: `report.bookmarksManager`, `report.setPage(name)`,
   * `report.reload()` (refresh visuals), `report.switchMode(...)`.
   */
  onEmbedded?: (embed: any) => void;
  /**
   * Optional Power BI theme JSON applied at embed load time (parity with the
   * Power BI service "View → Themes" picker). Runtime changes go through
   * `report.applyTheme({ themeJson })` on the embed handle; this prop seeds the
   * initial render so the report opens already themed.
   */
  theme?: object;
  /**
   * Optional pane-visibility overrides merged into the embed settings. Lets the
   * caller surface the native Power BI bookmarks / selection (Selection) panes
   * inside the iframe for one-for-one parity with the service viewer.
   */
  paneOverrides?: {
    bookmarks?: { visible?: boolean; expanded?: boolean };
    selection?: { visible?: boolean; expanded?: boolean };
    visualizations?: { visible?: boolean; expanded?: boolean };
    fields?: { visible?: boolean; expanded?: boolean };
  };
}

export function PowerBIEmbedFrame({ embedType, id, embedUrl, accessToken, height = 600, pageName, edit, embedVariant = 'standard', parameterValues, onEmbedded, theme, paneOverrides }: PowerBIEmbedFrameProps) {
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
    return (
      <div
        style={{
          width: '100%',
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: `1px solid ${tokens.colorNeutralStroke2}`,
          borderRadius: tokens.borderRadiusMedium,
          backgroundColor: tokens.colorNeutralBackground2,
        }}
      >
        <Spinner size="medium" label="Loading Power BI SDK…" labelPosition="below" />
      </div>
    );
  }

  // Paginated reports (RDL) load through IPaginatedReportLoadConfiguration.
  // It is a DISTINCT config shape from the standard report IEmbedConfiguration:
  //   - type is still 'report' but there is NO viewMode / permissions / panes /
  //     pageName (page navigation, view-mode toggle, filter pane are not
  //     applicable to paginated reports).
  //   - the parameter bar is controlled via settings.commands.parameterPanel.
  //   - report parameter values seed via config.parameterValues.
  // The `loaded`/`rendered` events are intentionally not wired (Microsoft
  // documents they do not fire for paginated reports). The `error` event still
  // fires and is surfaced through the embed handle by the caller.
  const config: any = embedVariant === 'paginated'
    ? {
        type: 'report',
        id,
        embedUrl,
        accessToken,
        tokenType: models.TokenType.Embed,
        settings: {
          commands: {
            parameterPanel: { enabled: true, expanded: false },
          },
        },
        ...(parameterValues && parameterValues.length ? { parameterValues } : {}),
      }
    : {
        type: embedType,
        id,
        embedUrl,
        accessToken,
        tokenType: models.TokenType.Embed,
        permissions: edit ? models.Permissions.All : models.Permissions.Read,
        viewMode: edit && embedType === 'report' ? models.ViewMode.Edit : models.ViewMode.View,
        pageName,
        ...(theme ? { theme: { themeJson: theme } } : {}),
        settings: {
          panes: {
            filters: { expanded: false, visible: true },
            pageNavigation: { visible: embedType === 'report' },
            ...(paneOverrides?.bookmarks ? { bookmarks: paneOverrides.bookmarks } : {}),
            ...(paneOverrides?.selection ? { selection: paneOverrides.selection } : {}),
            ...(paneOverrides?.visualizations ? { visualizations: paneOverrides.visualizations } : {}),
            ...(paneOverrides?.fields ? { fields: paneOverrides.fields } : {}),
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
        borderRadius: tokens.borderRadiusMedium,
        overflow: 'hidden',
        backgroundColor: tokens.colorNeutralBackground1,
      }}
    >
      <LazyEmbed
        embedConfig={config}
        cssClassName="loom-pbi-embed"
        getEmbeddedComponent={(embedObject: any) => { if (onEmbedded) onEmbedded(embedObject); }}
      />
    </div>
  );
}

export default PowerBIEmbedFrame;
