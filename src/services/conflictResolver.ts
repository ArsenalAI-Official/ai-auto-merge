import Anthropic from '@anthropic-ai/sdk';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import { mapLimit } from '../utils/async';
import { recordUsage, ApiUsageLike } from '../utils/pricing';
import { ConflictedFile, ResolvedFile, RunUsage } from '../types';
import {
  classify,
  ConflictType,
  ClassifiedConflict,
  resolveAdditive,
  resolveImports,
  lockfileHint,
} from './conflictClassifier';
import {
  RESOLVER_SYSTEM,
  JUDGE_SYSTEM,
  REPAIR_SYSTEM,
  STRATEGIES,
  ResolutionContext,
  buildSharedContext,
  buildJudgePrompt,
  buildRepairPrompt,
} from './prompts';

export { ResolutionContext } from './prompts';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

/** How many files are resolved concurrently per PR (each file = 2-4 API calls). */
const FILE_CONCURRENCY = 3;

// Adaptive thinking is only valid on Opus 4.6+, Sonnet 4.6+ and Fable models —
// sending it to older/smaller models returns a 400.
function thinkingParam(model: string): Record<string, unknown> {
  return /opus-4-[6-9]|sonnet-4-[6-9]|fable/.test(model)
    ? { thinking: { type: 'adaptive' } as never }
    : {};
}

function usageOf(message: unknown): ApiUsageLike | undefined {
  return (message as { usage?: ApiUsageLike }).usage;
}

// ─── Public entry point ────────────────────────────────────────────────────────

export async function resolveConflicts(
  conflictedFiles: ConflictedFile[],
  prTitle: string,
  prBody: string | null,
  prBranch: string,
  baseBranch: string,
  prDiff?: string,
  usage?: RunUsage
): Promise<ResolvedFile[]> {
  const context: ResolutionContext = { prTitle, prBody, prBranch, baseBranch, prDiff };
  return mapLimit(conflictedFiles, FILE_CONCURRENCY, (file) => resolveFile(file, context, usage));
}

async function resolveFile(
  file: ConflictedFile,
  context: ResolutionContext,
  usage?: RunUsage
): Promise<ResolvedFile> {
  const classified = classify(file);
  logger.info(`${file.path}: conflict type = ${classified.type}`);

  switch (classified.type) {
    case 'lockfile':
      return {
        path: file.path,
        content: file.content,
        confidence: 'low',
        explanation: `Generated lockfile — never AI-merged. ${lockfileHint(file.path)}`,
        needsReview: true,
        method: 'lockfile',
      };

    case 'additive':
      return fastResolve(classified, 'additive', resolveAdditive(classified),
        'Additive conflict: both branches added non-overlapping code — merged both.');

    case 'import_only':
      return fastResolve(classified, 'import_only', resolveImports(classified),
        'Import-only conflict: merged and deduplicated import statements.');

    case 'delete_modify':
    case 'complex_modify': {
      const bytes = Buffer.byteLength(file.content, 'utf-8');
      if (bytes > config.settings.maxFileBytes) {
        const kb = Math.round(bytes / 1024);
        const capKb = Math.round(config.settings.maxFileBytes / 1024);
        return {
          path: file.path,
          content: file.content,
          confidence: 'low',
          explanation: `File too large for AI resolution (${kb} KB > ${capKb} KB cap, MAX_FILE_BYTES). Resolve manually.`,
          needsReview: true,
          method: 'oversize',
        };
      }
      return resolveWithJudge(classified, context, usage);
    }
  }
}

function fastResolve(
  classified: ClassifiedConflict,
  type: ConflictType,
  content: string,
  explanation: string
): ResolvedFile {
  logger.debug(`${classified.file.path}: fast-path resolved (${type})`);
  return {
    path: classified.file.path,
    content,
    confidence: 'high',
    explanation,
    needsReview: false,
    method: type === 'additive' ? 'fast_additive' : 'fast_imports',
  };
}

// ─── Multi-proposal pipeline ───────────────────────────────────────────────────

interface Proposal {
  id: 'A' | 'B';
  content: string;
  confidence: 'high' | 'medium' | 'low';
  explanation: string;
  needs_review: boolean;
  is_delete: boolean;
}

