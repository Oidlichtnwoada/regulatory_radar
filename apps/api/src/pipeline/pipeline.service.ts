import { Inject, Injectable, Logger } from '@nestjs/common';
import { errorMessage, sleep } from '../common/fp.js';
import { databaseUrlFor, type Env } from '../config/env.js';
import { AgentSqlReader } from '../db/agent-reader.js';
import { PrismaService } from '../db/prisma.service.js';
import { type HeldLock, PIPELINE_LOCK_KEY, tryAdvisoryLock } from '../db/worker-lock.js';
import type { NaceTaxonomy } from '../domain/nace.js';
import { type AiProviders, engines } from '../llm/providers.js';
import { AI, ENV, TAXONOMY } from '../tokens.js';
import {
  type ClassificationOptions,
  type ClassificationPreview,
  previewClassification,
  runClassificationStage,
} from './classification.stage.js';
import { runEmbeddingStage } from './embedding.stage.js';
import { runGroupingStage } from './grouping.stage.js';
import { runNaceEmbeddingStage } from './nace-embedding.stage.js';
import { runTranslationStage } from './translation.stage.js';

/** Rows written per stage in one cycle; failed attempts are not counted (they are retried later). */
export type CycleStats = Readonly<
  Record<'translation' | 'embedding' | 'naceEmbedding' | 'grouping' | 'classification', number>
>;

/**
 * Orchestrates stages 2-4 continuously: translate -> embed -> group -> classify -> refresh read models.
 * Each stage reads its pending work from Postgres, so the worker is stateless and restart-safe.
 */
@Injectable()
export class PipelineService {
  /** Logger. */
  private readonly log = new Logger('Pipeline');

