import { Inject, Injectable, Logger } from '@nestjs/common';
import { errorMessage, sleep } from '../common/fp.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../db/prisma.service.js';
import type { NaceTaxonomy } from '../domain/nace.js';
import { type AiProviders, engines } from '../llm/providers.js';
import { AI, ENV, TAXONOMY } from '../tokens.js';
import { runClassificationStage } from './classification.stage.js';
import { runEmbeddingStage } from './embedding.stage.js';
import { runGroupingStage } from './grouping.stage.js';
import { runNaceEmbeddingStage } from './nace-embedding.stage.js';
import { runTranslationStage } from './translation.stage.js';

/** Rows written per stage in one cycle; failed attempts are not counted (they are retried later). */
export type CycleStats = Readonly<
  Record<'translation' | 'embedding' | 'grouping' | 'classification', number>
>;

/**
 * Orchestrates stages 2-4 continuously: translate -> embed -> group -> classify -> refresh read models.
 * Each stage reads its pending work from Postgres, so the worker is stateless and restart-safe.
 */
@Injectable()
export class PipelineService {
  /** Logger. */
  private readonly log = new Logger('Pipeline');

  /** Injects configuration, database, taxonomy and providers. */
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: PrismaService,
    @Inject(TAXONOMY) private readonly tax: NaceTaxonomy,
    @Inject(AI) private readonly ai: AiProviders,
  ) {}

  /**
   * Runs cycles until aborted; a busy cycle is followed immediately by the next one. Stages count only
   * successful work, so failures (e.g. a provider outage) do not make a cycle busy.
   */
  async runForever(signal: AbortSignal): Promise<void> {
    this.log.log(`engines: ${JSON.stringify(engines(this.ai))}`);
    while (!signal.aborted) {
      const stats = await this.runCycle().catch((e: unknown) => {
        this.log.error(`cycle failed: ${errorMessage(e)}`);
        return null;
      });
      const busy = stats && Object.values(stats).some((n) => n > 0);
      if (!busy) await sleep(this.env.PIPELINE_INTERVAL_SECONDS * 1000, signal);
    }
  }

  /** Runs until a cycle writes nothing (used by tests and the eval command). */
  async runUntilIdle(maxCycles = 500): Promise<void> {
    for (let i = 0; i < maxCycles; i++) {
      const stats = await this.runCycle();
      if (Object.values(stats).every((n) => n === 0)) return;
    }
  }

  /** One cycle over all stages; logs and stores what each stage did. */
  async runCycle(): Promise<CycleStats> {
    const startedAt = new Date();
    const e = engines(this.ai);
    const {
      PIPELINE_BATCH_SIZE: batchSize,
      LLM_CONCURRENCY: concurrency,
      AGENT_MAX_STEPS: maxSteps,
    } = this.env;
    const retryAfterSeconds = this.env.PIPELINE_RETRY_SECONDS;
    const agent = {
      retryAfterSeconds,
      embeddingEngine: e.embedding,
      embeddingDimensions: this.ai.embedding?.dimensions ?? 0,
      maxSteps,
      batchSize,
      concurrency,
      internet: this.env.AGENT_INTERNET_ACCESS,
      queryEmbeddings: this.ai.embedding?.embeddings ?? null,
    };
    const translation = await runTranslationStage(this.db, this.ai.chat, {
      engine: e.translation,
      batchSize,
      concurrency,
      retryAfterSeconds,
    });
    const embedding = await runEmbeddingStage(this.db, this.ai.embedding, this.ai.chat, {
      engine: e.embedding,
      translationEngine: e.translation,
      batchSize,
      concurrency,
      retryAfterSeconds,
    });
    const naceEmbedding = await runNaceEmbeddingStage(this.db, this.tax, this.ai.embedding, {
      engine: e.embedding,
    });
    const groupingChat = e.grouping === 'deterministic' ? null : this.ai.chat;
    const grouping = await runGroupingStage(this.db, this.tax, groupingChat, {
      ...agent,
      engine: e.grouping,
    });
    const classifyChat = e.classification === 'deterministic' ? null : this.ai.chat;
    const classification = await runClassificationStage(this.db, this.tax, classifyChat, {
      ...agent,
      engine: e.classification,
    });
    const stats = { translation, embedding, naceEmbedding, grouping, classification };
    if (Object.values(stats).some((n) => n > 0)) {
      await this.db.refreshReadModels();
      await this.db.pipelineCycle.create({ data: { stats, startedAt } });
      this.log.log(`cycle ${JSON.stringify(stats)} in ${Date.now() - startedAt.getTime()} ms`);
    }
    return stats;
  }
}