async function resolveWithJudge(
  classified: ClassifiedConflict,
  context: ResolutionContext,
  usage?: RunUsage
): Promise<ResolvedFile> {
  const file = classified.file;

  // Sequential on purpose: both proposals share a long prompt prefix (system +
  // PR context + diff + file). Running A first writes the prompt cache; B then
  // reads it at ~10% of the input price. Parallel requests can't share an
  // in-flight cache write.
  const proposalA = await runProposal(classified, context, STRATEGIES[0], usage);
  const proposalB = await runProposal(classified, context, STRATEGIES[1], usage);

  // Both proposals failed — don't mistake convergence on the original content for success
  if (proposalA.needs_review && proposalB.needs_review) {
    return {
      path: file.path,
      content: file.content,
      confidence: 'low',
      explanation: `Both resolution proposals failed: ${proposalA.explanation}`,
      needsReview: true,
      method: 'ai_failed',
    };
  }

  // If proposals converge on the same content, we're confident — no judge needed
  if (proposalA.content.trim() === proposalB.content.trim()) {
    logger.debug(`${file.path}: proposals converged — high confidence`);
    return {
      path: file.path,
      content: proposalA.content,
      confidence: 'high',
      explanation: `${proposalA.explanation} (confirmed by independent synthesis)`,
      needsReview: false,
      isDelete: proposalA.is_delete,
      method: 'ai_converged',
    };
  }

  // Proposals diverge — run judge
  logger.debug(`${file.path}: proposals diverged — running judge`);
  const judgment = await judgeProposals(file, proposalA, proposalB, context, usage);

  if (judgment.winner === 'neither') {
    return {
      path: file.path,
      content: file.content,
      confidence: 'low',
      explanation: `Both proposals rejected by judge: ${judgment.reason}`,
      needsReview: true,
      method: 'ai_failed',
    };
  }

  const winner = judgment.winner === 'A' ? proposalA : proposalB;
  const winnerLabel = judgment.winner === 'A' ? 'conservative' : 'synthesis';
  const loserLabel = judgment.winner === 'A' ? 'synthesis' : 'conservative';

  return {
    path: file.path,
    content: winner.content,
    confidence: judgment.confidence,
    explanation: `${winner.explanation} (${winnerLabel} strategy preferred over ${loserLabel}: ${judgment.reason})`,
    needsReview: judgment.confidence === 'low' || winner.needs_review,
    isDelete: winner.is_delete,
    method: 'ai_judged',
  };
}

async function runProposal(
  classified: ClassifiedConflict,
  context: ResolutionContext,
  strategy: (typeof STRATEGIES)[number],
  usage?: RunUsage
): Promise<Proposal> {
  const { file } = classified;
  const model = config.anthropic.model;

  try {
    const stream = client.messages.stream({
      model,
      max_tokens: 64_000,
      ...thinkingParam(model),
      system: RESOLVER_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            // Shared across both strategies → single cache breakpoint covers
            // system prompt + this block. The strategy suffix varies per call.
            {
              type: 'text',
              text: buildSharedContext(file, context),
              cache_control: { type: 'ephemeral' },
            },
            { type: 'text', text: `${strategy.instruction}\n\nReturn JSON only.` },
          ],
        },
      ],
    });

    const message = await stream.finalMessage();
    recordUsage(usage, model, usageOf(message));
    metrics.claudeCalls.inc({ model, outcome: 'ok' });

    const text = message.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') throw new Error('No text response');

    const parsed = parseResolverResponse(text.text);
    return {
      id: strategy.id,
      content: parsed.resolved_content,
      is_delete: parsed.is_delete ?? false,
      confidence: parsed.confidence,
      explanation: parsed.explanation,
      needs_review: parsed.needs_review,
    };
  } catch (err) {
    metrics.claudeCalls.inc({ model, outcome: 'error' });
    logger.warn(`${file.path}: ${strategy.label} proposal failed:`, err);
    return {
      id: strategy.id,
      content: file.content,
      confidence: 'low',
      explanation: `${strategy.label} proposal failed: ${err instanceof Error ? err.message : String(err)}`,
      needs_review: true,
      is_delete: false,
    };
  }
}

