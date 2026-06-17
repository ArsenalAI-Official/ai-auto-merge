/**
 * Shared, side-effect-free parsing of the model's JSON responses, plus small
 * helpers used by BOTH resolution paths (whole-file in conflictResolver.ts and
 * hunk-level in hunkResolver.ts). Kept in its own module so both can import it
 * without a circular dependency, and so the parsing rules can never drift
 * between the two paths.
 */

export type Confidence = 'high' | 'medium' | 'low';

/** Returns the lower (more cautious) of two confidence levels. */
export function lowerOf(a: Confidence, b: Confidence): Confidence {
  const rank = { high: 3, medium: 2, low: 1 };
  return rank[a] <= rank[b] ? a : b;
}

export interface RawResolverResponse {
  resolved_content: string;
  is_delete: boolean;
  confidence: Confidence;
  explanation: string;
  needs_review: boolean;
}

export function parseResolverResponse(text: string): RawResolverResponse {
  const json = extractJson(text);
  if (!isValidResolverResponse(json)) {
    throw new Error('Claude response missing required fields');
  }
  return json;
}

export function isValidResolverResponse(obj: unknown): obj is RawResolverResponse {
  if (typeof obj !== 'object' || obj === null) return false;
  const r = obj as Record<string, unknown>;
  // Empty resolved_content is only valid for a deletion — otherwise applying it
  // would blank the file. Reject empty/whitespace content for non-deletes.
  const contentOk =
    typeof r.resolved_content === 'string' && (r.is_delete === true || r.resolved_content.trim().length > 0);
  return (
    contentOk &&
    (r.confidence === 'high' || r.confidence === 'medium' || r.confidence === 'low') &&
    typeof r.explanation === 'string' &&
    typeof r.needs_review === 'boolean'
  );
}

export function parseVerifyResponse(text: string): { ok: boolean; confidence: Confidence; reason: string } {
  // Default to ok=false (escalate) on anything unparseable — never approve by accident.
  let json: { ok?: unknown; confidence?: unknown; reason?: unknown };
  try {
    json = extractJson(text) as typeof json;
  } catch {
    return { ok: false, confidence: 'low', reason: 'could not parse verifier response' };
  }
  return {
    ok: json.ok === true,
    confidence: ['high', 'medium', 'low'].includes(json.confidence as string)
      ? (json.confidence as Confidence)
      : 'low',
    reason: typeof json.reason === 'string' ? json.reason : '',
  };
}

export function parseJudgeResponse(text: string): { winner: 'A' | 'B' | 'neither'; reason: string; confidence: Confidence } {
  const json = extractJson(text) as { winner?: string; reason?: string; confidence?: string };
  if (!json || !['A', 'B', 'neither'].includes(json.winner ?? '')) {
    return { winner: 'A', reason: 'Could not parse judge response', confidence: 'medium' };
  }
  return {
    winner: json.winner as 'A' | 'B' | 'neither',
    reason: json.reason ?? '',
    confidence: ['high', 'medium', 'low'].includes(json.confidence ?? '')
      ? (json.confidence as Confidence)
      : 'medium',
  };
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const raw = text.match(/(\{[\s\S]*\})/);
  const jsonStr = fenced?.[1] ?? raw?.[1];
  if (!jsonStr) throw new Error('No JSON found in response');
  return JSON.parse(jsonStr);
}
