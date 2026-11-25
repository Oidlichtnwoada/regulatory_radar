import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { errorMessage, mapLimit } from '../common/fp.js';
import type { PrismaService } from '../db/prisma.service.js';
import type { GroupMember } from '../domain/grouping.js';
import type { ChatProvider } from '../llm/providers.js';
import { warnFailures } from './failures.js';
import { pendingFor } from './repository.js';

/** Logger of the stage. */
const log = new Logger('Translation');

/** English title, required in every translation. */
const titleEn = z.string().min(1).describe('Faithful English translation of the title');

/** Structured output for an item with a summary: the summary must be translated too. */
const WithSummary = z.object({
  titleEn,
  summaryEn: z.string().min(1).describe('Faithful English translation of the summary'),
});

/** Structured output for an item without a summary: the title only (models omit a field that must be null). */
const TitleOnly = z.object({ titleEn });

/** Prompt of the translator; legal terms are translated faithfully, nothing is added. */
const prompt = (m: GroupMember): string =>
  [
    'Translate this regulatory item into English. Translate faithfully; keep legal references, numbers and',
    'names of acts; do not summarise or add anything. Return JSON only.',
    `Language: ${m.language}`,
    `Title: ${m.title}`,
    `Summary: ${m.summary ?? '(none)'}`,
  ].join('\n');

/**
 * Stage 2: English translation. English items get an identity row, offline (no chat provider) gives
 * a skipped row with empty texts. Source texts stay on the finding. A translation that misses the summary
 * counts as failed (and is retried). Returns the number of finished (non-failed) rows written.
 */
export const runTranslationStage = async (
  db: PrismaService,
  chat: ChatProvider | null,
  opts: {
    readonly engine: string;
    readonly batchSize: number;
    readonly concurrency: number;
    readonly retryAfterSeconds: number;
  },
): Promise<number> => {
  const pending = await pendingFor(db, 'translation', opts.engine, {
    limit: opts.batchSize,
    retryAfterSeconds: opts.retryAfterSeconds,
  });
  const translators = chat && {
    withSummary: chat.chat.withStructuredOutput(WithSummary, { name: 'translation' }),
    titleOnly: chat.chat.withStructuredOutput(TitleOnly, { name: 'translation' }),
  };
  const rows = await mapLimit(pending, opts.concurrency, async (m) => {
    const base = { findingId: m.id, engine: opts.engine, sourceLanguage: m.language };
    if (m.language === 'en')
      return { ...base, status: 'identity' as const, titleEn: m.title, summaryEn: m.summary };
    if (!translators) return { ...base, status: 'skipped' as const, titleEn: null, summaryEn: null };
    try {
      const out = m.summary
        ? await translators.withSummary.invoke(prompt(m))
        : { ...(await translators.titleOnly.invoke(prompt(m))), summaryEn: null };
      return { ...base, status: 'translated' as const, titleEn: out.titleEn, summaryEn: out.summaryEn };
    } catch (e) {
      return {
        ...base,
        status: 'failed' as const,
        titleEn: null,
        summaryEn: null,
        error: errorMessage(e).slice(0, 1000),
      };
    }
  });
  warnFailures(
    log,
    'translations',
    rows.length,
    rows.flatMap((r) => ('error' in r && r.error ? [r.error] : [])),
    'retried later',
  );
  // skipDuplicates: another worker may have stored the same result meanwhile (partial unique index).
  await db.translation.createMany({ data: [...rows], skipDuplicates: true });
  return rows.filter((r) => r.status !== 'failed').length;
};
