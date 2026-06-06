'use client';

/**
 * Activity type icons — maps each ADF/Synapse/Fabric activity `type` to a
 * representative Fluent icon, so canvas nodes + the palette show the real
 * activity glyph (not just a colour swatch). Kept in a .tsx leaf so the
 * catalog (.ts) stays JSX-free.
 *
 * The ADF Studio activity icons themselves are Studio-internal; until the
 * tools/adf-icon-scraper run swaps in the exact glyphs, these Fluent icons
 * are the closest first-party stand-ins (real icons, semantically matched).
 */

import {
  DocumentArrowRight20Regular, ArrowFlowUpRight20Regular, Flowchart20Regular,
  SearchInfo20Regular, DocumentText20Regular, Delete20Regular, Notebook20Regular,
  Rocket20Regular, Code20Regular, Database20Regular, ArrowRepeatAll20Regular,
  BranchFork20Regular, Branch20Regular, ArrowSync20Regular, Clock20Regular,
  Tag20Regular, AddCircle20Regular, Filter20Regular, Globe20Regular,
  PlugConnected20Regular, ErrorCircle20Regular, CheckmarkCircle20Regular,
  Mail20Regular, Apps20Regular,
  DataUsage20Regular, Flash20Regular, Server20Regular, Stream20Regular,
} from '@fluentui/react-icons';
import type { JSX } from 'react';

// Keyed by ADF activity `type`. Anything unmapped falls back to a generic glyph.
const ICONS: Record<string, JSX.Element> = {
  Copy: <DocumentArrowRight20Regular />,
  RefreshDataflow: <ArrowFlowUpRight20Regular />,
  ExecuteDataFlow: <Flowchart20Regular />,
  Lookup: <SearchInfo20Regular />,
  GetMetadata: <DocumentText20Regular />,
  Delete: <Delete20Regular />,
  DatabricksNotebook: <Notebook20Regular />,
  Notebook: <Notebook20Regular />,
  SparkJob: <Rocket20Regular />,
  SynapseNotebook: <Notebook20Regular />,
  ExecutePipeline: <Flowchart20Regular />,
  Script: <Code20Regular />,
  SqlServerStoredProcedure: <Database20Regular />,
  StoredProcedure: <Database20Regular />,
  ForEach: <ArrowRepeatAll20Regular />,
  IfCondition: <BranchFork20Regular />,
  Switch: <Branch20Regular />,
  Until: <ArrowSync20Regular />,
  Wait: <Clock20Regular />,
  SetVariable: <Tag20Regular />,
  AppendVariable: <AddCircle20Regular />,
  Filter: <Filter20Regular />,
  WebActivity: <Globe20Regular />,
  Web: <Globe20Regular />,
  WebHook: <PlugConnected20Regular />,
  Fail: <ErrorCircle20Regular />,
  Validation: <CheckmarkCircle20Regular />,
  Office365Outlook: <Mail20Regular />,
  HDInsightHive: <DataUsage20Regular />,
  HDInsightSpark: <Flash20Regular />,
  HDInsightMapReduce: <Server20Regular />,
  HDInsightStreaming: <Stream20Regular />,
};

/** Return the Fluent icon element for an activity type (generic fallback). */
export function activityIcon(type?: string): JSX.Element {
  return (type && ICONS[type]) || <Apps20Regular />;
}
