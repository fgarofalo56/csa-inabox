/**
 * Azure AI Vision (Image Analysis 4.0) data-plane client.
 *
 * Real `imageanalysis:analyze` REST — synchronous 200. Analyze a public/SAS
 * image URL (or raw bytes) for any combination of visual features (caption,
 * dense captions, OCR read, tags, objects, people, smart crops) and return a
 * normalised result. Entra-auth only, sovereign-cloud aware.
 *
 * Powers the `VisionAnalyzeImage` AI-enrichment pipeline activity + preview
 * route. Unset endpoint → honest CognitiveNotConfiguredError naming
 * LOOM_VISION_ENDPOINT (no-vaporware.md).
 *
 * Ref: https://learn.microsoft.com/azure/ai-services/computer-vision/how-to/call-analyze-image-40
 */

import {
  cognitiveToken,
  resolveCognitiveEndpoint,
  readCognitiveJson,
  fetchWithTimeout,
  CognitiveError,
} from './cognitive-common';

const VISION_API = process.env.LOOM_VISION_API_VERSION || '2024-02-01';
const SERVICE = 'Azure AI Vision';

/** UI-facing feature ids (the typed multiselect in the activity form). */
export const VISION_FEATURES = [
  'caption',
  'denseCaptions',
  'read',
  'tags',
  'objects',
  'people',
  'smartCrops',
] as const;
export type VisionFeature = (typeof VISION_FEATURES)[number];

/** Map UI feature ids → Image Analysis 4.0 REST `features` query values. */
const FEATURE_MAP: Record<VisionFeature, string> = {
  caption: 'Caption',
  denseCaptions: 'DenseCaptions',
  read: 'Read',
  tags: 'Tags',
  objects: 'Objects',
  people: 'People',
  smartCrops: 'SmartCrops',
};

export interface VisionResult {
  /** Single best caption (when the caption feature is requested). */
  caption?: { text: string; confidence?: number };
  denseCaptions?: Array<{ text: string; confidence?: number }>;
  /** Concatenated OCR text (Read feature). */
  readText?: string;
  tags?: Array<{ name: string; confidence?: number }>;
  objects?: Array<{ name: string; confidence?: number }>;
  peopleCount?: number;
  raw: unknown;
}

export interface AnalyzeImageInput {
  url?: string;
  /** Base64-encoded image bytes (alternative to url). */
  base64?: string;
  features?: VisionFeature[];
  /** BCP-47 language for caption/tags (default en). */
  language?: string;
}

function endpoint(): string {
  return resolveCognitiveEndpoint(
    'LOOM_VISION_ENDPOINT',
    SERVICE,
    'https://<name>.cognitiveservices.azure.com',
  );
}

/** Build the ordered, de-duped REST `features` query value from UI ids. */
export function visionFeatureQuery(features?: VisionFeature[]): string {
  const wanted = (features && features.length ? features : (['caption', 'read'] as VisionFeature[]));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of wanted) {
    const mapped = FEATURE_MAP[f];
    if (mapped && !seen.has(mapped)) { seen.add(mapped); out.push(mapped); }
  }
  return out.join(',');
}

function readLineText(readResult: any): string {
  const blocks: any[] = Array.isArray(readResult?.blocks) ? readResult.blocks : [];
  const lines: string[] = [];
  for (const b of blocks) {
    for (const ln of b?.lines || []) {
      if (typeof ln?.text === 'string') lines.push(ln.text);
    }
  }
  return lines.join('\n');
}

function shape(raw: any): VisionResult {
  const out: VisionResult = { raw };
  if (raw?.captionResult) {
    out.caption = { text: raw.captionResult.text, confidence: raw.captionResult.confidence };
  }
  if (Array.isArray(raw?.denseCaptionsResult?.values)) {
    out.denseCaptions = raw.denseCaptionsResult.values.map((v: any) => ({ text: v?.text, confidence: v?.confidence }));
  }
  if (raw?.readResult) out.readText = readLineText(raw.readResult);
  if (Array.isArray(raw?.tagsResult?.values)) {
    out.tags = raw.tagsResult.values.map((t: any) => ({ name: t?.name, confidence: t?.confidence }));
  }
  if (Array.isArray(raw?.objectsResult?.values)) {
    out.objects = raw.objectsResult.values.map((o: any) => ({
      name: o?.tags?.[0]?.name ?? o?.name,
      confidence: o?.tags?.[0]?.confidence ?? o?.confidence,
    }));
  }
  if (Array.isArray(raw?.peopleResult?.values)) out.peopleCount = raw.peopleResult.values.length;
  return out;
}

/** Analyze an image (URL or base64 bytes) for the requested visual features. */
export async function analyzeImage(input: AnalyzeImageInput): Promise<VisionResult> {
  if (!input.url && !input.base64) {
    throw new CognitiveError(400, null, `${SERVICE}: provide an image url or base64 bytes.`);
  }
  const ep = endpoint();
  const tok = await cognitiveToken();
  const features = visionFeatureQuery(input.features);
  const lang = (input.language || 'en').trim();
  const url = `${ep}/computervision/imageanalysis:analyze?api-version=${VISION_API}&features=${encodeURIComponent(features)}&language=${encodeURIComponent(lang)}`;

  const res = input.url
    ? await fetchWithTimeout(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url: input.url }),
      })
    : await fetchWithTimeout(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/octet-stream' },
        body: Buffer.from(input.base64 as string, 'base64'),
      });
  const raw = await readCognitiveJson<any>(res, SERVICE);
  return shape(raw);
}
