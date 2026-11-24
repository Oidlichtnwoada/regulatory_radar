import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/** The Prisma client (driver adapter for node-postgres) as an injectable Nest provider. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  /** Logger of the database layer. */
  private readonly log = new Logger('Database');

  /** Connects to DATABASE_URL; slow queries (>500 ms) are logged. */
  constructor(databaseUrl: string) {
    super({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'stdout', level: 'warn' },
        { emit: 'stdout', level: 'error' },
      ],
    });
    this.$on('query' as never, (e: { duration: number; query: string }) => {
      if (e.duration > 500) this.log.warn(`slow query ${e.duration} ms: ${e.query.slice(0, 300)}`);
    });
  }

  /** Refreshes the materialized read models (radar feed, current findings). */
  async refreshReadModels(): Promise<void> {
    await this.$executeRawUnsafe('SELECT refresh_read_models()');
  }

  /** Refreshes only the current-findings view (ingestion adds findings; groups and labels are the pipeline's). */
  async refreshFindings(): Promise<void> {
    await this.$executeRawUnsafe('SELECT refresh_findings()');
  }

  /** Closes the pool on shutdown. */
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
