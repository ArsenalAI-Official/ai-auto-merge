import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import { mapLimit } from '../utils/async';
import { recordUsage } from '../utils/pricing';
import { complete } from './llm';
import { ConflictedFile, ResolvedFile, RunUsage } from '../types';
import { ClassifiedConflict, Hunk, extractHunks, spliceHunks } from './conflictClassifier';
import {
  HUNK_RESOLVER_SYSTEM,
  VERIFY_SYSTEM,
  JUDGE_SYSTEM,
  STRATEGIES,
  buildHunkBlock,
  buildHunkVerifyPrompt,
  buildHunkJudgePrompt,
} from './prompts';
import { Confidence, extractJson, parseVerifyResponse, parseJudgeResponse, lowerOf } from './aiParse';

/**
 * Hunk-level resolution: resolve each conflict region on its own (with a little
 * surrounding context) and splice the results back into the verbatim file. This
 * is the edit-not-rewrite approach Cursor/Claude Code use — the untouched bulk
 * of a large file is never regenerated, so there is no whole-file output-size
 * ceiling and output tokens drop sharply.
 *
 * The per-hunk pipeline mirrors the whole-file one: a conservative proposal +
 * cheap verifier, escalating to a second (synthesis) strategy + judge only on
 * doubt. Every safety guard is preserved — truncation is rejected, an empty or
 * marker-bearing replacement is rejected, and after splicing we assert no
 * conflict markers remain anywhere in the file. The keep-both preservation
 * guard runs on the spliced result in the caller.
 *
 * Returns null when the file's markers can't be cleanly parsed/spliced — the
 * caller then falls back to whole-file resolution.
 */

/** Hunks within one file are independent — resolve a few at a time. */
const HUNK_CONCURRENCY = 4;

const MARKER_RE = /^(?:<{7}|={7}|>{7}|\|{7})(?=$|\s)/m;

/**
 * Right-size the per-hunk output ceiling to the hunk: a resolution is about the
 * size of the conflict region. Tiny floor for one-liners, modest cap so a single
 * runaway hunk can't blow up — a hunk legitimately bigger than this is vanishingly
 * rare and is caught by the truncation guard if it ever happens.
 */
function maxTokensForHunk(markerText: string): number {
  return Math.min(8_192, Math.max(1_024, Math.ceil(markerText.length / 3) + 1_000));
}

interface HunkProposal {
  content: string;
  confidence: Confidence;
  explanation: string;
  needs_review: boolean;
}

interface HunkResolution {
  content: string;
  confidence: Confidence;
  explanation: string;
  needsReview: boolean;
}

export async function resolveByHunks(
  classified: ClassifiedConflict,
  prContext: string,
  usage?: RunUsage
): Promise<ResolvedFile | null> {
  const { file } = classified;
  const { hunks, safe } = extractHunks(file.content, config.llm.hunkContextLines);
  if (!safe || hunks.length === 0) {
    logger.debug(`${file.path}: hunk extraction not safe — falling back to whole-file resolution`);
    return null;
  }

  const total = hunks.length;
  const resolutions = await mapLimit(hunks, HUNK_CONCURRENCY, (h) =>
    resolveHunk(file, h, total, prContext, usage)
  );

  // A file is only valid with EVERY conflict resolved — if any hunk is doubtful,
  // flag the whole file for review rather than push a partial/forced merge.
  const flagged = resolutions.find((r) => r.needsReview);
  if (flagged) {
    logger.debug(`${file.path}: a hunk needs review (${flagged.explanation}) — flagging file`);
    return reviewFlag(file, `a conflict could not be confidently resolved: ${flagged.explanation}`);
  }

  const resolvedByIndex = new Map<number, string[]>();
  resolutions.forEach((r, i) => resolvedByIndex.set(i, toLines(r.content)));

  let merged: string;
  try {
    merged = spliceHunks(file.content, resolvedByIndex);
  } catch (err) {
    logger.warn(`${file.path}: splice failed — falling back to whole-file:`, err);
    return null;
  }

  // Defense in depth: a resolved hunk should never carry a marker (the proposal
  // parser already rejects that), but assert on the assembled file too.
  if (MARKER_RE.test(merged)) {
    return reviewFlag(file, 'resolution left a conflict marker in the file');
  }

  const confidence = resolutions.reduce<Confidence>((acc, r) => lowerOf(acc, r.confidence), 'high');
  const explanation =
    total === 1
      ? resolutions[0].explanation
      : `Resolved ${total} conflict hunks individually and spliced them into the unchanged file.`;

  return { path: file.path, content: merged, confidence, explanation, needsReview: false, method: 'ai_hunk' };
}