async function judgeProposals(
  file: ConflictedFile,
  proposalA: Proposal,
  proposalB: Proposal,
  context: ResolutionContext,
  usage?: RunUsage
): Promise<{ winner: 'A' | 'B' | 'neither'; reason: string; confidence: 'high' | 'medium' | 'low' }> {
  const model = config.anthropic.judgeModel;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: JUDGE_SYSTEM,
      messages: [
        { role: 'user', content: buildJudgePrompt(file, context.prTitle, proposalA.content, proposalB.content) },
      ],
    });
    recordUsage(usage, model, usageOf(response));
    metrics.claudeCalls.inc({ model, outcome: 'ok' });

    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') throw new Error('No judge response');

    const parsed = parseJudgeResponse(text.text);
    logger.debug(`${file.path}: judge picked ${parsed.winner} (${parsed.confidence}) — ${parsed.reason}`);
    return parsed;
  } catch (err) {
    metrics.claudeCalls.inc({ model, outcome: 'error' });
    logger.warn(`${file.path}: judge failed, defaulting to conservative:`, err);
    return { winner: 'A', reason: 'Judge unavailable, defaulting to conservative', confidence: 'medium' };
  }
}

// ─── Syntax repair ─────────────────────────────────────────────────────────────

/**
 * One-shot repair when a resolved file fails the syntax check: feed the error
 * back to Claude and ask for a minimal fix. Returns ok=false if the repair
 * call itself fails — the caller decides whether to downgrade the file.
 */
export async function repairResolution(
  filePath: string,
  brokenContent: string,
  syntaxError: string,
  usage?: RunUsage
): Promise<{ ok: boolean; content: string }> {
  const model = config.anthropic.model;
  try {
    const stream = client.messages.stream({
      model,
      max_tokens: 64_000,
      ...thinkingParam(model),
      system: REPAIR_SYSTEM,
      messages: [{ role: 'user', content: buildRepairPrompt(filePath, brokenContent, syntaxError) }],
    });

    const message = await stream.finalMessage();
    recordUsage(usage, model, usageOf(message));
    metrics.claudeCalls.inc({ model, outcome: 'ok' });

    const text = message.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') throw new Error('No text response');

    const json = extractJson(text.text) as { resolved_content?: unknown };
    if (typeof json?.resolved_content !== 'string' || json.resolved_content.length === 0) {
      throw new Error('Repair response missing resolved_content');
    }
    return { ok: true, content: json.resolved_content };
  } catch (err) {
    metrics.claudeCalls.inc({ model, outcome: 'error' });
    logger.warn(`${filePath}: syntax repair failed:`, err);
    return { ok: false, content: brokenContent };
  }
}

// ─── Response parsers ──────────────────────────────────────────────────────────

interface RawResolverResponse {
  resolved_content: string;
  is_delete: boolean;
  confidence: 'high' | 'medium' | 'low';
  explanation: string;
  needs_review: boolean;
}

function parseResolverResponse(text: string): RawResolverResponse {
  const json = extractJson(text);
  if (!isValidResolverResponse(json)) {
    throw new Error('Claude response missing required fields');
  }
  return json;
}

function isValidResolverResponse(obj: unknown): obj is RawResolverResponse {
  if (typeof obj !== 'object' || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    typeof r.resolved_content === 'string' &&
    (r.confidence === 'high' || r.confidence === 'medium' || r.confidence === 'low') &&
    typeof r.explanation === 'string' &&
    typeof r.needs_review === 'boolean'
  );
}

function parseJudgeResponse(text: string): { winner: 'A' | 'B' | 'neither'; reason: string; confidence: 'high' | 'medium' | 'low' } {
  const json = extractJson(text) as { winner?: string; reason?: string; confidence?: string };
  if (!json || !['A', 'B', 'neither'].includes(json.winner ?? '')) {
    return { winner: 'A', reason: 'Could not parse judge response', confidence: 'medium' };
  }
  return {
    winner: json.winner as 'A' | 'B' | 'neither',
    reason: json.reason ?? '',
    confidence: ['high', 'medium', 'low'].includes(json.confidence ?? '')
      ? (json.confidence as 'high' | 'medium' | 'low')
      : 'medium',
  };
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const raw = text.match(/(\{[\s\S]*\})/);
  const jsonStr = fenced?.[1] ?? raw?.[1];
  if (!jsonStr) throw new Error('No JSON found in response');
  return JSON.parse(jsonStr);
}