  /** Injects configuration, database, taxonomy, providers and the agents' SQL reader. */
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: PrismaService,
    @Inject(TAXONOMY) private readonly tax: NaceTaxonomy,
    @Inject(AI) private readonly ai: AiProviders,
    private readonly sql: AgentSqlReader,
  ) {}

  /** Options shared by the agent stages (without the engine id). */
  private agentOptions(signal?: AbortSignal): Omit<ClassificationOptions, 'engine'> {
    const e = engines(this.ai);
    return {
      retryAfterSeconds: this.env.PIPELINE_RETRY_SECONDS,
      embeddingEngine: e.embedding,
      embeddingDimensions: this.ai.embedding?.dimensions ?? 0,
      maxSteps: this.env.AGENT_MAX_STEPS,
      batchSize: this.env.PIPELINE_BATCH_SIZE,
      concurrency: this.env.LLM_CONCURRENCY,
      internet: this.env.AGENT_INTERNET_ACCESS,
      queryEmbeddings: this.ai.embedding?.embeddings ?? null,
      sqlReader: this.sql.query,
      ...(signal ? { signal } : {}),
    };
  }

  /** What the classification agent would store for the given groups now (nothing is stored; online mode only). */
  previewClassification(groupKeys: readonly string[]): Promise<readonly ClassificationPreview[]> {
    const e = engines(this.ai);
    if (!this.ai.chat || e.classification === 'deterministic')
      return Promise.reject(new Error('classification preview needs an LLM provider (online mode)'));
    return previewClassification(
      this.db,
      this.tax,
      this.ai.chat,
      {
        ...this.agentOptions(),
        engine: e.classification,
        runs: this.env.CLASSIFICATION_AGENT_RUNS,
      },
      groupKeys,
    );
  }

  /**
   * Runs cycles until aborted; a busy cycle is followed immediately by the next one. Stages count only
   * successful work, so failures (e.g. a provider outage) do not make a cycle busy. Only one process per database
   * runs the pipeline (advisory lock); another one waits until the lock is free.
   */
  async runForever(signal: AbortSignal): Promise<void> {
    this.log.log(`engines: ${JSON.stringify(engines(this.ai))}`);
    const interval = this.env.PIPELINE_INTERVAL_SECONDS * 1000;
    while (!signal.aborted) {
      const lock = await this.lock().catch((e: unknown) => {
        this.log.error(`cannot take the pipeline lock: ${errorMessage(e)}`);
        return null;
      });
      if (!lock) {
        await sleep(interval, signal);
        continue;
      }
      try {
        while (!signal.aborted) {
          const stats = await this.runCycle(signal).catch((e: unknown) => {
            this.log.error(`cycle failed: ${errorMessage(e)}`);
            return null;
          });
          const busy = stats && Object.values(stats).some((n) => n > 0);
          if (!busy) await sleep(interval, signal);
        }
      } finally {
        await lock.release();
      }
    }
  }

  /** Runs until a cycle writes nothing (used by tests and the eval command); fails if another worker runs. */
  async runUntilIdle(maxCycles = 500): Promise<void> {
    const lock = await this.lock();
    if (!lock) throw new Error('another process is running the pipeline on this database');
    try {
      for (let i = 0; i < maxCycles; i++) {
        const stats = await this.runCycle();
        if (Object.values(stats).every((n) => n === 0)) return;
      }
    } finally {
      await lock.release();
    }
  }

  /** The pipeline lock of this mode's database, or null (logged) when another process holds it. */
  private async lock(): Promise<HeldLock | null> {
    const lock = await tryAdvisoryLock(databaseUrlFor(this.env), PIPELINE_LOCK_KEY);
    if (!lock) this.log.warn('another process is running the pipeline on this database; waiting');
    return lock;
  }

  /**
   * One cycle over all stages; logs and stores what each stage did. A stage that throws is logged and counted as
   * no work, so later stages still run and whatever earlier stages wrote is published (read models refreshed).
   */
  async runCycle(signal?: AbortSignal): Promise<CycleStats> {
    const startedAt = new Date();
    const e = engines(this.ai);
    const agent = this.agentOptions(signal);
    const { batchSize, concurrency, retryAfterSeconds } = agent;
    const failed: string[] = [];
    const stage = (name: string, run: () => Promise<number>): Promise<number> =>
      signal?.aborted
        ? Promise.resolve(0)
        : run().catch((err: unknown) => {
            this.log.error(`${name} stage failed: ${errorMessage(err)}`);
            failed.push(name);
            return 0;
          });
    const translation = await stage('translation', () =>
      runTranslationStage(this.db, this.ai.chat, {
        engine: e.translation,
        batchSize,
        concurrency,
        retryAfterSeconds,
      }),
    );
    const embedding = await stage('embedding', () =>
      runEmbeddingStage(this.db, this.ai.embedding, this.ai.chat, {
        engine: e.embedding,
        translationEngine: e.translation,
        batchSize,
        concurrency,
        retryAfterSeconds,
      }),
    );
    const naceEmbedding = await stage('naceEmbedding', () =>
      runNaceEmbeddingStage(this.db, this.tax, this.ai.embedding, { engine: e.embedding }),
    );
    const groupingChat = e.grouping === 'deterministic' ? null : this.ai.chat;
    const grouping = await stage('grouping', () =>
      runGroupingStage(this.db, this.tax, groupingChat, { ...agent, engine: e.grouping }),
    );
    const classifyChat = e.classification === 'deterministic' ? null : this.ai.chat;
    const classification = await stage('classification', () =>
      runClassificationStage(this.db, this.tax, classifyChat, {
        ...agent,
        engine: e.classification,
        runs: this.env.CLASSIFICATION_AGENT_RUNS,
      }),
    );
    const stats = { translation, embedding, naceEmbedding, grouping, classification };
    if (Object.values(stats).some((n) => n > 0)) {
      await this.db.refreshReadModels();
      await this.db.pipelineCycle.create({ data: { stats, startedAt } });
      this.log.log(
        `cycle ${JSON.stringify(stats)} in ${Date.now() - startedAt.getTime()} ms${failed.length ? `; failed: ${failed.join(', ')}` : ''}`,
      );
    }
    return stats;
  }
}