function reviewFlag(file: ConflictedFile, why: string): ResolvedFile {
  return {
    path: file.path,
    content: file.content,
    confidence: 'low',
    explanation: `Hunk-level resolution flagged this file: ${why}`,
    needsReview: true,
    method: 'ai_hunk_review',
  };
}

/** Lines for the splice: drop one trailing newline so we don't inject a blank line. */
function toLines(content: string): string[] {
  return content.replace(/\n$/, '').split('\n');
}

/** Adaptive single-hunk resolution — same shape as the whole-file resolver. */
async function resolveHunk(
  file: ConflictedFile,
  hunk: Hunk,
  total: number,
  prContext: string,
  usage?: RunUsage
): Promise<HunkResolution> {
  const proposalA = await runHunkProposal(file, hunk, total, prContext, STRATEGIES[0], usage);

  if (config.llm.resolutionMode === 'adaptive' && !proposalA.needs_review) {
    const verdict = await verifyHunk(file, hunk, proposalA.content, usage);
    if (verdict.ok && verdict.confidence !== 'low' && proposalA.confidence !== 'low') {
      return {
        content: proposalA.content,
        confidence: lowerOf(proposalA.confidence, verdict.confidence),
        explanation: `${proposalA.explanation} (independently verified: ${verdict.reason})`,
        needsReview: false,
      };
    }
    logger.debug(`${file.path}#${hunk.index}: verification inconclusive — escalating`);
  }

  const proposalB = await runHunkProposal(file, hunk, total, prContext, STRATEGIES[1], usage);
  return reconcileHunk(file, hunk, proposalA, proposalB, usage);
}

function reconcileHunk(
  file: ConflictedFile,
  hunk: Hunk,
  proposalA: HunkProposal,
  proposalB: HunkProposal,
  usage?: RunUsage
): Promise<HunkResolution> | HunkResolution {
  if (proposalA.needs_review && proposalB.needs_review) {
    return { content: '', confidence: 'low', explanation: `both hunk proposals failed: ${proposalA.explanation}`, needsReview: true };
  }

  // Converged on the same non-empty replacement → high confidence, no judge.
  // (A non-flagged proposal always has non-empty content — empty is rejected at
  // parse time — so this can't converge two empty results.)
  if (proposalA.content.trim().length > 0 && proposalA.content.trim() === proposalB.content.trim()) {
    return {
      content: proposalA.content,
      confidence: 'high',
      explanation: `${proposalA.explanation} (confirmed by independent synthesis)`,
      needsReview: false,
    };
  }

  // Diverged (or one failed): an independent judge decides, exactly as in the
  // whole-file path. If it picks a failed/flagged proposal, the winner's
  // needs_review propagates and the file is flagged (never spliced).
  return judgeHunk(file, hunk, proposalA, proposalB, usage);
}

async function judgeHunk(
  file: ConflictedFile,
  hunk: Hunk,
  proposalA: HunkProposal,
  proposalB: HunkProposal,
  usage?: RunUsage
): Promise<HunkResolution> {
  let winner: 'A' | 'B' | 'neither' = 'A';
  let reason = 'judge unavailable, defaulting to conservative';
  let confidence: Confidence = 'medium';
  try {
    const result = await complete({
      system: JUDGE_SYSTEM,
      maxTokens: 1024,
      tier: 'judge',
      blocks: [{ text: buildHunkJudgePrompt(file, hunk.markerText, proposalA.content, proposalB.content) }],
    });
    recordUsage(usage, result.model, result.usage);
    metrics.claudeCalls.inc({ model: result.model, outcome: 'ok' });
    ({ winner, reason, confidence } = parseJudgeResponse(result.text));
  } catch (err) {
    metrics.claudeCalls.inc({ model: config.llm.provider, outcome: 'error' });
    logger.warn(`${file.path}#${hunk.index}: hunk judge failed, defaulting to conservative:`, err);
  }

  if (winner === 'neither') {
    return { content: '', confidence: 'low', explanation: `both hunk proposals rejected by judge: ${reason}`, needsReview: true };
  }
  const chosen = winner === 'A' ? proposalA : proposalB;
  const label = winner === 'A' ? 'conservative' : 'synthesis';
  return {
    content: chosen.content,
    confidence,
    explanation: `${chosen.explanation} (${label} strategy preferred: ${reason})`,
    needsReview: confidence === 'low' || chosen.needs_review,
  };
}

