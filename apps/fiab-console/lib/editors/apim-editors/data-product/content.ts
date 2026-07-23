// data-product/content.ts — pure projection helpers for DataProductEditor,
// extracted verbatim from data-product-editor.tsx (WS-E1 / R8 decomposition,
// pure move — no behavior change). No React, no JSX — unit-testable.
import type { OwnerRef } from '@/lib/dataproducts/owner-picker';
import type { DataProductState } from './types';

/**
 * Project a bundle-installed data product's `state.content` (DataProductContent
 * — datasets/glossaryTerms/owner/endorsement per content-bundles/types.ts) into
 * the editor's DataProductState so an app-installed data product opens FULLY
 * BUILT-OUT (its datasets, glossary terms, owner, endorsement) instead of an
 * empty form. The editor's existing direct state fields win when present
 * (e.g. after the user has edited + saved); content only fills gaps. This
 * keeps Register-with-Purview / dataset registration hitting the real backend.
 */
export function projectDataProductContent(state: Record<string, unknown>): Partial<DataProductState> {
  const out: Partial<DataProductState> = { ...(state as Partial<DataProductState>) };
  const content = (state?.content as any);
  if (!content || content.kind !== 'data-product') return out;

  // Datasets: content { id, name, description, classification } → editor
  // DataProductDataset { name, typeName, qualifiedName, classifications[] }.
  if ((!out.datasets || out.datasets.length === 0) && Array.isArray(content.datasets)) {
    out.datasets = content.datasets.map((d: any) => ({
      name: d.name,
      typeName: 'fabric_data_product',
      qualifiedName: d.id || d.name,
      classifications: d.classification ? [String(d.classification)] : [],
    }));
  }
  // Glossary terms: content { term, definition } → editor { name }.
  if ((!out.glossaryLinks || out.glossaryLinks.length === 0) && Array.isArray(content.glossaryTerms)) {
    out.glossaryLinks = content.glossaryTerms.map((t: any) => ({ name: t.term }));
  }
  // Owner: content { name, email? } → editor owner string.
  if (!out.owner && content.owner) {
    out.owner = content.owner.email
      ? `${content.owner.name} <${content.owner.email}>`
      : (content.owner.name || '');
  }
  // Endorsement → certified flag (editor's only endorsement surface).
  if (out.certified === undefined && content.endorsement) {
    out.certified = content.endorsement === 'certified';
  }
  // DP-17: bind the people-picker off the rich owners[] when present; otherwise
  // seed it from the singular legacy owner string so the picker shows it.
  if ((!out.owners || out.owners.length === 0)) {
    const rich = Array.isArray((state as any).owners) ? (state as any).owners as any[] : [];
    if (rich.length) {
      out.owners = rich.map((o) => typeof o === 'string'
        ? { id: o, upn: o, displayName: o }
        : { id: o.id || o.upn || o.displayName || '', upn: o.upn || '', displayName: o.displayName || o.upn || o.id || '' });
    } else if (out.owner) {
      out.owners = [parseOwnerString(out.owner)];
    }
  }
  return out;
}

/** Parse a legacy "Name <email>" (or bare email/name) owner string into a rich
 *  owner record so it renders as a people-picker chip. */
export function parseOwnerString(s: string): OwnerRef {
  const m = s.match(/^\s*(.+?)\s*<([^>]+)>\s*$/);
  if (m) return { id: m[2], upn: m[2], displayName: m[1] };
  return { id: s, upn: s, displayName: s };
}