async function runHunkProposal(
  file: ConflictedFile,
  hunk: Hunk,
  total: number,
  prContext: string,
  strategy: (typeof STRATEGIES)[number],
  usage?: RunUsage
): Promise<HunkProposal> {
  try {
    const result = await complete({
      system: HUNK_RESOLVER_SYSTEM,
      maxTokens: maxTokensForHunk(hunk.markerText),
      tier: 'resolve',
      blocks: [
        // PR context is identical across all files & hunks → caches for the whole PR.
        ...(prContext ? [{ text: prContext, cacheable: true }] : []),
        // The hunk block is identical across both strategies → caches per hunk.
        { text: buildHunkBlock(file, hunk, total), cacheable: true },
        // Only the strategy instruction varies per call.
        { text: `${strategy.instruction}\n\nReturn JSON only.` },
      ],
    });
    recordUsage(usage, result.model, result.usage);
    metrics.claudeCalls.inc({ model: result.model, outcome: 'ok' });

    if (result.truncated) {
      throw new Error('hunk resolution hit the output token limit (truncated)');
    }
    return parseHunkResponse(result.text);
  } catch (err) {
    metrics.claudeCalls.inc({ model: config.llm.provider, outcome: 'error' });
    logger.warn(`${file.path}#${hunk.index}: ${strategy.label} hunk proposal failed:`, err);
    return {
      content: '',
      confidence: 'low',
      explanation: `${strategy.label} hunk proposal failed: ${err instanceof Error ? err.message : String(err)}`,
      needs_review: true,
    };
  }
}

async function verifyHunk(
  file: ConflictedFile,
  hunk: Hunk,
  proposedHunk: string,
  usage?: RunUsage
): Promise<{ ok: boolean; confidence: Confidence; reason: string }> {
  try {
    const result = await complete({
      system: VERIFY_SYSTEM,
      maxTokens: 512,
      tier: 'judge',
      blocks: [{ text: buildHunkVerifyPrompt(file, hunk.markerText, proposedHunk) }],
    });
    recordUsage(usage, result.model, result.usage);
    metrics.claudeCalls.inc({ model: result.model, outcome: 'ok' });
    return parseVerifyResponse(result.text);
  } catch (err) {
    metrics.claudeCalls.inc({ model: config.llm.provider, outcome: 'error' });
    logger.warn(`${file.path}#${hunk.index}: hunk verification failed, will escalate:`, err);
    return { ok: false, confidence: 'low', reason: 'verifier unavailable' };
  }
}

/**
 * Parse a hunk proposal. Unlike the whole-file response there is no is_delete
 * (a single hunk can't delete the file), the replacement must be non-empty, and
 * it must contain no conflict markers (a marker here means the model failed).
 */
function parseHunkResponse(text: string): HunkProposal {
  const json = extractJson(text) as {
    resolved_content?: unknown;
    confidence?: unknown;
    explanation?: unknown;
    needs_review?: unknown;
  };
  if (typeof json?.resolved_content !== 'string' || json.resolved_content.trim().length === 0) {
    throw new Error('hunk response missing or empty resolved_content');
  }
  if (MARKER_RE.test(json.resolved_content)) {
    throw new Error('hunk replacement still contains a conflict marker');
  }
  return {
    content: json.resolved_content,
    confidence: ['high', 'medium', 'low'].includes(json.confidence as string)
      ? (json.confidence as Confidence)
      : 'low',
    explanation: typeof json.explanation === 'string' ? json.explanation : '',
    needs_review: json.needs_review === true,
  };
}
